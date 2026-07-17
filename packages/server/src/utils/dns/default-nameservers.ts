import { getPlatformDefaultDomain } from "@nearzero/server/constants";

function normalizeApex(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Default authoritative nameservers for a Nearzero-managed zone.
 * Prefer the platform apex (ns1/ns2.veritus.space) so customer zones
 * delegate out-of-bailiwick like Vercel/Cloudflare. Fall back to
 * in-zone ns1/ns2 only when no platform domain is configured.
 */
export function getDefaultManagedNameservers(zoneName: string): string[] {
	const zone = normalizeApex(zoneName);
	const apex = getPlatformDefaultDomain();
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
	const apex = input.platformApex?.trim()
		? normalizeApex(input.platformApex)
		: getPlatformDefaultDomain();
	if (apex) {
		return [`ns1.${apex}`, `ns2.${apex}`];
	}
	return [`ns1.${zone}`, `ns2.${zone}`];
}
