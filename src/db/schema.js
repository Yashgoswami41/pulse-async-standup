import {
  boolean,
  date,
  jsonb,
  pgTable,
  uniqueIndex,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slackWorkspaceId: text('slack_workspace_id').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .references(() => workspaces.id, { onDelete: 'cascade' })
    .notNull(),
  slackUserId: text('slack_user_id').notNull().unique(),
  name: text('name').notNull(),
  email: text('email'),
  timezone: text('timezone'),
  avatarUrl: text('avatar_url'),
  isAdmin: boolean('is_admin').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .references(() => workspaces.id, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  timezone: text('timezone'),
  digestChannelId: text('digest_channel_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .references(() => teams.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    promptTime: time('prompt_time'),
  },
  (table) => ({
    teamUserUnique: uniqueIndex('team_members_team_user_unique').on(
      table.teamId,
      table.userId,
    ),
  }),
);

export const standups = pgTable('standups', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  promptTime: time('prompt_time'),
  reminderTime: time('reminder_time'),
  digestTime: time('digest_time'),
  digestChannelId: text('digest_channel_id'),
  workingDays: jsonb('working_days').default([]).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const standupResponses = pgTable(
  'standup_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    standupId: uuid('standup_id')
      .references(() => standups.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    responseDate: date('response_date').notNull(),
    yesterday: text('yesterday'),
    today: text('today'),
    blockers: text('blockers'),
    mood: text('mood'),
    status: varchar('status', { length: 20 }).default('pending').notNull(),
    submittedAt: timestamp('submitted_at'),
  },
  (table) => ({
    standupUserDayUnique: uniqueIndex('standup_response_one_per_day').on(
      table.standupId,
      table.userId,
      table.responseDate,
    ),
  }),
);

export const dailyDigests = pgTable(
  'daily_digests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    standupId: uuid('standup_id')
      .references(() => standups.id, { onDelete: 'cascade' })
      .notNull(),
    digestDate: date('digest_date').notNull(),
    content: jsonb('content').default({}).notNull(),
    slackMessageTs: text('slack_message_ts'),
    status: varchar('status', { length: 20 }).default('pending').notNull(),
    postedAt: timestamp('posted_at'),
  },
  (table) => ({
    standupDigestDayUnique: uniqueIndex('daily_digest_one_per_day').on(
      table.standupId,
      table.digestDate,
    ),
  }),
);

export const schema = {
  workspaces,
  users,
  teams,
  teamMembers,
  standups,
  standupResponses,
  dailyDigests,
};
