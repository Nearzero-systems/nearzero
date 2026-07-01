ALTER TABLE "organization_settings"
	ADD COLUMN IF NOT EXISTS "allowAgentOpenRouterSetup" boolean DEFAULT true NOT NULL,
	ADD COLUMN IF NOT EXISTS "allowAgentProjectCreation" boolean DEFAULT true NOT NULL,
	ADD COLUMN IF NOT EXISTS "allowAgentProjectUpdates" boolean DEFAULT true NOT NULL,
	ADD COLUMN IF NOT EXISTS "allowAgentServiceCreation" boolean DEFAULT true NOT NULL,
	ADD COLUMN IF NOT EXISTS "allowAgentSshServiceSetup" boolean DEFAULT false NOT NULL,
	ADD COLUMN IF NOT EXISTS "allowAgentServerCreation" boolean DEFAULT false NOT NULL,
	ADD COLUMN IF NOT EXISTS "allowAgentDeployments" boolean DEFAULT false NOT NULL;
