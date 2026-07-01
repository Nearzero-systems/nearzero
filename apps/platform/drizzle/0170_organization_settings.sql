CREATE TABLE IF NOT EXISTS "organization_settings" (
	"organizationId" text PRIMARY KEY NOT NULL,
	"allowAgentProductionActions" boolean DEFAULT false NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
