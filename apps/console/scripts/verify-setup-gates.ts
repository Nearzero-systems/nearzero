import assert from "node:assert/strict";
import {
	extractSetupTokenFromHash,
	isInstallSetupPageOpen,
	parseInstallSetupStep,
	resolveInstallSetupPath,
	wizardStepsForStatus,
	type PublicInstallSetupStatus,
} from "../src/lib/install-setup.ts";

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

assert.equal(resolveInstallSetupPath(status()), "/setup?step=welcome");
assert.equal(
	resolveInstallSetupPath(status({ resumeStep: "management" })),
	"/setup?step=management",
);
assert.equal(
	resolveInstallSetupPath(
		status({
			bootstrapClaimed: true,
			phase: "operational",
			resumeStep: "login",
			required: false,
			canSubmit: false,
		}),
	),
	"/login",
);
assert.equal(
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
	"/register",
);
assert.equal(
	isInstallSetupPageOpen(
		status({
			phase: "configured",
			canSubmit: false,
			required: false,
			resumeStep: "register",
		}),
	),
	false,
);
assert.equal(parseInstallSetupStep("verify"), "verify");
assert.equal(extractSetupTokenFromHash("#token=secret"), "secret");
assert.deepEqual(wizardStepsForStatus(status({ managedDnsEnabled: false })), [
	"welcome",
	"management",
	"review",
	"verify",
	"done",
]);

console.log("verify-setup-gates: ok");
