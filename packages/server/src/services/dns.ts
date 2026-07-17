import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import {
	type apiCreateDnsZone,
	type apiUpsertDnsRecord,
	dnsRecords,
	dnsZones,
	domains,
} from "@nearzero/server/db/schema";
import {
	getDefaultManagedNameservers,
	resolveDefaultManagedNameservers,
} from "@nearzero/server/utils/dns/default-nameservers";
import {
	createSoaSerial,
	normalizeDnsNameserver,
	normalizeDnsRecordName,
	normalizeDnsRecordValue,
	normalizeDnsZoneName,
	normalizeZoneRecord,
	renderZoneFile,
	writeZoneFileAtomic,
	type ZoneRecord,
} from "@nearzero/server/utils/dns/zone-file";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { rethrowUnlessSchemaDrift } from "./db-schema-error";
import {
	MANAGED_DNS_SETUP_ERROR_CODE,
	ManagedDnsSetupError,
	reloadNearzeroDns,
} from "../setup/dns-setup";
import { resolveDomainTargetIp } from "./domain-target";
import { resolvePlatformDefaultDomain } from "./managed-domain";

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

function badDnsInput(error: unknown): never {
	if (error instanceof TRPCError) throw error;
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : "Invalid DNS input",
		cause: error,
	});
}

function normalizeRecordName(name: string, zoneName: string) {
	try {
		return normalizeDnsRecordName(name, zoneName);
	} catch (error) {
		return badDnsInput(error);
	}
}

function normalizeNameservers(
	nameservers: string[] | undefined,
	zoneName: string,
) {
	try {
		return Array.from(
			new Set(
				(nameservers ?? []).map((ns) => normalizeDnsNameserver(ns, zoneName)),
			),
		);
	} catch (error) {
		return badDnsInput(error);
	}
}

function zoneFilePath(zoneName: string) {
	let normalized: string;
	try {
		normalized = normalizeDnsZoneName(zoneName);
	} catch (error) {
		return badDnsInput(error);
	}
	const root = path.resolve(paths().DNS_ZONES_PATH);
	const file = path.resolve(root, `${normalized}.zone`);
	if (path.dirname(file) !== root) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "DNS zone path is outside the managed zone directory",
		});
	}
	return file;
}

const DNS_PUBLISH_LOCK_TIMEOUT_MS = 30_000;
const DNS_PUBLISH_LOCK_STALE_MS = 120_000;

async function withDnsZonePublishLock<T>(
	zoneName: string,
	operation: () => Promise<T>,
): Promise<T> {
	const normalizedZone = normalizeDnsZoneName(zoneName);
	const lockDirectory = path.resolve(paths().DNS_PATH, ".publish-locks");
	mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
	chmodSync(lockDirectory, 0o700);
	const lockPath = path.join(lockDirectory, `${normalizedZone}.lock`);
	const deadline = Date.now() + DNS_PUBLISH_LOCK_TIMEOUT_MS;
	let descriptor: number | null = null;

	while (descriptor === null) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			const stale =
				existsSync(lockPath) &&
				Date.now() - statSync(lockPath).mtimeMs > DNS_PUBLISH_LOCK_STALE_MS;
			if (stale) {
				try {
					unlinkSync(lockPath);
					continue;
				} catch {
					// Another publisher recovered the stale lock first.
				}
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`DNS zone ${normalizedZone} is already being published; retry the operation`,
					{ cause: error },
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	const heartbeat = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(lockPath, now, now);
		} catch {
			// The owning publish will still fail or release its lock normally.
		}
	}, 30_000);
	heartbeat.unref?.();
	try {
		writeFileSync(descriptor, `${process.pid}\n`, "utf8");
		return await operation();
	} finally {
		clearInterval(heartbeat);
		closeSync(descriptor);
		try {
			unlinkSync(lockPath);
		} catch {
			// The publish already completed; a missing lock needs no recovery.
		}
	}
}

function publishedZoneSerial(zonePath: string) {
	if (!existsSync(zonePath)) return null;
	try {
		const match = readFileSync(zonePath, "utf8").match(
			/^\s*(\d+)\s*;\s*serial\s*$/m,
		);
		if (!match?.[1]) return null;
		const serial = Number(match[1]);
		return Number.isInteger(serial) && serial >= 0 && serial < 2 ** 32
			? serial
			: null;
	} catch {
		return null;
	}
}

