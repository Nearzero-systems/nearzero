export type InstallSetupResumeStep =
	| "welcome"
	| "management"
	| "zone"
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
	"verify",
	"done",
] as const;

export type InstallSetupWizardStep = (typeof INSTALL_SETUP_STEPS)[number];

export const INSTALL_SETUP_DRAFT_KEY = "nz-install-setup-draft";
export const INSTALL_SETUP_TOKEN_KEY = "nz-install-setup-token";

function isInstallSetupResumeStep(
	value: unknown,
): value is InstallSetupResumeStep {
	return (
		value === "welcome" ||
		value === "management" ||
		value === "zone" ||
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

export function resolveInstallSetupPath(
	status: PublicInstallSetupStatus | null,
): string | null {
	if (!status) return null;
	if (status.bootstrapClaimed || status.phase === "operational") {
		return "/login";
	}
	if (status.resumeStep === "login") return "/login";
	if (status.resumeStep === "register") return "/register";
	if (
		status.setupTokenConfigured &&
		!status.bootstrapClaimed &&
		(status.required ||
			status.resumeStep === "welcome" ||
			status.resumeStep === "management" ||
			status.resumeStep === "zone" ||
			status.resumeStep === "verify" ||
			status.resumeStep === "done")
	) {
		const step =
			status.resumeStep === "welcome" ||
			status.resumeStep === "management" ||
			status.resumeStep === "zone" ||
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

export function wizardStepsForStatus(status: PublicInstallSetupStatus) {
	const steps: InstallSetupWizardStep[] = ["welcome", "management"];
	if (status.managedDnsEnabled) steps.push("zone");
	steps.push("verify", "done");
	return steps;
}
