export const AUTH_OTP_INTENT_HEADER = "x-nearzero-auth-intent";

export type AuthOtpIntent = "login" | "signup";

export function resolveAuthOtpIntent(
	value: string | null | undefined,
): AuthOtpIntent {
	return value === "signup" ? "signup" : "login";
}

export function getAuthOtpAccountError(
	intent: AuthOtpIntent,
	accountExists: boolean,
): string | null {
	if (intent === "login" && !accountExists) {
		return "No account exists for this email yet.";
	}
	if (intent === "signup" && accountExists) {
		return "An account already exists with this email. Log in instead.";
	}
	return null;
}
