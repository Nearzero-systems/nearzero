ALTER TABLE "deployment" ADD COLUMN "buildServerId" text;
ALTER TABLE "deployment" ADD COLUMN "executionMode" text;
ALTER TABLE "deployment" ADD COLUMN "buildLocation" text;
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_buildServerId_server_serverId_fk" FOREIGN KEY ("buildServerId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;
