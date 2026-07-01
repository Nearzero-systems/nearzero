DO $$ BEGIN
	CREATE TYPE "agentThreadStatus" AS ENUM ('idle', 'running', 'interrupted', 'error', 'completed');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"createdByUserId" text NOT NULL,
	"title" text,
	"status" "agentThreadStatus" DEFAULT 'idle' NOT NULL,
	"lastError" text,
	"continuationRevision" integer DEFAULT 0 NOT NULL,
	"parentThreadId" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_message" (
	"id" text PRIMARY KEY NOT NULL,
	"threadId" text NOT NULL,
	"role" text NOT NULL,
	"contentJson" jsonb NOT NULL,
	"sortKey" integer NOT NULL,
	"clientMessageId" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_stream_event" (
	"threadId" text NOT NULL,
	"seq" integer NOT NULL,
	"payloadJson" jsonb NOT NULL,
	"createdAt" text NOT NULL,
	CONSTRAINT "agent_stream_event_thread_seq_pk" PRIMARY KEY("threadId","seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_branch_root" (
	"id" text PRIMARY KEY NOT NULL,
	"sourceThreadId" text NOT NULL,
	"sourceMessageId" text NOT NULL,
	"createdThreadId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_thread_org_updated" ON "agent_thread" ("organizationId","updatedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_message_thread_sort" ON "agent_message" ("threadId","sortKey");
