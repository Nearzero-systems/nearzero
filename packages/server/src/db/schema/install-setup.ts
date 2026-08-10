import { relations } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";

export const INSTALL_SETUP_PHASES = [
	"pending",
	"configured",
	"claimed",
] as const;

export type InstallSetupPhase = (typeof INSTALL_SETUP_PHASES)[number];

/**
 * Singleton row for the Community first-run domain wizard.
 * The one-time setup token is never stored here — only its env hash is checked.
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

const createSchema = createInsertSchema(installSetup, {
	id: z.string().min(1),
	phase: z.enum(INSTALL_SETUP_PHASES),
});

export const apiInstallSetupSubmit = z.object({
	token: z.string().min(16).max(256),
	managementHostname: z
		.string()
		.trim()
		.toLowerCase()
		.min(4)
		.max(253)
		.refine(
			(value) =>
				/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
					value,
				),
			"Enter a valid public hostname, for example nearzero.example.com",
		),
	adminEmail: z.string().trim().email(),
	publicIp: z
		.string()
		.trim()
		.regex(/^(?:\d{1,3}\.){3}\d{1,3}$/, "Enter a valid IPv4 address")
		.optional(),
	managedDnsZone: z
		.string()
		.trim()
		.toLowerCase()
		.min(4)
		.max(253)
		.optional()
		.nullable(),
	managedDnsSoaEmail: z.string().trim().email().optional().nullable(),
	skipManagedDns: z.boolean().optional(),
});

export type ApiInstallSetupSubmit = z.infer<typeof apiInstallSetupSubmit>;

export const apiInstallSetupInsert = createSchema.partial();
