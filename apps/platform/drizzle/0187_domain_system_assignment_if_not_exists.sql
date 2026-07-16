ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "isSystemAssigned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "domain"
SET "isSystemAssigned" = true
WHERE "isSystemAssigned" = false
	AND (
		"dnsMode" = 'platform'
		OR ("dnsMode" = 'external' AND lower("host") LIKE '%.sslip.io')
	);
