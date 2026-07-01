import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ZoneRecord = {
	name: string;
	type: string;
	value: string;
	ttl?: number | null;
	priority?: number | null;
};

export type ZoneFileInput = {
	zoneName: string;
	soaEmail: string;
	defaultTtl: number;
	nameservers: string[];
	serial: string;
	records: ZoneRecord[];
};

function normalizeZoneName(name: string) {
	return name.trim().toLowerCase().replace(/\.$/, "");
}

function recordNameInZone(name: string, zoneName: string) {
	const normalized = name.trim().toLowerCase().replace(/\.$/, "");
	if (normalized === "@" || normalized === "") return "@";
	if (normalized.endsWith(`.${zoneName}`)) {
		return normalized.slice(0, -(zoneName.length + 1)) || "@";
	}
	return normalized;
}

function quoteTxtValue(value: string) {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
	return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatHostnameValue(value: string) {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "@" || trimmed.endsWith(".")) return trimmed;
	return trimmed.includes(".") ? `${trimmed}.` : trimmed;
}

function recordValue(record: ZoneRecord) {
	const type = record.type.toUpperCase();
	if (type === "TXT") return quoteTxtValue(record.value);
	if (type === "CNAME" || type === "NS" || type === "MX") {
		return formatHostnameValue(record.value);
	}
	return record.value;
}

export function renderZoneFile(input: ZoneFileInput): string {
	const zone = normalizeZoneName(input.zoneName);
	const sorted = [...input.records].sort((a, b) => {
		const nameCmp = a.name.localeCompare(b.name);
		if (nameCmp !== 0) return nameCmp;
		const typeCmp = a.type.localeCompare(b.type);
		if (typeCmp !== 0) return typeCmp;
		return a.value.localeCompare(b.value);
	});
	const ownerRecords = new Map<string, ZoneRecord[]>();
	for (const record of sorted) {
		const owner = recordNameInZone(record.name, zone);
		ownerRecords.set(owner, [...(ownerRecords.get(owner) ?? []), record]);
	}

	for (const [owner, records] of ownerRecords) {
		const cnameRecords = records.filter((r) => r.type.toUpperCase() === "CNAME");
		if (cnameRecords.length === 0) continue;
		if (owner === "@") {
			throw new Error("Invalid CNAME at zone apex");
		}
		if (records.length > 1) {
			throw new Error(`Invalid CNAME conflict at ${owner}`);
		}
	}

	const lines: string[] = [
		`$ORIGIN ${zone}.`,
		`$TTL ${input.defaultTtl}`,
		`@ IN SOA ns1.${zone}. ${input.soaEmail.replace("@", ".")}. (`,
		`  ${input.serial} ; serial`,
		"  3600 ; refresh",
		"  1800 ; retry",
		"  604800 ; expire",
		"  300 ; minimum",
		")",
	];

	const nsList =
		input.nameservers.length > 0
			? input.nameservers
			: [`ns1.${zone}.`, `ns2.${zone}.`];
	for (const ns of nsList) {
		lines.push(`@ IN NS ${ns.endsWith(".") ? ns : `${ns}.`}`);
	}

	for (const record of sorted) {
		const rel = recordNameInZone(record.name, zone);
		const owner = rel === "@" ? "@" : rel;
		const ttl = record.ttl ?? input.defaultTtl;
		const type = record.type.toUpperCase();
		if (type === "MX") {
			lines.push(
				`${owner} ${ttl} IN MX ${record.priority ?? 10} ${recordValue(record)}`,
			);
			continue;
		}
		lines.push(`${owner} ${ttl} IN ${type} ${recordValue(record)}`);
	}

	return `${lines.join("\n")}\n`;
}

export function writeZoneFileAtomic(zoneFilePath: string, contents: string) {
	mkdirSync(path.dirname(zoneFilePath), { recursive: true });
	const tempPath = `${zoneFilePath}.${process.pid}.tmp`;
	writeFileSync(tempPath, contents, "utf8");
	renameSync(tempPath, zoneFilePath);
}