function isNameInsideZone(name: string, zoneName: string) {
	return name === zoneName || name.endsWith(`.${zoneName}`);
}

async function recordsWithNameserverGlue(
	zone: typeof dnsZones.$inferSelect & {
		records: Array<typeof dnsRecords.$inferSelect>;
	},
): Promise<ZoneRecord[]> {
	const zoneName = normalizeDnsZoneName(zone.name);
	const nameservers = normalizeNameservers(zone.nameservers, zoneName);
	const effectiveNameservers =
		nameservers.length > 0
			? nameservers
			: getDefaultManagedNameservers(zoneName);
	const records = zone.records.map((record) =>
		normalizeZoneRecord(
			{
				name: record.name,
				type: record.type,
				value: record.value,
				ttl: record.ttl,
				priority: record.priority,
			},
			zoneName,
		),
	);

	let authoritativeIp: string | null = null;
	for (const nameserver of effectiveNameservers) {
		if (!isNameInsideZone(nameserver, zoneName)) continue;
		const owner = normalizeDnsRecordName(nameserver, zoneName);
		const hasAddress = records.some(
			(record) =>
				record.name === owner &&
				(record.type === "A" || record.type === "AAAA"),
		);
		if (hasAddress) continue;
		authoritativeIp ??= await resolveDomainTargetIp();
		records.push({
			name: owner,
			type: "A",
			value: authoritativeIp,
			ttl: zone.ttl,
		});
	}
	return records;
}

export async function createDnsZone(
	organizationId: string,
	input: z.infer<typeof apiCreateDnsZone>,
) {
	let name: string;
	try {
		name = normalizeDnsZoneName(input.name);
	} catch (error) {
		return badDnsInput(error);
	}
	const existing = await db.query.dnsZones.findFirst({
		where: eq(dnsZones.name, name),
	});
	if (existing) {
		if (existing.organizationId === organizationId) return existing;
		throw new TRPCError({
			code: "CONFLICT",
			message: "This DNS zone is already managed by another organization",
		});
	}

	const requestedNameservers = normalizeNameservers(input.nameservers, name);
	const platformApex = await resolvePlatformDefaultDomain();
	const nameservers =
		requestedNameservers.length > 0
			? requestedNameservers
			: resolveDefaultManagedNameservers({
					zoneName: name,
					platformApex,
				});

	const [zone] = await db
		.insert(dnsZones)
		.values({
			organizationId,
			name,
			soaEmail: input.soaEmail.trim(),
			ttl: input.ttl ?? 300,
			nameservers,
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
	try {
		return await db.query.dnsZones.findMany({
			where: eq(dnsZones.organizationId, organizationId),
			with: { records: true },
			orderBy: [asc(dnsZones.name)],
		});
	} catch (error) {
		rethrowUnlessSchemaDrift(error, "DNS zones");
	}
}

export async function findDnsZoneById(
	dnsZoneId: string,
	organizationId: string,
) {
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
	const initialZone = await findDnsZoneById(dnsZoneId, organizationId);
	return withDnsZonePublishLock(initialZone.name, async () => {
		// Re-read after acquiring the same per-zone lock used by publishers. This
		// prevents a concurrent publish from recreating the zone file between the
		// unlink and database deletion.
		const zone = await findDnsZoneById(dnsZoneId, organizationId);
		const managed = zone.records.filter((r) => r.managedBy !== "user");
		if (managed.length > 0) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"Remove managed service/preview records before deleting this zone",
			});
		}
		const publishedPath = zoneFilePath(zone.name);
		const hadPublishedFile = existsSync(publishedPath);
		if (hadPublishedFile) {
			try {
				unlinkSync(publishedPath);
				await reloadNearzeroDns();
			} catch (error) {
				// The lock is already held, so restore without trying to reacquire it.
				// The database remains untouched and the deletion can be retried.
				await publishDnsZoneUnlocked(dnsZoneId, organizationId).catch(
					() => undefined,
				);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: toDnsPublishMessage(error),
					cause: error,
				});
			}
		}

		try {
			await db.delete(dnsZones).where(eq(dnsZones.dnsZoneId, dnsZoneId));
		} catch (error) {
			if (hadPublishedFile) {
				await publishDnsZoneUnlocked(dnsZoneId, organizationId).catch(
					() => undefined,
				);
			}
			throw error;
		}
		return zone;
	});
}

