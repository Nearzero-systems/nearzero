ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "organizationId" text REFERENCES "organization"("id") ON DELETE CASCADE;
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dnsMode" text NOT NULL DEFAULT 'external';

-- Backfill organizationId from application → environment → project
UPDATE "domain" d
SET "organizationId" = p."organizationId"
FROM "application" a
INNER JOIN "environment" e ON a."environmentId" = e."environmentId"
INNER JOIN "project" p ON e."projectId" = p."projectId"
WHERE d."applicationId" = a."applicationId"
  AND d."organizationId" IS NULL;

-- Backfill from compose → environment → project
UPDATE "domain" d
SET "organizationId" = p."organizationId"
FROM "compose" c
INNER JOIN "environment" e ON c."environmentId" = e."environmentId"
INNER JOIN "project" p ON e."projectId" = p."projectId"
WHERE d."composeId" = c."composeId"
  AND d."organizationId" IS NULL;

-- Classify dnsMode from existing flags
UPDATE "domain"
SET "dnsMode" = 'nearzero_managed'
WHERE "managedByNearzero" = true AND "dnsZoneId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "domain_organizationId_idx" ON "domain" ("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "domain_org_host_unique" ON "domain" ("organizationId", "host") WHERE "organizationId" IS NOT NULL;
