ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "openRouterApiKeyCiphertext" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "openRouterApiKeyConfiguredAt" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "openRouterApiKeyConfiguredByUserId" text;
