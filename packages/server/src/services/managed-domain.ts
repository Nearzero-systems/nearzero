import { getPlatformDefaultDomain } from "@nearzero/server/constants";
import type { environments } from "@nearzero/server/db/schema";
import { isProductionEnvironment } from "@nearzero/server/services/environment";
import {
	normalizeDnsHostname,
	normalizeDnsZoneName,
} from "@nearzero/server/utils/dns/zone-file";
import { getWebServerSettings } from "./web-server-settings";

type EnvironmentDns = Pick<
	typeof environments.$inferSelect,
	"name" | "isDefault" | "domainPrefix"
> & { dnsZoneName?: string | null };

export function isNearzeroAssignedDomain(
	domain: {
		host: string;
		dnsMode: string;
		isSystemAssigned?: boolean;
	},
) {
	return (
		domain.isSystemAssigned === true ||
		domain.dnsMode === "platform" ||
		(domain.dnsMode === "external" &&
			domain.host.trim().toLowerCase().endsWith(".sslip.io"))
	);
}

export function slugifyServiceName(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 48);
}

export function buildManagedServiceHost(input: {
	serviceName: string;
	zoneName: string;
	environment: EnvironmentDns;
}) {
	const zone = normalizeDnsZoneName(input.zoneName);
	const slug = slugifyServiceName(input.serviceName) || "service";
	const prefix = slugifyServiceName(input.environment.domainPrefix ?? "");
	if (prefix) {
		return `${slug}.${prefix}.${zone}`;
	}
	if (isProductionEnvironment(input.environment)) {
		return `${slug}.${zone}`;
	}
	const envLabel = slugifyServiceName(input.environment.name) || "env";
	return `${slug}.${envLabel}.${zone}`;
}

export function buildManagedPreviewHost(input: {
	appName: string;
	zoneName: string;
	targetIp: string;
}) {
	const zone = normalizeDnsZoneName(input.zoneName);
	const hash = slugifyServiceName(input.appName) || "preview";
	if (zone.includes("sslip.io")) {
		const slugIp = input.targetIp.replaceAll(".", "-");
		const suffix = slugIp ? `-${slugIp}` : "";
		const label = `${hash.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
		return `${label}.${zone}`;
	}
	return `${hash}.preview.${zone}`;
}

export function buildPreviewServiceSlug(input: {
	pullRequestNumber: string | number;
	serviceName: string;
	applicationId: string;
}) {
	const pr = String(input.pullRequestNumber).replace(/[^0-9]/g, "") || "0";
	const service = slugifyServiceName(input.serviceName) || "service";
	const app = slugifyServiceName(input.applicationId).slice(0, 8) || "app";
	const prefix = `pr-${pr}-`;
	const suffix = `-${app}`;
	const available = Math.max(1, 63 - prefix.length - suffix.length);
	return `${prefix}${service.slice(0, available)}${suffix}`;
}

export function buildPlatformDefaultPreviewHost(input: {
	previewSlug: string;
	projectName: string;
	organizationId: string;
}) {
	const configuredZone = getPlatformDefaultDomain();
	if (!configuredZone) {
		throw new Error("Platform default domain is not configured");
	}
	const zone = normalizeDnsZoneName(configuredZone);
	const project = platformProjectScope(input.projectName, input.organizationId);
	const preview = normalizeDnsHostname(input.previewSlug);
	return `${preview}.preview.${project || "project"}.${zone}`;
}

function platformProjectScope(projectName: string, organizationId: string) {
	const project = slugifyServiceName(projectName) || "project";
	const organization =
		slugifyServiceName(organizationId).slice(0, 12) || "organization";
	const suffix = `-${organization}`;
	return `${project.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
}

export function isManagedWildcardZone(zoneName: string) {
	try {
		return normalizeDnsHostname(zoneName, {
			allowWildcard: true,
			requireFqdn: true,
		}).startsWith("*.");
	} catch {
		return false;
	}
}

export function normalizeConfiguredPlatformApex(
	value: string | null | undefined,
): string | null {
	const raw = value?.trim().toLowerCase().replace(/\.$/, "");
	if (!raw) return null;
	const withoutScheme = raw.replace(/^https?:\/\//, "").split("/")[0] ?? "";
	const host = withoutScheme.split(":")[0]?.trim();
	return host || null;
}

/** Env apex first, then the configured public web-server host. */
export async function resolvePlatformDefaultDomain(): Promise<string | null> {
	const fromEnv = getPlatformDefaultDomain();
	if (fromEnv) return fromEnv;
	const settings = await getWebServerSettings();
	return normalizeConfiguredPlatformApex(settings?.host ?? null);
}

export function canUsePlatformDomainForServer(
	serverId?: string | null,
	platformApex?: string | null,
) {
	if (!platformApex) return false;
	if (!serverId) return true;
	return true;
}

export function platformDomainWildcardDnsHint(
	platformApex: string,
	targetIp: string,
) {
	return `Point *.${platformApex} at ${targetIp} so app hostnames resolve and HTTPS can be issued. Keep ${platformApex} on the Nearzero host.`;
}

export function buildPlatformDefaultServiceHost(input: {
	serviceName: string;
	projectName: string;
	organizationId: string;
	environment: Pick<
		typeof environments.$inferSelect,
		"name" | "isDefault" | "domainPrefix"
	>;
}) {
	const configuredZone = getPlatformDefaultDomain();
	if (!configuredZone) {
		throw new Error("Platform default domain is not configured");
	}
	const zone = normalizeDnsZoneName(configuredZone);
	const service = slugifyServiceName(input.serviceName) || "service";
	const project = platformProjectScope(input.projectName, input.organizationId);
	const prefix = slugifyServiceName(input.environment.domainPrefix ?? "");
	if (prefix) {
		return `${service}.${prefix}.${project}.${zone}`;
	}
	if (isProductionEnvironment(input.environment)) {
		return `${service}.${project}.${zone}`;
	}
	const envLabel = slugifyServiceName(input.environment.name) || "env";
	return `${service}.${envLabel}.${project}.${zone}`;
}
