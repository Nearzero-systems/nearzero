export type PublicRegistrationStatus = {
	mode: "bootstrap" | "invite_only" | "open";
	normalSignupAllowed: boolean;
	ownerExists: boolean;
};

/**
 * - open: anyone can create an account.
 * - owner_required: nobody owns this server yet; the owner is created on the
 *   server with `sudo nearzero create-owner`, never from the web.
 * - invitation_required: accounts are created from invitation links only.
 */
export type RegistrationExperience =
	| "open"
	| "owner_required"
	| "invitation_required";

export const CREATE_OWNER_COMMAND = "sudo nearzero create-owner";

export function isPublicRegistrationStatus(
	value: unknown,
): value is PublicRegistrationStatus {
	if (!value || typeof value !== "object") return false;
	const status = value as Record<string, unknown>;
	return (
		(status.mode === "bootstrap" ||
			status.mode === "invite_only" ||
			status.mode === "open") &&
		typeof status.normalSignupAllowed === "boolean" &&
		typeof status.ownerExists === "boolean"
	);
}

export function resolveRegistrationExperience(
	status: PublicRegistrationStatus | null,
	hasInvitation: boolean,
): RegistrationExperience {
	// Invitation registration is authorized independently of ordinary signup.
	// Missing or malformed status is intentionally fail-open; the server still
	// enforces the registration policy when the form is submitted.
	if (hasInvitation || !status || status.normalSignupAllowed) return "open";
	return status.ownerExists ? "invitation_required" : "owner_required";
}

export async function fetchRegistrationStatus(): Promise<PublicRegistrationStatus | null> {
	try {
		const response = await fetch("/api/auth/registration-status", {
			method: "GET",
			credentials: "same-origin",
			headers: { accept: "application/json" },
			cache: "no-store",
		});
		if (!response.ok) return null;
		const value = (await response.json().catch(() => null)) as unknown;
		return isPublicRegistrationStatus(value) ? value : null;
	} catch {
		return null;
	}
}

export async function fetchRegistrationExperience(
	hasInvitation: boolean,
): Promise<RegistrationExperience> {
	if (hasInvitation) return "open";
	return resolveRegistrationExperience(
		await fetchRegistrationStatus(),
		hasInvitation,
	);
}
