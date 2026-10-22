import { randomBytes } from "node:crypto";
import { readSecret } from "../db/constants";

/** Development/test only. Never used when NODE_ENV is production. */
const DEVELOPMENT_SECRET = "better-auth-secret-123456789";

const { BETTER_AUTH_SECRET, BETTER_AUTH_SECRET_FILE } = process.env;

export function isBetterAuthSecretConfigured(): boolean {
	return Boolean(BETTER_AUTH_SECRET?.trim() || BETTER_AUTH_SECRET_FILE?.trim());
}

function resolveBetterAuthSecret(): string {
	if (BETTER_AUTH_SECRET) {
		return BETTER_AUTH_SECRET;
	}
	if (BETTER_AUTH_SECRET_FILE) {
		return readSecret(BETTER_AUTH_SECRET_FILE);
	}
	if (process.env.NODE_ENV === "production") {
		// Never fall back to a publicly known value: sessions, WebSocket tickets
		// and encrypted credentials signed with it could be forged or decrypted.
		// The platform refuses to start without a configured secret (see
		// assertBetterAuthSecretConfigured); processes that only import this
		// module, such as the schedules worker, get an ephemeral secret.
		return randomBytes(32).toString("hex");
	}
	return DEVELOPMENT_SECRET;
}

export const betterAuthSecret = resolveBetterAuthSecret();

/** Call at startup of any process that issues or verifies sessions. */
export function assertBetterAuthSecretConfigured() {
	if (process.env.NODE_ENV !== "production" || isBetterAuthSecretConfigured()) {
		return;
	}
	throw new Error(
		[
			"BETTER_AUTH_SECRET (or BETTER_AUTH_SECRET_FILE) is required in production.",
			"Generate one with `openssl rand -hex 32` and add it to /opt/nearzero/.env.",
			"If this install previously ran without a secret, re-encrypt existing 2FA secrets first:",
			"OLD_SECRET=better-auth-secret-123456789 NEW_SECRET=<new secret> bun run migrate-auth-secret",
		].join("\n"),
	);
}
