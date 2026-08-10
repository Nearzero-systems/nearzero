import { describe, expect, it } from "vitest";
import {
	extractSetupTokenFromHash,
	parseInstallSetupStep,
	resolveInstallSetupPath,
	wizardStepsForStatus,
	type PublicInstallSetupStatus,
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
					resumeStep: "verify",
				}),
			),
		).toBe("/setup?step=verify");
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

	it("parses wizard steps and hash tokens", () => {
		expect(parseInstallSetupStep("Management")).toBe("management");
		expect(parseInstallSetupStep("nope")).toBeNull();
		expect(extractSetupTokenFromHash("#token=abc123")).toBe("abc123");
		expect(extractSetupTokenFromHash("#other=1")).toBeNull();
	});

	it("omits the zone step when managed DNS is disabled", () => {
		expect(wizardStepsForStatus(status({ managedDnsEnabled: false }))).toEqual(
			["welcome", "management", "verify", "done"],
		);
		expect(wizardStepsForStatus(status({ managedDnsEnabled: true }))).toEqual([
			"welcome",
			"management",
			"zone",
			"verify",
			"done",
		]);
	});
});
