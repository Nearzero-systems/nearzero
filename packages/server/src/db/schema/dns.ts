import { relations } from "drizzle-orm";
import {
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
export const dnsZoneStatus = pgEnum("dnsZoneStatus", [
	"pending",
	"active",
	"error",
	"disabled",
]);

export const dnsZoneMode = pgEnum("dnsZoneMode", ["nearzero_authoritative"]);

export const dnsRecordType = pgEnum("dnsRecordType", [
	"A",
	"AAAA",
	"CNAME",
	"TXT",
	"MX",
	"CAA",
	"NS",
]);

export const dnsManagedBy = pgEnum("dnsManagedBy", [
	"user",
	"service-domain",
	"preview-domain",
	"system",
]);

export const dnsZones = pgTable(
	"dns_zone",
	{
		dnsZoneId: text("dnsZoneId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId").notNull(),
		name: text("name").notNull(),
		status: dnsZoneStatus("status").notNull().default("pending"),
		mode: dnsZoneMode("mode").notNull().default("nearzero_authoritative"),
		soaEmail: text("soaEmail").notNull(),
		ttl: integer("ttl").notNull().default(300),
		nameservers: text("nameservers")
			.array()
			.notNull()
			.default([]),
		lastPublishedAt: text("lastPublishedAt"),
		lastError: text("lastError"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(t) => ({
		orgNameIdx: uniqueIndex("dns_zone_organizationId_name_idx").on(
			t.organizationId,
			t.name,
		),
	}),
);

export const dnsRecords = pgTable(
	"dns_record",
	{
		dnsRecordId: text("dnsRecordId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		dnsZoneId: text("dnsZoneId")
			.notNull()
			.references(() => dnsZones.dnsZoneId, { onDelete: "cascade" }),
		name: text("name").notNull(),
		type: dnsRecordType("type").notNull(),
		value: text("value").notNull(),
		ttl: integer("ttl"),
		priority: integer("priority"),
		managedBy: dnsManagedBy("managedBy").notNull().default("user"),
		domainId: text("domainId"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(t) => ({
		zoneRecordIdx: uniqueIndex("dns_record_zone_name_type_value_idx").on(
			t.dnsZoneId,
			t.name,
			t.type,
			t.value,
		),
		zoneIdx: index("dns_record_dnsZoneId_idx").on(t.dnsZoneId),
	}),
);

export const dnsZonesRelations = relations(dnsZones, ({ many }) => ({
	records: many(dnsRecords),
}));

export const dnsRecordsRelations = relations(dnsRecords, ({ one }) => ({
	zone: one(dnsZones, {
		fields: [dnsRecords.dnsZoneId],
		references: [dnsZones.dnsZoneId],
	}),
}));

export const apiCreateDnsZone = z.object({
	name: z.string().min(1),
	soaEmail: z.string().email(),
	ttl: z.number().int().positive().optional(),
	nameservers: z.array(z.string()).optional(),
});

export const apiUpsertDnsRecord = z.object({
	dnsZoneId: z.string().min(1),
	name: z.string().min(1),
	type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "NS"]),
	value: z.string().min(1),
	ttl: z.number().int().positive().optional(),
	priority: z.number().int().optional(),
	managedBy: z
		.enum(["user", "service-domain", "preview-domain", "system"])
		.optional(),
	domainId: z.string().optional(),
});
