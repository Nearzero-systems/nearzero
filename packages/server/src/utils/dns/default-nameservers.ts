import {
	getManagedDnsZone,
	getPlatformDefaultDomain,
} from "@nearzero/server/constants";

function normalizeApex(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Default authoritative nameservers for a Nearzero-managed zone.
 * Prefer the first-install managed zone because CoreDNS publishes its ns1/ns2
 * address records. A separately configured platform apex remains a legacy
 * fallback; otherwise use in-zone nameservers and generate their glue.
 */
export function getDefaultManagedNameservers(zoneName: string): string[] {
	const zone = normalizeApex(zoneName);
	const apex = getManagedDnsZone() ?? getPlatformDefaultDomain();
	if (apex) {
		const platform = normalizeApex(apex);
		return [`ns1.${platform}`, `ns2.${platform}`];
	}
	return [`ns1.${zone}`, `ns2.${zone}`];
}

export function resolveDefaultManagedNameservers(input: {
	zoneName: string;
	platformApex?: string | null;
}): string[] {
	const zone = normalizeApex(input.zoneName);
	const configuredManagedZone = getManagedDnsZone();
	const apex = configuredManagedZone
		? normalizeApex(configuredManagedZone)
		: input.platformApex?.trim()
			? normalizeApex(input.platformApex)
			: getPlatformDefaultDomain();
	if (apex) {
		return [`ns1.${apex}`, `ns2.${apex}`];
	}
	return [`ns1.${zone}`, `ns2.${zone}`];
}
