import { trpcMutate, trpcQuery } from "@/lib/client-api";

export type ServiceDomainMode =
	| "org-zone"
	| "platform"
	| "preview"
	| "byod"
	| "none";

export type PreviewServiceDomainResult = {
	mode: ServiceDomainMode;
	enabled: boolean;
	host: string | null;
	targetIp: string | null;
	ipSource: "webServer" | "remoteServer" | null;
	zoneName: string | null;
	platformApex: string | null;
	visitUrl: string | null;
	warnings: string[];
};

export type ProvisionedDomain = {
	domainId: string;
	host: string;
	https: boolean;
	port: number | null;
	path: string | null;
};

export async function previewServiceDomain(input: {
	environmentId: string;
	serviceName: string;
	serverId?: string | null;
}): Promise<PreviewServiceDomainResult> {
	return trpcQuery<PreviewServiceDomainResult>(
		"domain.previewServiceDomain",
		input,
	);
}

export async function provisionServiceDomain(input: {
	environmentId: string;
	serviceName: string;
	port: number;
	serverId?: string | null;
	path?: string;
	domainType: "application" | "compose";
	applicationId?: string;
	composeId?: string;
}): Promise<ProvisionedDomain> {
	return trpcMutate<ProvisionedDomain>("domain.provisionServiceDomain", input);
}

export async function fetchManagedDnsReadiness() {
	return trpcQuery<{
		platformApex: string | null;
		platformDefaultEnabled: boolean;
		webServerIp: string | null;
		zones: Array<{ name: string; status: string; recordCount: number }>;
	}>("dns.readiness");
}

export async function validateDomainWithEdgeIp(input: {
	domain: string;
	serverId?: string | null;
}): Promise<{
	isValid: boolean;
	resolvedIp?: string;
	error?: string;
	isCloudflare?: boolean;
	cdnProvider?: string;
}> {
	const serverIp = await trpcQuery<string>("domain.canGenerateTraefikMeDomains", {
		serverId: input.serverId ?? undefined,
	});
	return trpcMutate("domain.validateDomain", {
		domain: input.domain,
		serverIp: serverIp || undefined,
	});
}