export async function listDnsRecords(
	dnsZoneId: string,
	organizationId: string,
) {
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
	let value: string;
	try {
		value = normalizeDnsRecordValue(type, input.value, zone.name);
		normalizeZoneRecord(
			{
				name,
				type,
				value,
				ttl: input.ttl,
				priority: input.priority,
			},
			zone.name,
		);
	} catch (error) {
		return badDnsInput(error);
	}
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`${zone.dnsZoneId}:${name}`}, 0))`,
		);
		const ownerRecords = await tx.query.dnsRecords.findMany({
			where: and(
				eq(dnsRecords.dnsZoneId, zone.dnsZoneId),
				eq(dnsRecords.name, name),
			),
		});
		if (
			(type === "CNAME" &&
				ownerRecords.some((record) => record.type !== "CNAME")) ||
			(type !== "CNAME" &&
				ownerRecords.some((record) => record.type === "CNAME"))
		) {
			throw new TRPCError({
				code: "CONFLICT",
				message: `CNAME cannot coexist with other records at ${name}`,
			});
		}

		const existing = ownerRecords.find(
			(record) => record.type === type && record.value === value,
		);
		if (existing) {
			if (existing.managedBy !== "user") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Managed DNS records can only be changed through the domain lifecycle",
				});
			}
			const [updated] = await tx
				.update(dnsRecords)
				.set({
					ttl: input.ttl ?? existing.ttl,
					priority: input.priority ?? existing.priority,
					managedBy: "user",
					domainId: null,
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

		const [created] = await tx
			.insert(dnsRecords)
			.values({
				dnsZoneId: zone.dnsZoneId,
				name,
				type,
				value,
				ttl: input.ttl,
				priority: input.priority,
				managedBy: "user",
				domainId: null,
			})
			.returning();

		if (!created) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Failed to create DNS record",
			});
		}
		return created;
	});
}

export async function deleteDnsRecord(
	dnsRecordId: string,
	organizationId: string,
) {
	const initialRecord = await db.query.dnsRecords.findFirst({
		where: eq(dnsRecords.dnsRecordId, dnsRecordId),
		with: { zone: true },
	});
	if (
		!initialRecord?.zone ||
		initialRecord.zone.organizationId !== organizationId
	) {
		throw new TRPCError({ code: "NOT_FOUND", message: "DNS record not found" });
	}
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`${initialRecord.dnsZoneId}:${initialRecord.name}`}, 0))`,
		);
		const record = await tx.query.dnsRecords.findFirst({
			where: eq(dnsRecords.dnsRecordId, dnsRecordId),
			with: { zone: true },
		});
		if (!record?.zone || record.zone.organizationId !== organizationId) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "DNS record not found",
			});
		}
		if (record.managedBy !== "user") {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"Managed DNS records can only be removed through the domain lifecycle",
			});
		}
		await tx.delete(dnsRecords).where(eq(dnsRecords.dnsRecordId, dnsRecordId));
		return record;
	});
}

