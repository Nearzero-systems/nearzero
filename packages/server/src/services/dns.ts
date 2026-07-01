import { mkdirSync } from "node:fs";
import path from "node:path";
import { db } from "@nearzero/server/db";
import {
	type apiCreateDnsZone,
	type apiUpsertDnsRecord,
	dnsRecords,
	dnsZones,
} from "@nearzero/server/db/schema";
import { paths } from "@nearzero/server/constants";
import {
	renderZoneFile,
	writeZoneFileAtomic,
} from "@nearzero/server/utils/dns/zone-file";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import {
	MANAGED_DNS_SETUP_ERROR_CODE,
	ManagedDnsSetupError,
	reloadNearzeroDns,
} from "../setup/dns-setup";

function toDnsPublishMessage(error: unknown) {
	const raw = error instanceof Error ? error.message : String(error);
	if (
		error instanceof ManagedDnsSetupError ||
		/coredns|no such image|no such container|docker/i.test(raw)
	) {
		return `Managed DNS is not ready. Complete server/DNS setup first. Code: ${MANAGED_DNS_SETUP_ERROR_CODE}`;
	}
	return raw || "Publish failed";
}

function normalizeZoneName(name: string) {
	return name.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeRecordName(name: string, zoneName: string) {
	const raw = name.trim().toLowerCase();
	if (!raw || raw === "@") return "@";
	const hasTrailingDot = raw.endsWith(".");
	const trimmed = raw.replace(/\.$/, "");
	const zone = normalizeZoneName(zoneName);
	if (trimmed === zone) return "@";
	if (trimmed.endsWith(`.${zone}`)) {
		return trimmed.slice(0, -(zone.length + 1)) || "@";
	}
	if (hasTrailingDot) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Record name ${raw} is not inside DNS zone ${zone}`,
		});
	}
	return trimmed;
}

function normalizeNameservers(nameservers?: string[]) {
	return Array.from(
		new Set(
			(nameservers ?? [])
				.map((ns) => normalizeZoneName(ns))
				.filter(Boolean),
		),
	);
}

export async function createDnsZone(
	organizationId: string,
	input: z.infer<typeof apiCreateDnsZone>,
) {
	const name = normalizeZoneName(input.name);
	const existing = await db.query.dnsZones.findFirst({
		where: and(
			eq(dnsZones.organizationId, organizationId),
			eq(dnsZones.name, name),
		),
	});
	if (existing) return existing;

	const [zone] = await db
		.insert(dnsZones)
		.values({
			organizationId,
			name,
			soaEmail: input.soaEmail,
			ttl: input.ttl ?? 300,
			nameservers: normalizeNameservers(input.nameservers),
			status: "pending",
		})
		.returning();

	if (!zone) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Failed to create DNS zone",
		});
	}

	mkdirSync(paths().DNS_ZONES_PATH, { recursive: true });
	return zone;
}

export async function listDnsZones(organizationId: string) {
	return db.query.dnsZones.findMany({
		where: eq(dnsZones.organizationId, organizationId),
		with: { records: true },
		orderBy: [asc(dnsZones.name)],
	});
}

export async function findDnsZoneById(dnsZoneId: string, organizationId: string) {
	const zone = await db.query.dnsZones.findFirst({
		where: and(
			eq(dnsZones.dnsZoneId, dnsZoneId),
			eq(dnsZones.organizationId, organizationId),
		),
		with: { records: true },
	});
	if (!zone) {
		throw new TRPCError({ code: "NOT_FOUND", message: "DNS zone not found" });
	}
	return zone;
}

export async function deleteDnsZone(dnsZoneId: string, organizationId: string) {
	const zone = await findDnsZoneById(dnsZoneId, organizationId);
	const managed = zone.records.filter((r) => r.managedBy !== "user");
	if (managed.length > 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Remove managed service/preview records before deleting this zone",
		});
	}
	await db.delete(dnsZones).where(eq(dnsZones.dnsZoneId, dnsZoneId));
	return zone;
}

export async function listDnsRecords(dnsZoneId: string, organizationId: string) {
	await findDnsZoneById(dnsZoneId, organizationId);
	return db.query.dnsRecords.findMany({
		where: eq(dnsRecords.dnsZoneId, dnsZoneId),
	});
}

export async function upsertDnsRecord(
	organizationId: string,
	input: z.infer<typeof apiUpsertDnsRecord>,
) {
	const zone = await findDnsZoneById(input.dnsZoneId, organizationId);
	const name = normalizeRecordName(input.name, zone.name);
	const type = input.type;
	const value = input.value.trim();

	const existing = await db.query.dnsRecords.findFirst({
		where: and(
			eq(dnsRecords.dnsZoneId, zone.dnsZoneId),
			eq(dnsRecords.name, name),
			eq(dnsRecords.type, type),
			eq(dnsRecords.value, value),
		),
	});

	if (existing) {
		const [updated] = await db
			.update(dnsRecords)
			.set({
				ttl: input.ttl ?? existing.ttl,
				priority: input.priority ?? existing.priority,
				managedBy: input.managedBy ?? existing.managedBy,
				domainId: input.domainId ?? existing.domainId,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(dnsRecords.dnsRecordId, existing.dnsRecordId))
			.returning();
		if (!updated) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Failed to update DNS record",
			});
		}
		return updated;
	}

	const [created] = await db
		.insert(dnsRecords)
		.values({
			dnsZoneId: zone.dnsZoneId,
			name,
			type,
			value,
			ttl: input.ttl,
			priority: input.priority,
			managedBy: input.managedBy ?? "user",
			domainId: input.domainId,
		})
		.returning();

	if (!created) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Failed to create DNS record",
		});
	}
	return created;
}

export async function deleteDnsRecord(
	dnsRecordId: string,
	organizationId: string,
) {
	const record = await db.query.dnsRecords.findFirst({
		where: eq(dnsRecords.dnsRecordId, dnsRecordId),
		with: { zone: true },
	});
	if (!record?.zone || record.zone.organizationId !== organizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "DNS record not found" });
	}
	await db.delete(dnsRecords).where(eq(dnsRecords.dnsRecordId, dnsRecordId));
	return record;
}

export async function publishDnsZone(dnsZoneId: string, organizationId: string) {
	const zone = await findDnsZoneById(dnsZoneId, organizationId);
	const zonePath = path.join(paths().DNS_ZONES_PATH, `${zone.name}.zone`);
	const serial = new Date(zone.updatedAt).toISOString().replace(/\D/g, "").slice(0, 10);

	try {
		const contents = renderZoneFile({
			zoneName: zone.name,
			soaEmail: zone.soaEmail,
			defaultTtl: zone.ttl,
			nameservers: zone.nameservers,
			serial,
			records: zone.records.map((r) => ({
				name: r.name,
				type: r.type,
				value: r.value,
				ttl: r.ttl,
				priority: r.priority,
			})),
		});
		writeZoneFileAtomic(zonePath, contents);
		await reloadNearzeroDns();

		const [updated] = await db
			.update(dnsZones)
			.set({
				status: "active",
				lastPublishedAt: new Date().toISOString(),
				lastError: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(dnsZones.dnsZoneId, dnsZoneId))
			.returning();

		if (!updated) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Failed to publish DNS zone",
			});
		}
		return updated;
	} catch (error) {
		const message = toDnsPublishMessage(error);
		await db
			.update(dnsZones)
			.set({
				status: "error",
				lastError: message,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(dnsZones.dnsZoneId, dnsZoneId));
		throw new TRPCError({ code: "BAD_REQUEST", message });
	}
}

export async function publishAllDnsZones(organizationId: string) {
	const zones = await listDnsZones(organizationId);
	for (const zone of zones) {
		await publishDnsZone(zone.dnsZoneId, organizationId);
	}
	return zones.length;
}

export function getDnsZoneInstructions(zone: typeof dnsZones.$inferSelect) {
	const ns =
		zone.nameservers.length > 0
			? zone.nameservers
			: [`ns1.${zone.name}`, `ns2.${zone.name}`];
	return {
		zone: zone.name,
		nameservers: ns,
		message: `Delegate ${zone.name} to these nameservers at your registrar, then publish the zone in Nearzero.`,
	};
}

export async function checkDnsHealth(organizationId: string) {
	const zones = await listDnsZones(organizationId);
	return zones.map((zone) => ({
		dnsZoneId: zone.dnsZoneId,
		name: zone.name,
		status: zone.status,
		lastPublishedAt: zone.lastPublishedAt,
		lastError: zone.lastError,
		recordCount: zone.records.length,
	}));
}

export async function deleteManagedDnsRecordForDomain(domainId: string) {
	const record = await db.query.dnsRecords.findFirst({
		where: eq(dnsRecords.domainId, domainId),
	});
	if (!record) return;
	await db.delete(dnsRecords).where(eq(dnsRecords.dnsRecordId, record.dnsRecordId));
	if (record.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, record.dnsZoneId),
		});
		if (zone) {
			await publishDnsZone(zone.dnsZoneId, zone.organizationId);
		}
	}
}
