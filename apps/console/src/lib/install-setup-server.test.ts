import { describe, expect, it } from "vitest";
import { resolveLoopbackInstallSetupToken } from "./install-setup-server";

describe("loopback install setup token", () => {
	it("prefers the plaintext env token", () => {
		expect(
			resolveLoopbackInstallSetupToken({
				NEARZERO_INSTALL_SETUP_TOKEN: "setup-token-value-1234",
			}),
		).toBe("setup-token-value-1234");
	});

	it("reads a token out of the installer URL env", () => {
		expect(
			resolveLoopbackInstallSetupToken({
				NEARZERO_INSTALL_SETUP_URL:
					"http://127.0.0.1:4321/setup#token=setup-token-value-1234",
			}),
		).toBe("setup-token-value-1234");
	});
});
