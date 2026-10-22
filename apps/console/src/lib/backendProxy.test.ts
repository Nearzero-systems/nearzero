import { describe, expect, it } from "vitest";
import { shouldRelayUpstreamCookies } from "./backendProxy";

describe("backend proxy cookie relay", () => {
	it("relays Better Auth cookies", () => {
		expect(shouldRelayUpstreamCookies("/api/auth/sign-in/email")).toBe(true);
	});

	it("does not relay arbitrary backend cookies", () => {
		expect(shouldRelayUpstreamCookies("/api/health")).toBe(false);
		expect(shouldRelayUpstreamCookies("/api/install/status")).toBe(false);
		expect(shouldRelayUpstreamCookies("/api/providers/github")).toBe(false);
	});
});
