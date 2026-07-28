import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { sql } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;
const oauthStates = new Map();
const slackScopes = 'chat:write,im:write,im:history,users:read,channels:read,groups:read';

app.use(cors({ origin: 'http://localhost:5173' }));
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
      WHERE standups.is_active = true ORDER BY standups.created_at ASC LIMIT 1
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

app.post('/api/slack/events', (req, res) => {
  if (!isValidSlackRequest(req)) return res.status(401).send('Invalid Slack signature');
  if (req.body.type === 'url_verification') return res.status(200).send(req.body.challenge);
  res.status(200).send();
});

app.listen(PORT, () => {
  console.log(`Backend API running on http://localhost:${PORT}`);
});
