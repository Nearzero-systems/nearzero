ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "setupStatus" text DEFAULT 'not_started' NOT NULL;
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "setupError" text;
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "setupStartedAt" text;
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "setupFinishedAt" text;
