CREATE TYPE "public"."buildExecutionTarget" AS ENUM('deploy_server', 'nearzero_host');--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "buildExecutionTarget" "buildExecutionTarget" DEFAULT 'deploy_server' NOT NULL;--> statement-breakpoint
UPDATE "server" SET "serverType" = 'deploy' WHERE "serverType" = 'build';--> statement-breakpoint
UPDATE "application" SET "serverId" = COALESCE("serverId", "buildServerId") WHERE "buildServerId" IS NOT NULL;--> statement-breakpoint
UPDATE "application" SET "registryId" = COALESCE("registryId", "buildRegistryId") WHERE "buildRegistryId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "application" DROP CONSTRAINT IF EXISTS "application_buildServerId_server_serverId_fk";--> statement-breakpoint
ALTER TABLE "application" DROP CONSTRAINT IF EXISTS "application_buildRegistryId_registry_registryId_fk";--> statement-breakpoint
ALTER TABLE "deployment" DROP CONSTRAINT IF EXISTS "deployment_buildServerId_server_serverId_fk";--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "buildServerId";--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "buildRegistryId";--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "buildServerId";--> statement-breakpoint
ALTER TABLE "server" DROP COLUMN IF EXISTS "serverType";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."serverType";
