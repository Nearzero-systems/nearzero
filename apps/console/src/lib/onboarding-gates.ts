import {
	isOnboardingRegisterStep,
	parseRegisterStep,
	registerStepPath,
	type RegisterStep,
} from "./register-onboarding";

export type OnboardingGateStatus = {
	complete: boolean;
	profileComplete: boolean;
	pendingInvitationId?: string | null;
	needsWorkspaceSetup?: boolean;
	needsInviteMemberSetup?: boolean;
	inviteMemberProfileComplete?: boolean;
};

export const REGISTER_ONBOARDING_VERIFY_STEPS = new Set<RegisterStep>([
	"verify",
	"profile",
	"role",
	"workspace",
	"invite",
]);

const INVITE_MEMBER_MODE = "invite-member";

export function invitationPathFromToken(token: string) {
	return `/invitation?token=${encodeURIComponent(token)}`;
}

export function workspaceSetupPath() {
	return "/register?step=profile&mode=workspace-setup";
}

export function inviteMemberSetupPath(step: RegisterStep = "profile") {
	return registerStepPath(step, "/register", { mode: INVITE_MEMBER_MODE });
}

export function isWorkspaceSetupMode(url: URL | string) {
	const searchParams =
		typeof url === "string"
			? new URL(url, "http://local").searchParams
			: url.searchParams;
	return searchParams.get("mode") === "workspace-setup";
}

export function isInviteMemberSetupMode(url: URL | string) {
	const searchParams =
		typeof url === "string"
			? new URL(url, "http://local").searchParams
			: url.searchParams;
	return searchParams.get("mode") === INVITE_MEMBER_MODE;
}

export function registerOnboardingResumePath(
	status: Pick<
		OnboardingGateStatus,
		| "profileComplete"
		| "pendingInvitationId"
		| "needsWorkspaceSetup"
		| "needsInviteMemberSetup"
		| "inviteMemberProfileComplete"
	>,
) {
	if (status.pendingInvitationId) {
		return invitationPathFromToken(status.pendingInvitationId);
	}
	if (status.needsWorkspaceSetup) {
		return workspaceSetupPath();
	}
	if (status.needsInviteMemberSetup) {
		return status.inviteMemberProfileComplete
			? inviteMemberSetupPath("role")
			: inviteMemberSetupPath("profile");
	}
	return status.profileComplete
		? registerStepPath("role")
		: registerStepPath("profile");
}

export function registerStepFromUrl(url: URL) {
	return parseRegisterStep(url.searchParams.get("step"));
}

/** Logged-in users with incomplete onboarding must stay on /register onboarding steps. */
export function registerPathForSession(
	step: RegisterStep,
	status: OnboardingGateStatus | null,
	options?: {
		invitationToken?: string | null;
		workspaceSetupMode?: boolean;
		inviteMemberSetupMode?: boolean;
	},
) {
	if (status?.needsWorkspaceSetup) {
		if (step === "signup" || step === "verify") {
			return workspaceSetupPath();
		}
		if (step === "profile" && options?.workspaceSetupMode) {
			return null;
		}
		return workspaceSetupPath();
	}

	if (status?.needsInviteMemberSetup) {
		if (step === "signup" || step === "verify") {
			return registerOnboardingResumePath(status);
		}
		if (step === "invite") {
			return inviteMemberSetupPath("workspace");
		}
		if (options?.inviteMemberSetupMode) {
			if (!status.inviteMemberProfileComplete && step !== "profile") {
				return inviteMemberSetupPath("profile");
			}
			if (status.inviteMemberProfileComplete && step === "profile") {
				return inviteMemberSetupPath("role");
			}
			return null;
		}
		return registerOnboardingResumePath(status);
	}

	const inviteToken =
		options?.invitationToken?.trim() || status?.pendingInvitationId?.trim();
	if (inviteToken) {
		return invitationPathFromToken(inviteToken);
	}

	if (status?.complete === true) {
		return "/dashboard/agent";
	}
	if (status?.complete === false) {
		if (step === "verify") {
			return registerOnboardingResumePath(status);
		}
		if (isOnboardingRegisterStep(step)) {
			if (status.profileComplete === false && step !== "profile") {
				return registerStepPath("profile");
			}
			return null;
		}
		return registerOnboardingResumePath(status);
	}
	return null;
}
