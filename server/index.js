import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { sql } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;
const oauthStates = new Map();
const slackScopes = 'chat:write,im:write,im:history,users:read,channels:read,groups:read';

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer; } }));

function isValidSlackRequest(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!secret || !timestamp || !signature || !req.rawBody) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${req.rawBody.toString('utf8')}`;
  const expected = `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/db-test', async (_req, res) => {
  try {
    const result = await sql`SELECT NOW() AS now`;
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message,
      stack: err.stack,
    });
  }
});

app.get('/api/teams', async (_req, res) => {
  try {
    const teams = await sql`SELECT id, name, timezone FROM teams ORDER BY name ASC`;
    res.json(teams);
  } catch (error) {
    console.error('Failed to fetch teams', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

app.get('/api/dashboard', async (_req, res) => {
  try {
    const [standup] = await sql`
      SELECT standups.id, standups.name, standups.prompt_time AS "promptTime",
        standups.digest_time AS "digestTime", teams.name AS "teamName", teams.timezone
      FROM standups JOIN teams ON teams.id = standups.team_id
      WHERE standups.is_active = true ORDER BY standups.created_at DESC LIMIT 1
    `;
    if (!standup) return res.status(404).json({ error: 'No active standup found' });
    const members = await sql`
      SELECT users.id, users.name, users.timezone, team_members.prompt_time AS "promptTime"
      FROM team_members JOIN users ON users.id = team_members.user_id
      WHERE team_members.team_id = (SELECT team_id FROM standups WHERE id = ${standup.id})
        AND team_members.is_active = true ORDER BY users.name ASC
    `;
    const responses = await sql`
      SELECT user_id AS "userId", yesterday, today, blockers, mood, status
      FROM standup_responses WHERE standup_id = ${standup.id} AND response_date = CURRENT_DATE
    `;
    res.json({ standup, members, responses });
  } catch (error) {
    console.error('Failed to load dashboard', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

app.get('/api/slack/install', (_req, res) => {
  const { SLACK_CLIENT_ID, SLACK_REDIRECT_URI } = process.env;
  if (!SLACK_CLIENT_ID || !SLACK_REDIRECT_URI) {
    return res.status(500).json({ error: 'Slack OAuth environment variables are missing.' });
  }
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: slackScopes,
    redirect_uri: SLACK_REDIRECT_URI,
    state,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

app.get('/api/slack/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  if (error) return res.redirect(`${clientUrl}/?slack=error`);
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);
  if (!code || !expiresAt || expiresAt < Date.now()) return res.status(400).send('Invalid or expired Slack OAuth state.');

  try {
    const body = new URLSearchParams({
      code,
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      redirect_uri: process.env.SLACK_REDIRECT_URI,
    });
    const response = await fetch('https://slack.com/api/oauth.v2.access', { method: 'POST', body });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Slack token exchange failed');

    const [workspace] = await sql`
      INSERT INTO workspaces (name, slack_workspace_id)
      VALUES (${data.team.name}, ${data.team.id})
      ON CONFLICT (slack_workspace_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    await sql`
      INSERT INTO slack_installations (workspace_id, bot_token, bot_user_id, scopes, installed_by_slack_user_id)
      VALUES (${workspace.id}, ${data.access_token}, ${data.bot_user_id}, ${data.scope || ''}, ${data.authed_user?.id || null})
      ON CONFLICT (workspace_id) DO UPDATE SET
        bot_token = EXCLUDED.bot_token,
        bot_user_id = EXCLUDED.bot_user_id,
        scopes = EXCLUDED.scopes,
        installed_by_slack_user_id = EXCLUDED.installed_by_slack_user_id,
        installed_at = NOW()
    `;
    res.redirect(`${clientUrl}/?slack=connected`);
  } catch (error) {
    console.error('Slack OAuth failed', error.message);
    res.redirect(`${clientUrl}/?slack=error`);
  }
});

async function sendSlackMessage(token, channel, text) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text }),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Slack message failed');
}

async function standupContext(slackWorkspaceId, slackUserId) {

  console.log("standupContext started");

  try {

    console.log("Running Query 1...");

    const installation = await sql`
      SELECT
        workspaces.id AS "workspaceId",
        slack_installations.bot_token AS "botToken"
      FROM workspaces
      JOIN slack_installations
      ON slack_installations.workspace_id = workspaces.id
      WHERE workspaces.slack_workspace_id = ${slackWorkspaceId}
    `;

    console.log("Query 1 Result:");
    console.log(JSON.stringify(installation, null, 2));

    if (!installation || installation.length === 0) {
      console.log("No installation found");
      return null;
    }

    const [installationRow] = installation;
    const installationData = installationRow;

    let [team] = await sql`SELECT id FROM teams WHERE workspace_id = ${installationData.workspaceId} ORDER BY created_at LIMIT 1`;
    if (!team) [team] = await sql`INSERT INTO teams (workspace_id, name, timezone) VALUES (${installationData.workspaceId}, 'Daily team', 'Asia/Kolkata') RETURNING id`;
    let [standup] = await sql`SELECT id FROM standups WHERE team_id = ${team.id} AND is_active = true LIMIT 1`;
    if (!standup) [standup] = await sql`INSERT INTO standups (team_id, name, prompt_time, reminder_time, digest_time, working_days) VALUES (${team.id}, 'Daily standup', '10:00', '14:00', '17:30', ${JSON.stringify(['monday','tuesday','wednesday','thursday','friday'])}::jsonb) RETURNING id`;
    let [user] = await sql`SELECT id FROM users WHERE slack_user_id = ${slackUserId} LIMIT 1`;
    if (!user) [user] = await sql`INSERT INTO users (workspace_id, slack_user_id, name, timezone) VALUES (${installationData.workspaceId}, ${slackUserId}, 'Slack member', 'Asia/Kolkata') RETURNING id`;
    await sql`INSERT INTO team_members (team_id, user_id, is_active) VALUES (${team.id}, ${user.id}, true) ON CONFLICT (team_id, user_id) DO NOTHING`;
    return { token: installationData.botToken, standupId: standup.id, userId: user.id };
  } catch (err) {
    console.error("standupContext ERROR");
    console.error(err);
    throw err;
  }
}

async function handleSlackMessage(event, slackWorkspaceId) {
  console.log("========== HANDLE SLACK MESSAGE ==========");
  console.log("Workspace ID:", slackWorkspaceId);
  console.log("Event:");
  console.log(JSON.stringify(event, null, 2));

  if (event.bot_id || event.subtype || event.channel_type !== 'im') {
    console.log("Ignored event");
    return;
  }

  console.log("Passed event checks");

  const context = await standupContext(slackWorkspaceId, event.user);

  console.log("Context:");
  console.log(context);

  if (!context) {
    console.log("Context is NULL");
    return;
  }

  console.log("Looking for today's response...");

  const [response] = await sql`SELECT id, yesterday, today, blockers FROM standup_responses WHERE standup_id = ${context.standupId} AND user_id = ${context.userId} AND response_date = CURRENT_DATE AND status = 'in_progress' LIMIT 1`;
  const text = event.text.trim();
  if (!response) {
    if (text.toLowerCase() !== 'standup') return sendSlackMessage(context.token, event.channel, 'Reply *standup* to begin your daily update.');
    await sql`INSERT INTO standup_responses (standup_id, user_id, response_date, status) VALUES (${context.standupId}, ${context.userId}, CURRENT_DATE, 'in_progress') ON CONFLICT (standup_id, user_id, response_date) DO UPDATE SET status = 'in_progress'`;
    return sendSlackMessage(context.token, event.channel, '1/3 What did you do yesterday?');
  }
  if (!response.yesterday) {
    await sql`UPDATE standup_responses SET yesterday = ${text} WHERE id = ${response.id}`;
    return sendSlackMessage(context.token, event.channel, '2/3 What are you doing today?');
  }
  if (!response.today) {
    await sql`UPDATE standup_responses SET today = ${text} WHERE id = ${response.id}`;
    return sendSlackMessage(context.token, event.channel, '3/3 Any blockers? Reply None if you have no blockers.');
  }
  await sql`UPDATE standup_responses SET blockers = ${text}, status = 'completed', submitted_at = NOW() WHERE id = ${response.id}`;
  return sendSlackMessage(context.token, event.channel, 'Done. Your standup update is saved.');
}

app.post('/api/slack/events', async (req, res) => {
  console.log("========== NEW SLACK REQUEST ==========");
  console.log("Body:");
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }

  if (!isValidSlackRequest(req)) {
    console.log("Invalid Slack signature");
    return res.status(401).send("Invalid Slack signature");
  }

  console.log("Signature verified");

  res.status(200).send();

  if (req.body.type === "event_callback") {
    try {
      await handleSlackMessage(req.body.event, req.body.team_id);
    } catch (err) {
      console.error("========== HANDLE ERROR ==========");
      console.error(err);
    }
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Backend API running on http://localhost:${PORT}`);
  });
}

export default app;
