import { isIP } from "node:net";
import path from "node:path";
import {
	getConfiguredPublicIp,
	getManagedDnsSoaEmail,
	getManagedDnsZone,
	getManagementHostname,
	paths,
} from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import { dnsZones } from "@nearzero/server/db/schema";
import {
	normalizeDnsHostname,
	normalizeDnsZoneName,
	writeZoneFileAtomic,
} from "@nearzero/server/utils/dns/zone-file";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDnsZone, publishDnsZone, upsertSystemDnsARecord } from "./dns";
import { isPublicIpv4, resolveDomainTargetIp } from "./domain-target";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "./web-server-settings";

const emailSchema = z.string().trim().email();
const DNS_ZONE_ADOPTION_MARKER_PREFIX = ".nearzero-adopted-";

export function persistConfiguredDnsZoneAdoptionMarker(
	zoneName: string,
	dnsRootPath = paths().DNS_PATH,
) {
	const normalizedZone = normalizeDnsZoneName(zoneName);
	const dnsRoot = path.resolve(dnsRootPath);
	const markerPath = path.resolve(
		dnsRoot,
		`${DNS_ZONE_ADOPTION_MARKER_PREFIX}${normalizedZone}`,
	);
	if (path.dirname(markerPath) !== dnsRoot) {
		throw new Error("DNS adoption marker path escaped the managed DNS root");
	}
	writeZoneFileAtomic(markerPath, `${normalizedZone}\n`);
	return markerPath;
}

export type InstallDomainConfig = {
	managementHostname: string | null;
	managedDnsZone: string | null;
	soaEmail: string | null;
	publicIp: string | null;
};

export function getInstallDomainConfig(): InstallDomainConfig {
	const management = getManagementHostname();
	const zone = getManagedDnsZone();
	const email = getManagedDnsSoaEmail();
	const publicIp = getConfiguredPublicIp();
	if (publicIp && isIP(publicIp) !== 4) {
		throw new Error("NEARZERO_PUBLIC_IP must be a valid IPv4 address");
	}
	if (publicIp && (management || zone) && !isPublicIpv4(publicIp)) {
		throw new Error(
			"NEARZERO_PUBLIC_IP must be a publicly routable IPv4 address",
		);
	}
	return {
		managementHostname: management
			? normalizeDnsHostname(management, { requireFqdn: true })
			: null,
		managedDnsZone: zone ? normalizeDnsZoneName(zone) : null,
		soaEmail: email ? emailSchema.parse(email) : null,
		publicIp,
	};
}

export function hostnameOwnerInsideZone(hostname: string, zoneName: string) {
	const host = normalizeDnsHostname(hostname, { requireFqdn: true });
	const zone = normalizeDnsZoneName(zoneName);
	if (host === zone) return "@";
	if (!host.endsWith(`.${zone}`)) return null;
	return host.slice(0, -(zone.length + 1));
}

type ManagementBootstrapDependencies = {
	getSettings: typeof getWebServerSettings;
	updateSettings: typeof updateWebServerSettings;
};

const managementBootstrapDependencies: ManagementBootstrapDependencies = {
	getSettings: getWebServerSettings,
	updateSettings: updateWebServerSettings,
};

/**
 * Seed installer-owned local runtime settings before HTTP or Traefik starts.
 * An explicit public IP remains authoritative across first-owner onboarding;
 * an existing, different management hostname is never silently replaced.
 */
export async function seedConfiguredManagementDomain(
	dependencies: ManagementBootstrapDependencies = managementBootstrapDependencies,
) {
	const config = getInstallDomainConfig();
	if (!config.managementHostname && !config.publicIp) {
		return {
			configured: false as const,
			changed: false,
			conflict: false as const,
			host: undefined,
			publicIp: undefined,
			publicIpChanged: false,
		};
	}
	if (config.managementHostname && !config.soaEmail) {
		throw new Error(
			"NEARZERO_ADMIN_EMAIL or NEARZERO_MANAGED_DNS_SOA_EMAIL is required with NEARZERO_MANAGEMENT_HOSTNAME",
		);
	}

	const current = await dependencies.getSettings();
	const currentHost = current?.host
		? normalizeDnsHostname(current.host, {
				requireFqdn: true,
			})
		: null;
	if (
		config.managementHostname &&
		currentHost &&
		currentHost !== config.managementHostname
	) {
		throw new Error(
			`NEARZERO_MANAGEMENT_HOSTNAME (${config.managementHostname}) conflicts with the persisted management hostname (${currentHost}); refusing to start with split routing state`,
		);
	}

	const updates: Parameters<typeof updateWebServerSettings>[0] = {};
	const publicIpChanged = Boolean(
		config.publicIp && current?.serverIp !== config.publicIp,
	);
	if (config.publicIp && publicIpChanged) {
		updates.serverIp = config.publicIp;
	}
	if (config.managementHostname && !currentHost) {
		updates.host = config.managementHostname;
		updates.https = true;
		updates.certificateType = "letsencrypt";
		updates.letsEncryptEmail = config.soaEmail;
	}

	const changed = Object.keys(updates).length > 0;
	const updated = changed
		? await dependencies.updateSettings(updates)
		: current;
	if (changed && !updated) {
		throw new Error("Failed to seed the configured install domain settings");
	}
	return {
		configured: Boolean(config.managementHostname),
		changed,
		conflict: false as const,
		host:
			currentHost ?? updated?.host ?? config.managementHostname ?? undefined,
		publicIp: updated?.serverIp ?? config.publicIp ?? undefined,
		publicIpChanged,
	};
}

