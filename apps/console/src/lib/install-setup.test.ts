import { describe, expect, it } from "vitest";
import {
	extractSetupToken,
	extractSetupTokenFromHash,
	isInstallSetupPageOpen,
	isLoopbackHostname,
	inferInstallBaseDomain,
	isPublicIpv4Input,
	normalizeBaseDomainInput,
	type PublicInstallSetupStatus,
	parseInstallSetupStep,
	resolveInstallSetupPath,
	suggestInstallDomains,
	wizardStepsForStatus,
} from "./install-setup";

function status(
	overrides: Partial<PublicInstallSetupStatus> = {},
): PublicInstallSetupStatus {
	return {
		required: true,
		phase: "pending",
		community: true,
		bootstrapClaimed: false,
		setupTokenConfigured: true,
		managementConfigured: false,
		managementHostname: null,
		adminEmailConfigured: false,
		publicIp: "8.8.8.8",
		managedDnsEnabled: true,
		managedDnsConfigured: false,
		managedDnsZone: null,
		managedDnsSkipped: false,
		canSubmit: true,
		resumeStep: "welcome",
		...overrides,
	};
}

describe("install setup console helpers", () => {
	it("resolves wizard paths for fresh installs", () => {
		expect(resolveInstallSetupPath(status())).toBe("/setup?step=welcome");
		expect(
			resolveInstallSetupPath(
				status({
					resumeStep: "management",
					phase: "pending",
				}),
			),
		).toBe("/setup?step=management");
		expect(
			resolveInstallSetupPath(
				status({
					managementConfigured: true,
					adminEmailConfigured: true,
					phase: "configured",
					canSubmit: false,
					required: false,
					resumeStep: "register",
				}),
			),
		).toBe("/register");
		expect(
			isInstallSetupPageOpen(
				status({
					managementConfigured: true,
					adminEmailConfigured: true,
					phase: "configured",
					canSubmit: false,
					required: false,
					resumeStep: "register",
				}),
			),
		).toBe(false);
		expect(
			resolveInstallSetupPath(
				status({
					managementConfigured: true,
					adminEmailConfigured: true,
					phase: "configured",
					canSubmit: false,
					required: false,
					resumeStep: "verify",
				}),
			),
		).toBe("/register");
	});

	it("sends claimed installs to login", () => {
		expect(
			resolveInstallSetupPath(
				status({
					bootstrapClaimed: true,
					phase: "operational",
					resumeStep: "login",
					required: false,
					canSubmit: false,
				}),
			),
		).toBe("/login");
	});

	it("treats loopback hosts as local setup", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("nearzero.example.com")).toBe(false);
	});

	it("parses wizard steps and hash tokens", () => {
		expect(parseInstallSetupStep("Management")).toBe("management");
		expect(parseInstallSetupStep("review")).toBe("review");
		expect(parseInstallSetupStep("nope")).toBeNull();
		expect(extractSetupTokenFromHash("#token=abc123")).toBe("abc123");
		expect(extractSetupTokenFromHash("#other=1")).toBeNull();
		expect(
			extractSetupToken(
				"http://127.0.0.1:4321/setup?step=review#token=setup-token-value-1234",
			),
		).toBe("setup-token-value-1234");
		expect(extractSetupToken("setup-token-value-1234")).toBe(
			"setup-token-value-1234",
		);
		expect(extractSetupToken("not-a-token")).toBeNull();
	});

	it("omits the zone step when managed DNS is disabled", () => {
		expect(wizardStepsForStatus(status({ managedDnsEnabled: false }))).toEqual([
			"welcome",
			"management",
			"review",
			"verify",
			"done",
		]);
		expect(wizardStepsForStatus(status({ managedDnsEnabled: true }))).toEqual([
			"welcome",
			"management",
			"zone",
			"review",
			"verify",
			"done",
		]);
	});

	it("turns one base domain into safe management and app subdomains", () => {
		expect(suggestInstallDomains(" Example.COM. ")).toEqual({
			baseDomain: "example.com",
			managementHostname: "nearzero.example.com",
			managedDnsZone: "apps.example.com",
		});
		expect(normalizeBaseDomainInput("https://example.com")).toBeNull();
		expect(normalizeBaseDomainInput("example.com/path")).toBeNull();
		expect(suggestInstallDomains("localhost")).toBeNull();
	});

	it("infers the editable base domain from an existing install plan", () => {
		expect(
			inferInstallBaseDomain(status({ managedDnsZone: "apps.example.co.uk" })),
		).toBe("example.co.uk");
		expect(
			inferInstallBaseDomain(
				status({
					managedDnsZone: null,
					managementHostname: "nearzero.example.com",
				}),
			),
		).toBe("example.com");
	});

	it("accepts only publicly routable IPv4 input", () => {
		expect(isPublicIpv4Input("8.8.8.8")).toBe(true);
		expect(isPublicIpv4Input("1.1.1.1")).toBe(true);
		expect(isPublicIpv4Input("127.0.0.1")).toBe(false);
		expect(isPublicIpv4Input("192.168.1.10")).toBe(false);
		expect(isPublicIpv4Input("203.0.113.10")).toBe(false);
		expect(isPublicIpv4Input("999.1.1.1")).toBe(false);
		expect(isPublicIpv4Input("1.01.1.1")).toBe(false);
	});
});
