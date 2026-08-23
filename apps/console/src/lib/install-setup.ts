export type InstallSetupResumeStep =
	| "welcome"
	| "management"
	| "zone"
	| "review"
	| "verify"
	| "done"
	| "register"
	| "login";

export type PublicInstallSetupStatus = {
	required: boolean;
	phase: "pending" | "configured" | "claimed" | "operational";
	community: boolean;
	bootstrapClaimed: boolean;
	setupTokenConfigured: boolean;
	managementConfigured: boolean;
	managementHostname: string | null;
	adminEmailConfigured: boolean;
	publicIp: string | null;
	managedDnsEnabled: boolean;
	managedDnsConfigured: boolean;
	managedDnsZone: string | null;
	managedDnsSkipped: boolean;
	canSubmit: boolean;
	resumeStep: InstallSetupResumeStep;
};

export const INSTALL_SETUP_STEPS = [
	"welcome",
	"management",
	"zone",
	"review",
	"verify",
	"done",
] as const;

export type InstallSetupWizardStep = (typeof INSTALL_SETUP_STEPS)[number];

export const INSTALL_SETUP_DRAFT_KEY = "nz-install-setup-draft";
export const INSTALL_SETUP_TOKEN_KEY = "nz-install-setup-token";
export const INSTALL_SETUP_SESSION_COOKIE = "nearzero_install_setup_token";

export function isLoopbackHostname(hostname: string) {
	const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isInstallSetupResumeStep(
	value: unknown,
): value is InstallSetupResumeStep {
	return (
		value === "welcome" ||
		value === "management" ||
		value === "zone" ||
		value === "review" ||
		value === "verify" ||
		value === "done" ||
		value === "register" ||
		value === "login"
	);
}

export function isPublicInstallSetupStatus(
	value: unknown,
): value is PublicInstallSetupStatus {
	if (!value || typeof value !== "object") return false;
	const status = value as Record<string, unknown>;
	return (
		typeof status.required === "boolean" &&
		typeof status.community === "boolean" &&
		typeof status.bootstrapClaimed === "boolean" &&
		typeof status.setupTokenConfigured === "boolean" &&
		typeof status.managementConfigured === "boolean" &&
		typeof status.canSubmit === "boolean" &&
		isInstallSetupResumeStep(status.resumeStep)
	);
}

export function parseInstallSetupStep(
	value: string | null | undefined,
): InstallSetupWizardStep | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	return (INSTALL_SETUP_STEPS as readonly string[]).includes(normalized)
		? (normalized as InstallSetupWizardStep)
		: null;
}

export function isInstallSetupPageOpen(
	status: PublicInstallSetupStatus | null,
): boolean {
	if (!status?.setupTokenConfigured || status.bootstrapClaimed) return false;
	if (
		status.phase === "configured" ||
		status.phase === "claimed" ||
		status.phase === "operational"
	) {
		return false;
	}
	return status.phase === "pending";
}

export function resolveInstallSetupPath(
	status: PublicInstallSetupStatus | null,
): string | null {
	if (!status) return null;
	if (
		status.bootstrapClaimed ||
		status.phase === "operational" ||
		status.phase === "claimed"
	) {
		return "/login";
	}
	if (status.resumeStep === "login") return "/login";
	if (!isInstallSetupPageOpen(status) || status.resumeStep === "register") {
		return "/register";
	}
	if (
		status.setupTokenConfigured &&
		!status.bootstrapClaimed &&
		(status.required ||
			status.resumeStep === "welcome" ||
			status.resumeStep === "management" ||
			status.resumeStep === "zone" ||
			status.resumeStep === "review" ||
			status.resumeStep === "verify" ||
			status.resumeStep === "done")
	) {
		const step =
			status.resumeStep === "welcome" ||
			status.resumeStep === "management" ||
			status.resumeStep === "zone" ||
			status.resumeStep === "review" ||
			status.resumeStep === "verify" ||
			status.resumeStep === "done"
				? status.resumeStep
				: "welcome";
		return `/setup?step=${step}`;
	}
	return null;
}

export async function fetchInstallSetupStatus(
	fetchImpl: typeof fetch = fetch,
): Promise<PublicInstallSetupStatus | null> {
	try {
		const response = await fetchImpl("/api/install/setup-status", {
			method: "GET",
			credentials: "same-origin",
			headers: { accept: "application/json" },
			cache: "no-store",
		});
		if (!response.ok) return null;
		const value = (await response.json().catch(() => null)) as unknown;
		return isPublicInstallSetupStatus(value) ? value : null;
	} catch {
		return null;
	}
}

export function extractSetupTokenFromHash(hash: string) {
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw) return null;
	const params = new URLSearchParams(raw);
	const token = params.get("token")?.trim();
	return token || null;
}

