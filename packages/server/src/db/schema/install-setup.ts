import { relations } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

export const INSTALL_SETUP_PHASES = [
	"pending",
	"configured",
	"claimed",
] as const;

export type InstallSetupPhase = (typeof INSTALL_SETUP_PHASES)[number];

/**
 * Singleton row describing the first-run state of a self-hosted install.
 * The owner account is created on the server (`nearzero create-owner`), so the
 * row only records when ownership was claimed. The zone columns are kept so
 * installs set up with the retired browser wizard keep their DNS settings.
 */
export const installSetup = pgTable("install_setup", {
	id: text("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	phase: text("phase").$type<InstallSetupPhase>().notNull().default("pending"),
	adminEmail: text("adminEmail"),
	managedDnsZone: text("managedDnsZone"),
	managedDnsSoaEmail: text("managedDnsSoaEmail"),
	managementHostname: text("managementHostname"),
	publicIp: text("publicIp"),
	configuredAt: timestamp("configured_at"),
	claimedAt: timestamp("claimed_at"),
	/** True when the operator skipped optional managed-DNS zone configuration. */
	managedDnsSkipped: boolean("managedDnsSkipped").notNull().default(false),
	createdAt: timestamp("created_at").defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const installSetupRelations = relations(installSetup, () => ({}));
