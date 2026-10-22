import { isCommunityMode } from "../services/runtime-mode";

export const REGISTRATION_MODES = ["bootstrap", "invite_only", "open"] as const;

export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export type RegistrationPolicy = {
	mode: RegistrationMode;
};

type RegistrationPolicyEnvironment = Record<string, string | undefined>;

export type RegistrationDecision =
	| {
			allowed: true;
			reason: "invitation" | "open";
	  }
	| {
			allowed: false;
			reason: "owner_required" | "invite_only";
	  };

export type PublicRegistrationStatus = {
	mode: RegistrationMode;
	normalSignupAllowed: boolean;
	/** True once an owner account exists on this installation. */
	ownerExists: boolean;
};

/** The only way to create the first owner of a self-hosted install. */
export const CREATE_OWNER_COMMAND = "sudo nearzero create-owner";

function isRegistrationMode(value: string): value is RegistrationMode {
	return (REGISTRATION_MODES as readonly string[]).includes(value);
}

export function resolveRegistrationPolicy(
	env: RegistrationPolicyEnvironment = process.env,
	communityMode = isCommunityMode(),
): RegistrationPolicy {
	const configuredMode = env.NEARZERO_REGISTRATION_MODE?.trim().toLowerCase();
	if (configuredMode) {
		if (!isRegistrationMode(configuredMode)) {
			throw new Error(
				`NEARZERO_REGISTRATION_MODE must be one of: ${REGISTRATION_MODES.join(", ")}`,
			);
		}
		return { mode: configuredMode };
	}
	return {
		mode: env.NODE_ENV === "production" && communityMode ? "bootstrap" : "open",
	};
}

/**
 * Bootstrap installs never create accounts from the web without an invitation:
 * the first owner is created on the server, and everyone else is invited.
 */
export function decideRegistration(input: {
	policy: RegistrationPolicy;
	hasValidInvitation: boolean;
	ownerExists: boolean;
}): RegistrationDecision {
	if (input.hasValidInvitation) {
		return { allowed: true, reason: "invitation" };
	}
	if (input.policy.mode === "open") {
		return { allowed: true, reason: "open" };
	}
	if (input.policy.mode === "bootstrap" && !input.ownerExists) {
		return { allowed: false, reason: "owner_required" };
	}
	return { allowed: false, reason: "invite_only" };
}

export function registrationDecisionMessage(
	decision: RegistrationDecision,
): string | null {
	if (decision.allowed) return null;
	if (decision.reason === "owner_required") {
		return `This server has no owner account yet. Create it on the server with: ${CREATE_OWNER_COMMAND}`;
	}
	return "Registration is invite-only on this Nearzero installation. Ask a workspace owner for an invitation.";
}

export function buildPublicRegistrationStatus(
	policy: RegistrationPolicy,
	ownerExists: boolean,
): PublicRegistrationStatus {
	return {
		mode: policy.mode,
		normalSignupAllowed: policy.mode === "open",
		ownerExists,
	};
}
