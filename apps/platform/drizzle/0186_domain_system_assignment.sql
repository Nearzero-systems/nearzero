ALTER TABLE "domain" ADD COLUMN "isSystemAssigned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "domain"
SET "isSystemAssigned" = true
WHERE "dnsMode" = 'platform'
	OR ("dnsMode" = 'external' AND lower("host") LIKE '%.sslip.io');
