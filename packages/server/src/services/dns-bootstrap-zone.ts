import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import {
	normalizeDnsHostname,
	normalizeDnsZoneName,
} from "@nearzero/server/utils/dns/zone-file";
import { z } from "zod";
import { isPublicIpv4 } from "./domain-target";

function hostnameOwnerInsideZone(hostname: string, zoneName: string) {
	const host = normalizeDnsHostname(hostname, { requireFqdn: true });
	const zone = normalizeDnsZoneName(zoneName);
	if (host === zone) return "@";
	if (!host.endsWith(`.${zone}`)) return null;
	return host.slice(0, -(zone.length + 1));
}

export const BOOTSTRAP_ZONE_MARKER =
	"; Nearzero bootstrap zone - adopted after first-owner signup";

const emailSchema = z.string().trim().email();

function soaMailbox(value: string) {
	const trimmed = emailSchema.parse(value);
	const separator = trimmed.lastIndexOf("@");
	const local = trimmed.slice(0, separator);
	const domain = normalizeDnsHostname(trimmed.slice(separator + 1), {
		requireFqdn: true,
	});
	return `${local.replaceAll(".", "\\.")}.${domain}.`;
}

/**
 * Write a pre-adoption CoreDNS zone file for a managed application zone.
 * Safe to call from the platform after the browser wizard configures a zone.
 */
export function writeManagedDnsBootstrapZone(input: {
	zoneName: string;
	publicIp: string;
	soaEmail: string;
	managementHostname?: string | null;
	dnsRootPath?: string;
}) {
	const zone = normalizeDnsZoneName(input.zoneName);
	if (!isPublicIpv4(input.publicIp)) {
		throw new Error(
			"A publicly routable IPv4 address is required to bootstrap managed DNS",
		);
	}
	const rname = soaMailbox(input.soaEmail);
	const dnsRoot = path.resolve(input.dnsRootPath ?? paths().DNS_PATH);
	const zonesPath = path.join(dnsRoot, "zones");
	mkdirSync(zonesPath, { recursive: true, mode: 0o755 });

	const managementHostname = input.managementHostname
		? normalizeDnsHostname(input.managementHostname, { requireFqdn: true })
		: null;
	const managementOwner = managementHostname
		? hostnameOwnerInsideZone(managementHostname, zone)
		: null;
	const serial = Math.floor(Date.now() / 1000) % 2 ** 32;
	const records = [
		BOOTSTRAP_ZONE_MARKER,
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
		`ns1 300 IN A ${input.publicIp}`,
		`ns2 300 IN A ${input.publicIp}`,
	];
	if (managementOwner !== null) {
		records.push(`${managementOwner} 300 IN A ${input.publicIp}`);
	}
	records.push("");

	const zonePath = path.resolve(zonesPath, `${zone}.zone`);
	if (path.dirname(zonePath) !== path.resolve(zonesPath)) {
		throw new Error("Managed DNS zone path escaped the zones directory");
	}
	if (existsSync(zonePath)) {
		const existing = readFileSync(zonePath, "utf8");
		if (!existing.startsWith(BOOTSTRAP_ZONE_MARKER)) {
			return { written: false as const, zonePath };
		}
	}
	const temporaryPath = `${zonePath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, records.join("\n"), "utf8");
	renameSync(temporaryPath, zonePath);
	return { written: true as const, zonePath };
}

export function isManagedDnsEnabledByInstaller(
	env: Record<string, string | undefined> = process.env,
) {
	const value = env.NEARZERO_ENABLE_MANAGED_DNS?.trim().toLowerCase();
	if (!value) return true;
	return value === "true" || value === "1" || value === "yes";
}
