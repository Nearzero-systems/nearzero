import { describe, expect, it } from "vitest";
import { shouldRelayUpstreamCookies } from "./backendProxy";

describe("backend proxy cookie relay", () => {
	it("relays Better Auth cookies", () => {
		expect(shouldRelayUpstreamCookies("/api/auth/sign-in/email")).toBe(true);
	});

	it("relays only the install setup session cookie", () => {
		expect(shouldRelayUpstreamCookies("/api/install/setup/session")).toBe(true);
		expect(
			shouldRelayUpstreamCookies("/api/install/setup/session?source=wizard"),
		).toBe(true);
		expect(shouldRelayUpstreamCookies("/api/install/setup/readiness")).toBe(
			false,
		);
	});

	it("does not relay arbitrary backend cookies", () => {
		expect(shouldRelayUpstreamCookies("/api/health")).toBe(false);
		expect(shouldRelayUpstreamCookies("/api/providers/github")).toBe(false);
	});
});
