function normalizeConfiguredDnsName(value: string | undefined): string | null {
	const normalized = value?.trim().toLowerCase().replace(/\.$/, "");
	return normalized || null;
}

/** Public hostname for the Nearzero dashboard/control plane itself. */
export function getManagementHostname(): string | null {
	return normalizeConfiguredDnsName(process.env.NEARZERO_MANAGEMENT_HOSTNAME);
}

/** Authoritative application zone that the first OSS owner adopts. */
export function getManagedDnsZone(): string | null {
	return normalizeConfiguredDnsName(process.env.NEARZERO_MANAGED_DNS_ZONE);
}

/** SOA and Let's Encrypt contact used by first-install domain bootstrap. */
export function getManagedDnsSoaEmail(): string | null {
	const normalized =
		process.env.NEARZERO_MANAGED_DNS_SOA_EMAIL?.trim() ||
		process.env.NEARZERO_ADMIN_EMAIL?.trim();
	return normalized || null;
}

/** Installer-selected public IPv4 address for the local OSS runtime. */
export function getConfiguredPublicIp(): string | null {
	const normalized = process.env.NEARZERO_PUBLIC_IP?.trim();
	return normalized || null;
}

/**
 * A platform apex can target the local runtime directly. Remote workloads may
 * use it only when an independently configured edge can route each hostname to
 * the server selected for that service.
 */
export function isPlatformDomainSharedEdgeEnabled(): boolean {
	return (
		process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE?.trim().toLowerCase() ===
		"true"
	);
}
