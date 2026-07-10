import { readFileSync } from "node:fs";
import { toConsoleCallbackUrl } from "../../../console/src/lib/auth-callback-url";
import { rewriteAuthRedirectLocation } from "../../../console/src/lib/auth-redirect";
import {
	getAuthOtpAccountError,
	resolveAuthOtpIntent,
} from "@nearzero/server/lib/auth-otp-intent";
import {
	resolveAuthPublicBaseUrl,
	resolveConsoleActionUrl,
	resolveConsoleUrl,
} from "@nearzero/server/lib/public-url";
import { describe, expect, it } from "vitest";

describe("OTP authentication intent", () => {
	it("defaults missing or invalid intent to login", () => {
		expect(resolveAuthOtpIntent(undefined)).toBe("login");
		expect(resolveAuthOtpIntent("unknown")).toBe("login");
		expect(resolveAuthOtpIntent("signup")).toBe("signup");
	});

	it("prevents login from creating accounts and signup from signing into them", () => {
		expect(getAuthOtpAccountError("login", false)).toBe(
			"No account exists for this email yet.",
		);
		expect(getAuthOtpAccountError("signup", true)).toBe(
			"An account already exists with this email. Log in instead.",
		);
		expect(getAuthOtpAccountError("login", true)).toBeNull();
		expect(getAuthOtpAccountError("signup", false)).toBeNull();
	});
});

describe("public console URLs", () => {
	it("uses CONSOLE_URL for production links", () => {
		const env = {
			NODE_ENV: "production",
			CONSOLE_URL: "https://app.nearzero.test/",
		};
		expect(resolveConsoleUrl(env)).toBe("https://app.nearzero.test");
		expect(
			resolveConsoleActionUrl(
				"http://platform:3000/api/auth/verify-email?token=abc",
				env,
			),
		).toBe("https://app.nearzero.test/api/auth/verify-email?token=abc");
	});

	it("fails closed when production has no public console URL", () => {
		expect(() => resolveConsoleUrl({ NODE_ENV: "production" })).toThrow(
			"CONSOLE_URL is required",
		);
	});

	it("uses CONSOLE_URL as auth base URL in split deploy", () => {
		expect(
			resolveAuthPublicBaseUrl({
				NODE_ENV: "production",
				CONSOLE_URL: "https://app.nearzero.test",
				BETTER_AUTH_URL: "https://api.nearzero.test",
			}),
		).toBe("https://app.nearzero.test");
	});

	it("falls back to BETTER_AUTH_URL when console and API share a host", () => {
		expect(
			resolveAuthPublicBaseUrl({
				NODE_ENV: "production",
				CONSOLE_URL: "https://nearzero.test",
				BETTER_AUTH_URL: "https://nearzero.test",
			}),
		).toBe("https://nearzero.test");
	});
});

describe("console auth callback URLs", () => {
	it("resolves relative dashboard paths to the console origin", () => {
		expect(
			toConsoleCallbackUrl(
				"/dashboard/agent",
				"https://app.nearzero.test",
			),
		).toBe("https://app.nearzero.test/dashboard/agent");
	});

	it("resolves invitation callbacks on the console origin", () => {
		expect(
			toConsoleCallbackUrl(
				"/invitation?token=abc123",
				"https://app.nearzero.test",
			),
		).toBe("https://app.nearzero.test/invitation?token=abc123");
	});

	it("resolves register onboarding callbacks on the console origin", () => {
		expect(
			toConsoleCallbackUrl(
				"/register?step=profile",
				"https://app.nearzero.test",
			),
		).toBe("https://app.nearzero.test/register?step=profile");
	});

	it("rejects external callback URLs", () => {
		expect(
			toConsoleCallbackUrl(
				"https://evil.test/steal",
				"https://app.nearzero.test",
			),
		).toBe("https://app.nearzero.test/dashboard/agent");
	});
});

describe("auth redirect rewriting", () => {
	it("rewrites API dashboard redirects to the console origin", () => {
		expect(
			rewriteAuthRedirectLocation(
				"https://api.nearzero.test/dashboard/agent",
				"https://app.nearzero.test",
				"https://api.nearzero.test",
			),
		).toBe("https://app.nearzero.test/dashboard/agent");
	});

	it("rewrites relative API redirects to the console origin", () => {
		expect(
			rewriteAuthRedirectLocation(
				"/register?step=profile",
				"https://app.nearzero.test",
				"https://api.nearzero.test",
			),
		).toBe("https://app.nearzero.test/register?step=profile");
	});
});

describe("console auth proxy contract", () => {
	it("sends invitation context and wires email/password auth", () => {
		const credentialsFlow = readFileSync(
			new URL("../../../console/src/scripts/auth-credentials-flow.ts", import.meta.url),
			"utf8",
		);
		const proxy = readFileSync(
			new URL("../../../console/src/lib/backendProxy.ts", import.meta.url),
			"utf8",
		);
		const sessionCookie = readFileSync(
			new URL("../../../console/src/lib/auth-session-cookie.ts", import.meta.url),
			"utf8",
		);
		const authRoute = readFileSync(
			new URL("../../server/routes/auth.ts", import.meta.url),
			"utf8",
		);
		const loginGrid = readFileSync(
			new URL("../../../console/src/components/auth/LoginGrid.astro", import.meta.url),
			"utf8",
		);
		const registerGrid = readFileSync(
			new URL("../../../console/src/components/auth/RegisterGrid.astro", import.meta.url),
			"utf8",
		);
		const invitationRoutes = readFileSync(
			new URL("../../../console/src/lib/invitation-routes.ts", import.meta.url),
			"utf8",
		);
		const authConfig = readFileSync(
			new URL("../../../../packages/server/src/lib/auth.ts", import.meta.url),
			"utf8",
		);

		expect(credentialsFlow).toContain("createNearzeroCredentialSession");
		expect(credentialsFlow).not.toContain("authClient.signIn.email");
		expect(credentialsFlow).toContain("authClient.signUp.email");
		expect(credentialsFlow).toContain("nearzero-adopt-credential");
		expect(credentialsFlow).toContain('credentialSession.code === "account_exists"');
		expect(credentialsFlow).toContain('credentialSession.code !== "no_account"');
		expect(credentialsFlow).toContain("x-nearzero-token");
		expect(authConfig).toContain("emailAndPassword");
		expect(authConfig).not.toContain("emailOTP");
		expect(authRoute).toContain("handleCredentialSession");
		expect(authRoute).toContain("verifyStoredPassword");
		expect(authRoute).toContain("bcrypt.compare");
		expect(authRoute).toContain("code: \"no_account\"");
		expect(authRoute).toContain("code: \"invalid_credentials\"");
		expect(proxy).toContain('request.headers.get("x-nearzero-token")');
		expect(proxy).toContain("/sign-in/email");
		expect(proxy).toContain("/nearzero-adopt-credential");
		expect(proxy).toContain("stripBrowserCredentials");
		expect(proxy).toContain("new URL(getBackendUpstreamUrl()).origin");
		expect(proxy).toContain("rewriteSetCookieForConsole");
		expect(proxy).toContain("buildConsoleSessionSetCookie(token, request.url)");
		expect(sessionCookie).toContain('protocol === "https:"');
		expect(loginGrid).toContain("bindAuthCredentialsFlow");
		expect(loginGrid).not.toContain("Terms of Service");
		expect(registerGrid).toContain("bindAuthCredentialsFlow");
		expect(registerGrid).not.toContain("Terms of Service");
		expect(invitationRoutes).toContain("loginPathForInvitation");
		expect(invitationRoutes).toContain("registerPathForInvitation");
	});
});
