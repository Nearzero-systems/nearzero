CREATE TABLE IF NOT EXISTS "install_setup" (
	"id" text PRIMARY KEY NOT NULL,
	"phase" text DEFAULT 'pending' NOT NULL,
	"adminEmail" text,
	"managedDnsZone" text,
	"managedDnsSoaEmail" text,
	"managementHostname" text,
	"publicIp" text,
	"configured_at" timestamp,
	"claimed_at" timestamp,
	"managedDnsSkipped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
