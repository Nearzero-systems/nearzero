import { isCommunityMode } from "../services/runtime-mode";
import { isValidAuthEmail, normalizeAuthEmail } from "./auth-email-policy";

export const REGISTRATION_MODES = ["bootstrap", "invite_only", "open"] as const;

export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export type RegistrationPolicy = {
	mode: RegistrationMode;
	adminEmail: string | null;
};

type RegistrationPolicyEnvironment = Record<string, string | undefined>;

export type RegistrationDecision =
	| {
			allowed: true;
			reason: "bootstrap_admin" | "invitation" | "open";
	  }
	| {
			allowed: false;
			reason: "bootstrap_admin_only" | "invite_only";
	  };

export type PublicRegistrationStatus = {
	mode: RegistrationMode;
	normalSignupAllowed: boolean;
	bootstrapClaimed: boolean;
	adminEmailConfigured: boolean;
};

function isRegistrationMode(value: string): value is RegistrationMode {
	return (REGISTRATION_MODES as readonly string[]).includes(value);
}

export function resolveRegistrationPolicy(
	env: RegistrationPolicyEnvironment = process.env,
	communityMode = isCommunityMode(),
): RegistrationPolicy {
	const configuredMode = env.NEARZERO_REGISTRATION_MODE?.trim().toLowerCase();
	let mode: RegistrationMode;
	if (configuredMode) {
		if (!isRegistrationMode(configuredMode)) {
			throw new Error(
				`NEARZERO_REGISTRATION_MODE must be one of: ${REGISTRATION_MODES.join(", ")}`,
			);
		}
		mode = configuredMode;
	} else {
		mode =
			env.NODE_ENV === "production" && communityMode ? "bootstrap" : "open";
	}
	const configuredAdminEmail = normalizeAuthEmail(
		env.NEARZERO_ADMIN_EMAIL ?? "",
	);

	// Bootstrap may start without NEARZERO_ADMIN_EMAIL when the browser wizard
	// will persist the admin email into install_setup. Signup still requires a
	// concrete admin email via getEffectiveRegistrationPolicy().
	if (
		mode === "bootstrap" &&
		configuredAdminEmail &&
		!isValidAuthEmail(configuredAdminEmail)
	) {
		throw new Error(
			"NEARZERO_ADMIN_EMAIL must be a valid email address when NEARZERO_REGISTRATION_MODE=bootstrap",
		);
	}

	return {
		mode,
		adminEmail: configuredAdminEmail || null,
	};
}

/**
 * Merge env policy with a wizard-persisted admin email. Prefer env when set.
 */
export function mergeRegistrationPolicyAdminEmail(
	policy: RegistrationPolicy,
	setupAdminEmail: string | null | undefined,
): RegistrationPolicy {
	if (policy.adminEmail) return policy;
	const fromSetup = normalizeAuthEmail(setupAdminEmail ?? "");
	if (!isValidAuthEmail(fromSetup)) return policy;
	return { ...policy, adminEmail: fromSetup };
}

export function decideRegistration(input: {
	policy: RegistrationPolicy;
	email: string;
	hasValidInvitation: boolean;
	bootstrapClaimed: boolean;
}): RegistrationDecision {
	if (input.hasValidInvitation) {
		return { allowed: true, reason: "invitation" };
	}

	if (input.policy.mode === "open") {
		return { allowed: true, reason: "open" };
	}

	if (input.policy.mode === "invite_only" || input.bootstrapClaimed) {
		return { allowed: false, reason: "invite_only" };
	}

	if (
		!input.policy.adminEmail ||
		normalizeAuthEmail(input.email) !== input.policy.adminEmail
	) {
		return { allowed: false, reason: "bootstrap_admin_only" };
	}

	return { allowed: true, reason: "bootstrap_admin" };
}

export function registrationDecisionMessage(
	decision: RegistrationDecision,
): string | null {
	if (decision.allowed) return null;
	if (decision.reason === "bootstrap_admin_only") {
		return "Registration is limited to the configured bootstrap administrator.";
	}
	return "Registration is invite-only on this Nearzero installation.";
}

export function buildPublicRegistrationStatus(
	policy: RegistrationPolicy,
	bootstrapClaimed: boolean,
): PublicRegistrationStatus {
	return {
		mode: policy.mode,
		normalSignupAllowed:
			policy.mode === "open" ||
			(policy.mode === "bootstrap" && !bootstrapClaimed),
		bootstrapClaimed: policy.mode === "bootstrap" && bootstrapClaimed,
		adminEmailConfigured:
			policy.mode === "bootstrap" && Boolean(policy.adminEmail),
	};
}
