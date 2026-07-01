ALTER TABLE "organization_settings"
	ADD COLUMN IF NOT EXISTS "allowAgentDomainAssignment" boolean DEFAULT true NOT NULL;
