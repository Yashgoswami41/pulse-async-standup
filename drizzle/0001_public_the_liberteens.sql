CREATE TABLE "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_token" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"scopes" text NOT NULL,
	"installed_by_slack_user_id" text,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_installations_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;