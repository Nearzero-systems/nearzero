import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { domainToASCII } from "node:url";
import { getDefaultManagedNameservers } from "./default-nameservers";

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

const DNS_SERIAL_MODULUS = 2 ** 32;
const DNS_SERIAL_HALF_RANGE = 2 ** 31;
const DNS_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
let lastGeneratedSerial: number | null = null;

function assertSafeDnsText(value: string, field: string) {
	if (DNS_CONTROL_CHARACTERS.test(value)) {
		throw new Error(`${field} cannot contain control characters`);
	}
}

function normalizeDnsLabels(
	value: string,
	options: {
		allowUnderscore?: boolean;
		allowWildcard?: boolean;
		requireFqdn?: boolean;
	} = {},
) {
	assertSafeDnsText(value, "DNS name");
	const raw = value.trim().toLowerCase().replace(/\.$/, "");
	if (!raw || /\s/.test(raw)) {
		throw new Error("DNS name must not be empty or contain whitespace");
	}

	const labels = raw.split(".");
	if (options.requireFqdn && labels.length < 2) {
		throw new Error("DNS name must be a fully qualified domain name");
	}

	const normalized = labels.map((label, index) => {
		if (label === "*") {
			if (!options.allowWildcard || index !== 0) {
				throw new Error("A DNS wildcard is only allowed as the left-most label");
			}
			return label;
		}
		if (!label) {
			throw new Error("DNS names cannot contain empty labels");
		}

		const ascii = domainToASCII(label).toLowerCase();
		if (!ascii || ascii.length > 63) {
			throw new Error("Each DNS label must be between 1 and 63 ASCII characters");
		}
		const pattern = options.allowUnderscore
			? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/
			: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
		if (!pattern.test(ascii)) {
			throw new Error(`Invalid DNS label: ${label}`);
		}
		return ascii;
	});

	const result = normalized.join(".");
	if (result.length > 253) {
		throw new Error("DNS name must not exceed 253 ASCII characters");
	}
	return result;
}

export function normalizeDnsHostname(
	name: string,
	options: {
		allowUnderscore?: boolean;
		allowWildcard?: boolean;
		requireFqdn?: boolean;
	} = {},
) {
	return normalizeDnsLabels(name, options);
}

export function normalizeDnsZoneName(name: string) {
	return normalizeDnsLabels(name, { requireFqdn: true });
}

export function normalizeDnsNameserver(name: string, zoneName: string) {
	const zone = normalizeDnsZoneName(zoneName);
	const raw = name.trim().replace(/\.$/, "");
	if (!raw || raw === "@" || raw === "*") {
		throw new Error("Nameserver must be a valid hostname");
	}
	const absolute = raw.includes(".") ? raw : `${raw}.${zone}`;
	return normalizeDnsHostname(absolute, { requireFqdn: true });
}

export function normalizeDnsRecordName(name: string, zoneName: string) {
	const zone = normalizeDnsZoneName(zoneName);
	assertSafeDnsText(name, "DNS record name");
	const raw = name.trim().toLowerCase();
	if (!raw || raw === "@") return "@";
	if (/\s/.test(raw)) {
		throw new Error("DNS record name cannot contain whitespace");
	}

	const hasTrailingDot = raw.endsWith(".");
	const trimmed = raw.replace(/\.$/, "");
	if (trimmed === zone) return "@";
	let relative = trimmed;
	if (trimmed.endsWith(`.${zone}`)) {
		relative = trimmed.slice(0, -(zone.length + 1)) || "@";
	} else if (hasTrailingDot) {
		throw new Error(`Record name ${raw} is not inside DNS zone ${zone}`);
	}
	if (relative === "@") return relative;
	return normalizeDnsHostname(relative, {
		allowUnderscore: true,
		allowWildcard: true,
	});
}

function normalizeDnsRdataHostname(value: string, zoneName: string) {
	const zone = normalizeDnsZoneName(zoneName);
	const raw = value.trim();
	if (!raw) throw new Error("DNS hostname value must not be empty");
	if (raw === "@") return `${zone}.`;
	const withoutDot = raw.replace(/\.$/, "");
	const absolute = withoutDot.includes(".")
		? normalizeDnsHostname(withoutDot, { requireFqdn: true })
		: `${normalizeDnsHostname(withoutDot)}.${zone}`;
	return `${absolute}.`;
}

function normalizeCaaValue(value: string) {
	const match = value.trim().match(/^(\d{1,3})\s+([a-zA-Z0-9]+)\s+(.+)$/);
	if (!match) {
		throw new Error('CAA value must use the format: 0 issue "ca.example"');
	}
	const flags = Number(match[1]);
	if (!Number.isInteger(flags) || flags < 0 || flags > 255) {
		throw new Error("CAA flags must be an integer between 0 and 255");
	}
	const tag = match[2]?.toLowerCase();
	if (!tag || tag.length > 15) {
		throw new Error("CAA tag must be between 1 and 15 characters");
	}
	let caaValue = match[3]?.trim() ?? "";
	if (caaValue.startsWith('"') || caaValue.endsWith('"')) {
		if (!(caaValue.startsWith('"') && caaValue.endsWith('"'))) {
			throw new Error("CAA value has an unmatched quote");
		}
		caaValue = caaValue.slice(1, -1);
	}
	assertSafeDnsText(caaValue, "CAA value");
	if (!caaValue || Buffer.byteLength(caaValue, "utf8") > 255) {
		throw new Error("CAA value must be between 1 and 255 bytes");
	}
	const escaped = caaValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `${flags} ${tag} "${escaped}"`;
}

