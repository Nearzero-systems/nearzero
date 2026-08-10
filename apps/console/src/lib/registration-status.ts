export type PublicRegistrationStatus = {
	mode: "bootstrap" | "invite_only" | "open";
	normalSignupAllowed: boolean;
	bootstrapClaimed: boolean;
	adminEmailConfigured: boolean;
};

export type RegistrationExperience =
	| "open"
	| "bootstrap_owner"
	| "invitation_required";

function isPublicRegistrationStatus(
	value: unknown,
): value is PublicRegistrationStatus {
	if (!value || typeof value !== "object") return false;
	const status = value as Record<string, unknown>;
	return (
		(status.mode === "bootstrap" ||
			status.mode === "invite_only" ||
			status.mode === "open") &&
		typeof status.normalSignupAllowed === "boolean" &&
		typeof status.bootstrapClaimed === "boolean" &&
		typeof status.adminEmailConfigured === "boolean"
	);
}

export function resolveRegistrationExperience(
	status: PublicRegistrationStatus | null,
	hasInvitation: boolean,
): RegistrationExperience {
	// Invitation registration is authorized independently of ordinary signup.
	// Missing or malformed status is intentionally fail-open; the server still
	// enforces the registration policy when the form is submitted.
	if (hasInvitation || !status || status.mode === "open") return "open";
	if (
		status.mode === "bootstrap" &&
		!status.bootstrapClaimed &&
		status.normalSignupAllowed
	) {
		return "bootstrap_owner";
	}
	return "invitation_required";
}

export async function fetchRegistrationExperience(
	hasInvitation: boolean,
): Promise<RegistrationExperience> {
	if (hasInvitation) return "open";
	try {
		const response = await fetch("/api/auth/registration-status", {
			method: "GET",
			credentials: "same-origin",
			headers: { accept: "application/json" },
			cache: "no-store",
		});
		if (!response.ok) return "open";
		const value = (await response.json().catch(() => null)) as unknown;
		return resolveRegistrationExperience(
			isPublicRegistrationStatus(value) ? value : null,
			hasInvitation,
		);
	} catch {
		return "open";
	}
}