/** Keep startup-seeded/operator-selected state ahead of outbound IP discovery. */
export async function ensureFirstOwnerServerIp(
	discoverPublicIp: () => Promise<string | null>,
	dependencies: ManagementBootstrapDependencies = managementBootstrapDependencies,
) {
	const current = await dependencies.getSettings();
	if (current?.serverIp) return current.serverIp;

	const detectedPublicIp = await discoverPublicIp();
	if (!detectedPublicIp) return null;
	const updated = await dependencies.updateSettings({
		serverIp: detectedPublicIp,
	});
	if (!updated) {
		throw new Error("Failed to persist the detected public IP");
	}
	return detectedPublicIp;
}

type DnsBootstrapDependencies = {
	createZone: typeof createDnsZone;
	resolveTargetIp: typeof resolveDomainTargetIp;
	upsertSystemAddress: typeof upsertSystemDnsARecord;
	publishZone: typeof publishDnsZone;
	markZoneAdopted: typeof persistConfiguredDnsZoneAdoptionMarker;
};

const dnsBootstrapDependencies: DnsBootstrapDependencies = {
	createZone: createDnsZone,
	resolveTargetIp: resolveDomainTargetIp,
	upsertSystemAddress: upsertSystemDnsARecord,
	publishZone: publishDnsZone,
	markZoneAdopted: persistConfiguredDnsZoneAdoptionMarker,
};

/** Claim the installer-created authoritative zone for the first owner org. */
export async function adoptConfiguredManagedDnsZone(
	input: {
		organizationId: string;
		ownerEmail: string;
	},
	dependencies: DnsBootstrapDependencies = dnsBootstrapDependencies,
) {
	const config = getInstallDomainConfig();
	let managedDnsZone = config.managedDnsZone;
	let soaEmail = config.soaEmail;
	let managementHostname = config.managementHostname;
	if (!managedDnsZone) {
		try {
			const { getEffectiveManagedDnsZone, getEffectiveManagedDnsSoaEmail } =
				await import("./install-setup");
			managedDnsZone = await getEffectiveManagedDnsZone();
			soaEmail = (await getEffectiveManagedDnsSoaEmail()) ?? soaEmail;
			const settings = await getWebServerSettings();
			if (settings?.host) {
				managementHostname = normalizeDnsHostname(settings.host, {
					requireFqdn: true,
				});
			}
		} catch {
			// install_setup may be unavailable during early migrations
		}
	}
	if (!managedDnsZone) return null;
	soaEmail = soaEmail ?? emailSchema.parse(input.ownerEmail);
	const nameservers = [`ns1.${managedDnsZone}`, `ns2.${managedDnsZone}`];
	const zone = await dependencies.createZone(input.organizationId, {
		name: managedDnsZone,
		soaEmail,
		ttl: 300,
		nameservers,
	});

	if (
		managementHostname &&
		hostnameOwnerInsideZone(managementHostname, managedDnsZone) !== null
	) {
		const targetIp = await dependencies.resolveTargetIp();
		await dependencies.upsertSystemAddress({
			dnsZoneId: zone.dnsZoneId,
			organizationId: input.organizationId,
			host: managementHostname,
			value: targetIp,
		});
	}

	const published = await dependencies.publishZone(
		zone.dnsZoneId,
		input.organizationId,
	);
	dependencies.markZoneAdopted(managedDnsZone);
	return published;
}

export async function findConfiguredManagedDnsZoneForOrganization(
	organizationId: string,
) {
	let zoneName = getInstallDomainConfig().managedDnsZone;
	if (!zoneName) {
		try {
			const { getEffectiveManagedDnsZone } = await import("./install-setup");
			zoneName = await getEffectiveManagedDnsZone();
		} catch {
			zoneName = null;
		}
	}
	if (!zoneName) return null;
	return db.query.dnsZones.findFirst({
		where: and(
			eq(dnsZones.organizationId, organizationId),
			eq(dnsZones.name, zoneName),
		),
		columns: { dnsZoneId: true, name: true, status: true },
	});
}