async function publishDnsZoneUnlocked(
	dnsZoneId: string,
	organizationId: string,
) {
	const zone = await findDnsZoneById(dnsZoneId, organizationId);
	const zonePath = zoneFilePath(zone.name);
	const serial = createSoaSerial(Date.now(), publishedZoneSerial(zonePath));

	try {
		const records = await recordsWithNameserverGlue(zone);
		const contents = renderZoneFile({
			zoneName: zone.name,
			soaEmail: zone.soaEmail,
			defaultTtl: zone.ttl,
			nameservers: zone.nameservers,
			serial,
			records,
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

export async function publishDnsZone(
	dnsZoneId: string,
	organizationId: string,
) {
	const zone = await findDnsZoneById(dnsZoneId, organizationId);
	return withDnsZonePublishLock(zone.name, () =>
		publishDnsZoneUnlocked(dnsZoneId, organizationId),
	);
}

export async function publishAllDnsZones(organizationId: string) {
	const zones = await listDnsZones(organizationId);
	for (const zone of zones) {
		await publishDnsZone(zone.dnsZoneId, organizationId);
	}
	return zones.length;
}

export async function getDnsZoneInstructions(
	zone: typeof dnsZones.$inferSelect & {
		records?: Array<typeof dnsRecords.$inferSelect>;
	},
) {
	const zoneName = normalizeDnsZoneName(zone.name);
	const platformApex = await resolvePlatformDefaultDomain();
	const ns =
		zone.nameservers.length > 0
			? normalizeNameservers(zone.nameservers, zoneName)
			: resolveDefaultManagedNameservers({
					zoneName,
					platformApex,
				});
	const inBailiwick = ns.filter((name) => isNameInsideZone(name, zoneName));
	let authoritativeServerIp: string | null = null;
	try {
		authoritativeServerIp = await resolveDomainTargetIp();
	} catch {
		authoritativeServerIp = null;
	}
	const glueRecords = inBailiwick.map((nameserver) => {
		const relative = normalizeDnsRecordName(nameserver, zoneName);
		const configured = zone.records?.find(
			(record) =>
				record.name === relative &&
				(record.type === "A" || record.type === "AAAA"),
		);
		return {
			nameserver,
			type: configured?.type ?? "A",
			value: configured?.value ?? authoritativeServerIp,
		};
	});
	const warnings: string[] = [];
	if (inBailiwick.length > 0 && glueRecords.some((record) => !record.value)) {
		warnings.push(
			"Configure the Nearzero host public IPv4 before delegating in-zone nameservers.",
		);
	}
	if (
		new Set(glueRecords.map((record) => record.value).filter(Boolean)).size < 2
	) {
		warnings.push(
			"A single authoritative IP is not highly available; production DNS should use a second independent authoritative server.",
		);
	}
	return {
		zone: zoneName,
		nameservers: ns,
		authoritativeServerIp,
		glueRecords,
		warnings,
		message:
			inBailiwick.length > 0
				? `Create the listed nameserver glue at your registrar, then delegate ${zoneName} to those nameservers and publish the zone in Nearzero.`
				: `Point the listed nameservers at the Nearzero DNS host, delegate ${zoneName} to them at your registrar, then publish the zone in Nearzero.`,
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
	const { records, linkedDomain } = await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`domain:${domainId}`}, 0))`,
		);
		const [currentRecords, currentDomain] = await Promise.all([
			tx.query.dnsRecords.findMany({
				where: eq(dnsRecords.domainId, domainId),
			}),
			tx.query.domains.findFirst({
				where: eq(domains.domainId, domainId),
				columns: { dnsRecordId: true },
			}),
		]);
		const ownerKeys = Array.from(
			new Set(
				currentRecords.map((record) => `${record.dnsZoneId}:${record.name}`),
			),
		).sort();
		for (const ownerKey of ownerKeys) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`,
			);
		}
		if (currentRecords.length > 0) {
			await tx.delete(dnsRecords).where(eq(dnsRecords.domainId, domainId));
		}
		return { records: currentRecords, linkedDomain: currentDomain };
	});
	if (records.length === 0) return;
	const zoneIds = Array.from(
		new Set(records.map((record) => record.dnsZoneId)),
	);
	let firstError: unknown;
	for (const dnsZoneId of zoneIds) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, dnsZoneId),
		});
		if (zone) {
			try {
				await publishDnsZone(zone.dnsZoneId, zone.organizationId);
			} catch (error) {
				firstError ??= error;
			}
		}
	}
	if (!firstError) return;

	// Deleting a managed record and publishing its zone is one logical action.
	// Restore the database rows and authoritative files if CoreDNS rejects the
	// change so a transient reload failure cannot orphan the domain.
	await db.transaction(async (tx) => {
		await tx.delete(dnsRecords).where(eq(dnsRecords.domainId, domainId));
		await tx.insert(dnsRecords).values(records);
		if (linkedDomain) {
			await tx
				.update(domains)
				.set({ dnsRecordId: linkedDomain.dnsRecordId })
				.where(eq(domains.domainId, domainId));
		}
	});
	for (const dnsZoneId of zoneIds) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, dnsZoneId),
		});
		if (zone) {
			await publishDnsZone(zone.dnsZoneId, zone.organizationId).catch(
				() => undefined,
			);
		}
	}
	throw firstError;
}