export function extractSetupToken(value: string) {
	const raw = value.trim();
	if (!raw) return null;
	if (/^[A-Za-z0-9_-]{16,256}$/.test(raw)) return raw;

	try {
		if (
			raw.includes("://") ||
			raw.startsWith("/") ||
			raw.startsWith("?") ||
			raw.startsWith("#")
		) {
			const url = new URL(raw, "http://nearzero.local/setup");
			const fromHash = extractSetupTokenFromHash(url.hash);
			if (fromHash) return fromHash;
			const fromQuery = url.searchParams.get("token")?.trim();
			if (fromQuery) return fromQuery;
		}
	} catch {
		// Fall through to the token= fragment parser below.
	}

	if (raw.includes("token=")) {
		const query = raw.includes("#")
			? raw.slice(raw.indexOf("#") + 1)
			: raw.startsWith("?")
				? raw.slice(1)
				: raw;
		const token = new URLSearchParams(query).get("token")?.trim();
		if (token) return token;
	}

	return null;
}

export function wizardStepsForStatus(status: PublicInstallSetupStatus) {
	const steps: InstallSetupWizardStep[] = ["welcome", "management"];
	if (status.managedDnsEnabled) steps.push("zone");
	steps.push("review", "verify", "done");
	return steps;
}

export type SetupCheckState =
	| "not_applicable"
	| "pending"
	| "ready"
	| "warning"
	| "failed";

export type PublicInstallSetupReadiness = {
	ready: boolean;
	checkedAt: string;
	configuration: {
		managementHostname: string | null;
		adminEmail: string | null;
		publicIp: string | null;
		managedDnsZone: string | null;
		managedDnsSoaEmail: string | null;
		managedDnsEnabled: boolean;
		lockedFields: {
			managementHostname: boolean;
			adminEmail: boolean;
			publicIp: boolean;
			managedDnsZone: boolean;
			managedDnsSoaEmail: boolean;
			managedDnsEnabled: boolean;
		};
	};
	management: {
		hostname: string | null;
		expectedAddresses: string[];
		observedAddresses: string[];
		ready: boolean;
		aRecord: {
			status: "not_configured" | "pending" | "ready";
			code: string;
			matches: boolean;
			diagnostic: string;
		};
		https: {
			status: "pending" | "ready" | "failed";
			code: string;
			diagnostic: string;
		};
	};
	managedDns: {
		enabled: boolean;
		skipped: boolean;
		zoneName: string | null;
		status: "not_configured" | "skipped" | "pending" | "ready";
		code: string;
		expectedNameservers: string[];
		observedNameservers: string[];
		delegated: boolean;
		authoritativeSoa: boolean;
		ready: boolean;
		diagnostics: string[];
	};
};

export function normalizeBaseDomainInput(value: string) {
	const normalized = value.trim().toLowerCase().replace(/\.$/, "");
	if (
		!normalized ||
		normalized.includes("://") ||
		normalized.includes("/") ||
		normalized.includes(":") ||
		!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
			normalized,
		)
	) {
		return null;
	}
	return normalized;
}

function ipv4ToInteger(value: string) {
	return (
		value
			.split(".")
			.map(Number)
			.reduce((result, octet) => result * 256 + octet, 0) >>> 0
	);
}

function isInIpv4Cidr(value: string, network: string, prefix: number) {
	const address = ipv4ToInteger(value);
	const base = ipv4ToInteger(network);
	const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
	return (address & mask) === (base & mask);
}

const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
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

export function isPublicIpv4Input(value: string) {
	const normalized = value.trim();
	const parts = normalized.split(".");
	if (
		parts.length !== 4 ||
		parts.some(
			(part) =>
				!/^\d{1,3}$/.test(part) ||
				(part.length > 1 && part.startsWith("0")) ||
				Number(part) > 255,
		)
	) {
		return false;
	}
	return !NON_PUBLIC_IPV4_RANGES.some(([network, prefix]) =>
		isInIpv4Cidr(normalized, network, prefix),
	);
}

export function suggestInstallDomains(value: string) {
	const baseDomain = normalizeBaseDomainInput(value);
	if (!baseDomain) return null;
	return {
		baseDomain,
		managementHostname: `nearzero.${baseDomain}`,
		managedDnsZone: `apps.${baseDomain}`,
	};
}

export function inferInstallBaseDomain(status: PublicInstallSetupStatus) {
	const candidate = status.managedDnsZone || status.managementHostname;
	if (!candidate) return "";
	const labels = candidate.replace(/\.$/, "").split(".");
	return labels.length > 2 ? labels.slice(1).join(".") : candidate;
}

export function isPublicInstallSetupReadiness(
	value: unknown,
): value is PublicInstallSetupReadiness {
	if (!value || typeof value !== "object") return false;
	const readiness = value as Record<string, unknown>;
	return (
		typeof readiness.ready === "boolean" &&
		typeof readiness.checkedAt === "string" &&
		typeof readiness.configuration === "object" &&
		readiness.configuration !== null &&
		typeof readiness.management === "object" &&
		readiness.management !== null &&
		typeof readiness.managedDns === "object" &&
		readiness.managedDns !== null
	);
}
