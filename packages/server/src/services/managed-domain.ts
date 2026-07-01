import { getPlatformDefaultDomain } from "@nearzero/server/constants";
import { isProductionEnvironment } from "@nearzero/server/services/environment";
import type { environments } from "@nearzero/server/db/schema";

type EnvironmentDns = Pick<
	typeof environments.$inferSelect,
	"name" | "isDefault" | "domainPrefix"
> & { dnsZoneName?: string | null };

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
	const zone = input.zoneName.trim().toLowerCase().replace(/\.$/, "");
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
	const zone = input.zoneName.trim().toLowerCase().replace(/\.$/, "");
	const hash = slugifyServiceName(input.appName);
	if (zone.includes("sslip.io")) {
		const slugIp = input.targetIp.replaceAll(".", "-");
		return `*.${zone}`.replace("*", `${hash}${slugIp ? `-${slugIp}` : ""}`);
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
	return `pr-${pr}-${service}-${app}`;
}

export function buildPlatformDefaultPreviewHost(input: {
	previewSlug: string;
	projectName: string;
}) {
	const zone = getPlatformDefaultDomain();
	if (!zone) {
		throw new Error("Platform default domain is not configured");
	}
	const project = slugifyServiceName(input.projectName);
	return `${input.previewSlug}.preview.${project}.${zone}`;
}

export function isManagedWildcardZone(zoneName: string) {
	return zoneName.trim().startsWith("*.");
}

export function buildPlatformDefaultServiceHost(input: {
	serviceName: string;
	projectName: string;
	environment: Pick<
		typeof environments.$inferSelect,
		"name" | "isDefault" | "domainPrefix"
	>;
}) {
	const zone = getPlatformDefaultDomain();
	if (!zone) {
		throw new Error("Platform default domain is not configured");
	}
	const service = slugifyServiceName(input.serviceName) || "service";
	const project = slugifyServiceName(input.projectName) || "project";
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

export { getPlatformDefaultDomain };
