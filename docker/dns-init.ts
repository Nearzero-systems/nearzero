import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { domainToASCII } from "node:url";

const DNS_ROOT = process.env.NEARZERO_DNS_ROOT?.trim() || "/etc/coredns";
const ZONES_PATH = path.join(DNS_ROOT, "zones");
const COREFILE_PATH = path.join(DNS_ROOT, "Corefile");
const LEGACY_ZONES_PATH =
	process.env.NEARZERO_LEGACY_DNS_ZONES_PATH?.trim() ||
	"/legacy-nearzero/dns/zones";
const BOOTSTRAP_MARKER =
	"; Nearzero bootstrap zone - adopted after first-owner signup";
const DNS_ZONE_ADOPTION_MARKER_PREFIX = ".nearzero-adopted-";

function normalizeDnsName(value: string, field: string) {
	const raw = value.trim().toLowerCase().replace(/\.$/, "");
	const labels = raw.split(".");
	if (labels.length < 2)
		throw new Error(`${field} must be a fully qualified DNS name`);
	const normalized = labels.map((label) => {
		const ascii = domainToASCII(label).toLowerCase();
		if (
			!ascii ||
			ascii.length > 63 ||
			!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(ascii)
		) {
			throw new Error(`${field} contains an invalid DNS label`);
		}
		return ascii;
	});
	const result = normalized.join(".");
	if (result.length > 253) throw new Error(`${field} is too long`);
	return result;
}

function soaMailbox(value: string) {
	const trimmed = value.trim();
	const separator = trimmed.lastIndexOf("@");
	if (separator <= 0 || separator === trimmed.length - 1) {
		throw new Error(
			"NEARZERO_MANAGED_DNS_SOA_EMAIL must be a valid email address",
		);
	}
	const local = trimmed.slice(0, separator);
	if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
		throw new Error(
			"NEARZERO_MANAGED_DNS_SOA_EMAIL contains unsupported characters",
		);
	}
	const domain = normalizeDnsName(
		trimmed.slice(separator + 1),
		"NEARZERO_MANAGED_DNS_SOA_EMAIL",
	);
	return `${local.replaceAll(".", "\\.")}.${domain}.`;
}

function recordOwner(hostname: string, zone: string): string | null {
	if (hostname === zone) return "@";
	if (!hostname.endsWith(`.${zone}`)) return null;
	return hostname.slice(0, -(zone.length + 1));
}

function isPublicIpv4(value: string) {
	if (isIP(value) !== 4) return false;
	const toInteger = (address: string) =>
		address
			.split(".")
			.map(Number)
			.reduce((result, octet) => result * 256 + octet, 0) >>> 0;
	const address = toInteger(value);
	const excluded: Array<[string, number]> = [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.88.99.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	];
	return !excluded.some(([network, prefix]) => {
		const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
		return (address & mask) === (toInteger(network) & mask);
	});
}

function ensureCorefile() {
	if (existsSync(COREFILE_PATH)) return;
	writeFileSync(
		COREFILE_PATH,
		[
			"# Managed by Nearzero. Authoritative zones only; this is not a recursive resolver.",
			".:53 {",
			"  auto {",
			"    directory /etc/coredns/zones (.*)\\.zone {1}",
			"    reload 2s",
			"  }",
			"  reload 30s",
			"  errors",
			"}",
			"",
		].join("\n"),
		"utf8",
	);
}

function copyLegacyZones() {
	if (!existsSync(LEGACY_ZONES_PATH)) return;
	for (const filename of readdirSync(LEGACY_ZONES_PATH)) {
		if (!filename.endsWith(".zone")) continue;
		const target = path.join(ZONES_PATH, filename);
		if (!existsSync(target)) {
			copyFileSync(path.join(LEGACY_ZONES_PATH, filename), target);
		}
	}
}

function ensureBootstrapZone() {
	const configuredZone = process.env.NEARZERO_MANAGED_DNS_ZONE?.trim();
	if (!configuredZone) return;

	const zone = normalizeDnsName(configuredZone, "NEARZERO_MANAGED_DNS_ZONE");
	const adoptionMarkerPath = path.join(
		DNS_ROOT,
		`${DNS_ZONE_ADOPTION_MARKER_PREFIX}${zone}`,
	);
	if (existsSync(adoptionMarkerPath)) return;
	const publicIp = process.env.NEARZERO_PUBLIC_IP?.trim() ?? "";
	if (!isPublicIpv4(publicIp)) {
		throw new Error(
			"NEARZERO_PUBLIC_IP must be a public IPv4 address when managed DNS is configured",
		);
	}
	const soaEmail =
		process.env.NEARZERO_MANAGED_DNS_SOA_EMAIL?.trim() ||
		process.env.NEARZERO_ADMIN_EMAIL?.trim() ||
		"";
	if (!soaEmail) {
		throw new Error(
			"NEARZERO_ADMIN_EMAIL or NEARZERO_MANAGED_DNS_SOA_EMAIL is required when managed DNS is configured",
		);
	}
	const rname = soaMailbox(soaEmail);
	const managementHostname = process.env.NEARZERO_MANAGEMENT_HOSTNAME?.trim()
		? normalizeDnsName(
				process.env.NEARZERO_MANAGEMENT_HOSTNAME,
				"NEARZERO_MANAGEMENT_HOSTNAME",
			)
		: null;
	const managementOwner = managementHostname
		? recordOwner(managementHostname, zone)
		: null;
	const serial = Math.floor(Date.now() / 1000) % 2 ** 32;
	const records = [
		BOOTSTRAP_MARKER,
		`$ORIGIN ${zone}.`,
		"$TTL 300",
		`@ IN SOA ns1.${zone}. ${rname} (`,
		`  ${serial} ; serial`,
		"  3600 ; refresh",
		"  1800 ; retry",
		"  604800 ; expire",
		"  300 ; minimum",
		")",
		`@ IN NS ns1.${zone}.`,
		`@ IN NS ns2.${zone}.`,
		`ns1 300 IN A ${publicIp}`,
		`ns2 300 IN A ${publicIp}`,
	];
	if (managementOwner !== null) {
		records.push(`${managementOwner} 300 IN A ${publicIp}`);
	}
	records.push("");

	const zonePath = path.join(ZONES_PATH, `${zone}.zone`);
	if (existsSync(zonePath)) {
		const existing = readFileSync(zonePath, "utf8");
		if (!existing.startsWith(BOOTSTRAP_MARKER)) return;
	}
	const temporaryPath = `${zonePath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, records.join("\n"), "utf8");
	renameSync(temporaryPath, zonePath);
}

mkdirSync(ZONES_PATH, { recursive: true, mode: 0o755 });
copyLegacyZones();
ensureCorefile();
ensureBootstrapZone();
