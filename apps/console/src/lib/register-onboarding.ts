export type RegisterStep =
	| "signup"
	| "verify"
	| "profile"
	| "role"
	| "workspace"
	| "invite";

export const REGISTER_ONBOARDING_STEPS: RegisterStep[] = [
	"profile",
	"role",
	"workspace",
	"invite",
];

export const REGISTER_ONBOARDING_STEP_SET = new Set<RegisterStep>(
	REGISTER_ONBOARDING_STEPS,
);

export function isOnboardingRegisterStep(step: RegisterStep) {
	return REGISTER_ONBOARDING_STEP_SET.has(step);
}

export const ROLE_OPTIONS = [
	"Enterprise / Mid-Market",
	"Startup / SMB",
	"Solo developer",
	"Agency / consultant",
	"Open source / hobby",
	"Other",
] as const;

export const ON_PREM_OPTIONS = ["Yes", "No", "Not sure yet"] as const;

export const MONTHLY_CALL_VOLUME_OPTIONS = [
	"Under 10",
	"10 - 100",
	"100 - 1,000",
	"1,000+",
	"Not sure yet",
] as const;

export const MIGRATION_OPTIONS = [
	"No",
	"Coolify",
	"Railway",
	"Render",
	"Vercel",
	"Heroku",
	"Other",
] as const;

export const HEARD_ABOUT_OPTIONS = [
	"Search engine",
	"Social media",
	"Friend or colleague",
	"GitHub / open source",
	"Conference or event",
	"Other",
] as const;

export type OnboardingDraft = {
	heardAbout: string;
	role: string;
	needsOnPrem: string;
	monthlyCallVolume: string;
	migratingFromProvider: string;
	workspaceMode: "organization" | "solo";
	organizationName: string;
	firstName: string;
	workspaceName: string;
	inviteEmails: string[];
};

export function parseRegisterStep(
	raw: string | null | undefined,
): RegisterStep {
	const value = String(raw || "")
		.trim()
		.toLowerCase();
	if (
		value === "verify" ||
		value === "profile" ||
		value === "source" ||
		value === "role" ||
		value === "workspace" ||
		value === "invite"
	) {
		return value === "source" ? "profile" : (value as RegisterStep);
	}
	return "signup";
}

export function registerStepPath(
	step: RegisterStep,
	basePath = "/register",
	extraParams?: Record<string, string | undefined>,
) {
	if (step === "signup") {
		const url = new URL(basePath, "http://local");
		for (const [key, value] of Object.entries(extraParams ?? {})) {
			if (value) url.searchParams.set(key, value);
		}
		const search = url.searchParams.toString();
		return search ? `${url.pathname}?${search}` : url.pathname;
	}
	const url = new URL(basePath, "http://local");
	url.searchParams.set("step", step);
	for (const [key, value] of Object.entries(extraParams ?? {})) {
		if (value) url.searchParams.set(key, value);
	}
	return `${url.pathname}${url.search}`;
}

export const REGISTER_ONBOARDING_START_PATH = registerStepPath("profile");

export function stepTitle(step: RegisterStep) {
	switch (step) {
		case "verify":
			return "Verify your email";
		case "profile":
			return "Set up your organization";
		case "role":
			return "Tell us about your setup";
		case "workspace":
			return "How did you hear about us?";
		case "invite":
			return "Invite your team";
		default:
			return "Welcome to Nearzero";
	}
}

export function stepSubtitle(step: RegisterStep) {
	switch (step) {
		case "verify":
			return "Enter the one-time code we sent to your email.";
		case "profile":
			return "Enter your name and organization name to get started.";
		case "role":
			return "A few quick questions so Nearzero can tailor your workspace.";
		case "workspace":
			return "This helps us understand how teams discover Nearzero.";
		case "invite":
			return "Bring teammates now, or skip and invite later from Settings.";
		default:
			return "";
	}
}

export function emptyOnboardingDraft(): OnboardingDraft {
	return {
		heardAbout: "",
		role: "",
		needsOnPrem: "",
		monthlyCallVolume: "",
		migratingFromProvider: "",
		workspaceMode: "organization",
		organizationName: "",
		firstName: "",
		workspaceName: "",
		inviteEmails: [],
	};
}

const DRAFT_KEY = "nz-register-onboarding-draft";

export function loadOnboardingDraft(): OnboardingDraft {
	try {
		const raw = sessionStorage.getItem(DRAFT_KEY);
		if (!raw) return emptyOnboardingDraft();
		const parsed = JSON.parse(raw) as Partial<OnboardingDraft>;
		return { ...emptyOnboardingDraft(), ...parsed };
	} catch {
		return emptyOnboardingDraft();
	}
}

export function saveOnboardingDraft(draft: OnboardingDraft) {
	sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function clearOnboardingDraft() {
	sessionStorage.removeItem(DRAFT_KEY);
}

export function parseInviteEmails(raw: string): string[] {
	return raw
		.split(/[\n,;]+/)
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
}