export function normalizeDnsRecordValue(
	type: string,
	value: string,
	zoneName: string,
) {
	assertSafeDnsText(value, "DNS record value");
	const normalizedType = type.toUpperCase();
	const trimmed = value.trim();
	if (!trimmed) throw new Error("DNS record value must not be empty");

	switch (normalizedType) {
		case "A":
			if (isIP(trimmed) !== 4) throw new Error("A record value must be an IPv4 address");
			return trimmed;
		case "AAAA":
			if (isIP(trimmed) !== 6) throw new Error("AAAA record value must be an IPv6 address");
			return trimmed.toLowerCase();
		case "CNAME":
		case "NS":
		case "MX":
			return normalizeDnsRdataHostname(trimmed, zoneName);
		case "TXT":
			// Store one canonical unquoted string. Rendering always escapes and quotes
			// it again instead of accepting caller-provided zone syntax verbatim.
			const txtValue =
				trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
					? trimmed.slice(1, -1)
					: trimmed;
			if (Buffer.byteLength(txtValue, "utf8") > 255) {
				throw new Error("TXT record value must not exceed 255 bytes");
			}
			return txtValue;
		case "CAA":
			return normalizeCaaValue(trimmed);
		default:
			throw new Error(`Unsupported DNS record type: ${normalizedType}`);
	}
}

export function normalizeZoneRecord(record: ZoneRecord, zoneName: string): ZoneRecord {
	const type = record.type.toUpperCase();
	const name = normalizeDnsRecordName(record.name, zoneName);
	if (type === "CNAME" && name === "@") {
		throw new Error("Invalid CNAME at zone apex");
	}
	if (
		record.ttl !== undefined &&
		record.ttl !== null &&
		(!Number.isInteger(record.ttl) || record.ttl < 1 || record.ttl > 2_147_483_647)
	) {
		throw new Error("DNS record TTL must be an integer between 1 and 2147483647");
	}
	if (type === "MX") {
		const priority = record.priority ?? 10;
		if (!Number.isInteger(priority) || priority < 0 || priority > 65_535) {
			throw new Error("MX priority must be an integer between 0 and 65535");
		}
	} else if (record.priority !== undefined && record.priority !== null) {
		throw new Error("DNS priority is only valid for MX records");
	}
	return {
		...record,
		name,
		type,
		value: normalizeDnsRecordValue(type, record.value, zoneName),
	};
}

export function createSoaSerial(now = Date.now(), previousSerial?: number | null) {
	// Unix seconds fit the unsigned SOA field through 2106. RFC 1982 serial
	// arithmetic ensures clock rollback or rapid writes still move forward.
	let candidate = Math.floor(now / 1000) % DNS_SERIAL_MODULUS;
	const previous =
		previousSerial !== undefined &&
		previousSerial !== null &&
		Number.isInteger(previousSerial) &&
		previousSerial >= 0 &&
		previousSerial < DNS_SERIAL_MODULUS
			? previousSerial
			: lastGeneratedSerial;
	if (previous !== null) {
		const delta = (candidate - previous + DNS_SERIAL_MODULUS) % DNS_SERIAL_MODULUS;
		if (delta === 0 || delta >= DNS_SERIAL_HALF_RANGE) {
			candidate = (previous + 1) % DNS_SERIAL_MODULUS;
		}
	}
	lastGeneratedSerial = candidate;
	return String(candidate);
}

function recordNameInZone(name: string, zoneName: string) {
	const normalized = normalizeDnsRecordName(name, zoneName);
	if (normalized === "@" || normalized === "") return "@";
	return normalized;
}

function quoteTxtValue(value: string) {
	const trimmed = value.trim();
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
	const zone = normalizeDnsZoneName(input.zoneName);
	assertSafeDnsText(input.soaEmail, "SOA email");
	const emailSeparator = input.soaEmail.lastIndexOf("@");
	if (emailSeparator <= 0 || emailSeparator === input.soaEmail.length - 1) {
		throw new Error("SOA email must be a valid email address");
	}
	const emailLocal = input.soaEmail.slice(0, emailSeparator);
	const emailDomain = normalizeDnsHostname(
		input.soaEmail.slice(emailSeparator + 1),
		{ requireFqdn: true },
	);
	if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(emailLocal)) {
		throw new Error("SOA email local part contains unsupported characters");
	}
	if (
		!Number.isInteger(input.defaultTtl) ||
		input.defaultTtl < 1 ||
		input.defaultTtl > 2_147_483_647
	) {
		throw new Error("Default DNS TTL must be an integer between 1 and 2147483647");
	}
	if (!/^\d+$/.test(input.serial)) {
		throw new Error("SOA serial must be an unsigned 32-bit integer");
	}
	const numericSerial = Number(input.serial);
	if (!Number.isSafeInteger(numericSerial) || numericSerial < 0 || numericSerial >= DNS_SERIAL_MODULUS) {
		throw new Error("SOA serial must be an unsigned 32-bit integer");
	}

	const normalizedNameservers = (
		input.nameservers.length > 0
			? input.nameservers
			: getDefaultManagedNameservers(zone)
	).map((ns) => normalizeDnsNameserver(ns, zone));
	const sorted = input.records.map((record) => normalizeZoneRecord(record, zone)).sort((a, b) => {
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
		`@ IN SOA ${normalizedNameservers[0]}. ${emailLocal.replace(/\./g, "\\.")}.${emailDomain}. (`,
		`  ${input.serial} ; serial`,
		"  3600 ; refresh",
		"  1800 ; retry",
		"  604800 ; expire",
		"  300 ; minimum",
		")",
	];

	for (const ns of normalizedNameservers) {
		lines.push(`@ IN NS ${ns}.`);
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
	const tempPath = `${zoneFilePath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, contents, "utf8");
	renameSync(tempPath, zoneFilePath);
}
