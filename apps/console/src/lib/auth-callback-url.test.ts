import { describe, expect, test } from "vitest";
import {
	DEFAULT_AUTH_CALLBACK_PATH,
	sanitizeAuthCallbackPath,
	toConsoleCallbackUrl,
} from "./auth-callback-url";
import { parseInvitationCallback } from "./invitation-routes";

const SITE = "https://app.nearzero.test";

describe("sanitizeAuthCallbackPath", () => {
	test("keeps dashboard and organization-scoped dashboard paths", () => {
		expect(
			sanitizeAuthCallbackPath("/dashboard/agent?setup=welcome#ready", SITE),
		).toBe("/dashboard/agent?setup=welcome#ready");
		expect(
			sanitizeAuthCallbackPath("/acme-team/dashboard/projects", SITE),
		).toBe("/acme-team/dashboard/projects");
	});

	test("keeps onboarding and tokenized invitation paths", () => {
		expect(sanitizeAuthCallbackPath("/register?step=profile", SITE)).toBe(
			"/register?step=profile",
		);
		expect(
			sanitizeAuthCallbackPath(
				"/invitation?token=abc123&email=user%40example.com",
				SITE,
			),
		).toBe("/invitation?token=abc123&email=user%40example.com");
	});

	test.each([
		"https://evil.test/steal",
		"//evil.test/steal",
		"javascript:alert(1)",
		"dashboard/agent",
		"/api/auth/get-session",
		"/login",
		"/dashboardish",
		"/api/dashboard/agent",
		"/nearzero/dashboard/agent",
		"/dashboard/../../api/auth/get-session",
		"/invitation",
	])("rejects an unsafe or unintended callback: %s", (callback) => {
		expect(sanitizeAuthCallbackPath(callback, SITE)).toBe(
			DEFAULT_AUTH_CALLBACK_PATH,
		);
	});

	test("rejects absolute URLs even when they use the console origin", () => {
		expect(sanitizeAuthCallbackPath(`${SITE}/dashboard/agent`, SITE)).toBe(
			DEFAULT_AUTH_CALLBACK_PATH,
		);
	});
});

describe("invitation callback parsing", () => {
	test("extracts a token only from a permitted local invitation callback", () => {
		expect(parseInvitationCallback("/invitation?token=abc123")).toBe("abc123");
		expect(
			parseInvitationCallback("https://evil.test/invitation?token=abc123"),
		).toBeNull();
		expect(
			parseInvitationCallback("//evil.test/invitation?token=abc123"),
		).toBeNull();
	});
});

describe("toConsoleCallbackUrl", () => {
	test("builds an absolute URL only from a permitted path", () => {
		expect(toConsoleCallbackUrl("/dashboard/agent", `${SITE}/`)).toBe(
			`${SITE}/dashboard/agent`,
		);
		expect(toConsoleCallbackUrl("/not-an-auth-destination", SITE)).toBe(
			`${SITE}${DEFAULT_AUTH_CALLBACK_PATH}`,
		);
	});
});
