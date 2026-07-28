import express from 'express';
import cors from 'cors';
import { sql } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`Backend API running on http://localhost:${PORT}`);
});
