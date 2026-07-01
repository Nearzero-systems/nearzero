DO $$ BEGIN
	CREATE TYPE "public"."dnsZoneStatus" AS ENUM('pending', 'active', 'error', 'disabled');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."dnsZoneMode" AS ENUM('nearzero_authoritative');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."dnsRecordType" AS ENUM('A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'NS');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."dnsManagedBy" AS ENUM('user', 'service-domain', 'preview-domain', 'system');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_zone" (
	"dnsZoneId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"status" "dnsZoneStatus" DEFAULT 'pending' NOT NULL,
	"mode" "dnsZoneMode" DEFAULT 'nearzero_authoritative' NOT NULL,
	"soaEmail" text NOT NULL,
	"ttl" integer DEFAULT 300 NOT NULL,
	"nameservers" text[] DEFAULT '{}' NOT NULL,
	"lastPublishedAt" text,
	"lastError" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_record" (
	"dnsRecordId" text PRIMARY KEY NOT NULL,
	"dnsZoneId" text NOT NULL,
	"name" text NOT NULL,
	"type" "dnsRecordType" NOT NULL,
	"value" text NOT NULL,
	"ttl" integer,
	"priority" integer,
	"managedBy" "dnsManagedBy" DEFAULT 'user' NOT NULL,
	"domainId" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dns_zone_organizationId_name_idx" ON "dns_zone" USING btree ("organizationId","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dns_record_zone_name_type_value_idx" ON "dns_record" USING btree ("dnsZoneId","name","type","value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_record_dnsZoneId_idx" ON "dns_record" USING btree ("dnsZoneId");
--> statement-breakpoint
ALTER TABLE "dns_zone" ADD CONSTRAINT "dns_zone_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dns_record" ADD CONSTRAINT "dns_record_dnsZoneId_dns_zone_dnsZoneId_fk" FOREIGN KEY ("dnsZoneId") REFERENCES "public"."dns_zone"("dnsZoneId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dns_record" ADD CONSTRAINT "dns_record_domainId_domain_domainId_fk" FOREIGN KEY ("domainId") REFERENCES "public"."domain"("domainId") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dnsZoneId" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dnsRecordId" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "managedByNearzero" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN IF NOT EXISTS "dnsZoneId" text;
--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN IF NOT EXISTS "domainPrefix" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_dnsZoneId_dns_zone_dnsZoneId_fk" FOREIGN KEY ("dnsZoneId") REFERENCES "public"."dns_zone"("dnsZoneId") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_dnsRecordId_dns_record_dnsRecordId_fk" FOREIGN KEY ("dnsRecordId") REFERENCES "public"."dns_record"("dnsRecordId") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_dnsZoneId_dns_zone_dnsZoneId_fk" FOREIGN KEY ("dnsZoneId") REFERENCES "public"."dns_zone"("dnsZoneId") ON DELETE set null ON UPDATE no action;
