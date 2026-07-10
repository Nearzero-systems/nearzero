import { bootstrapCommunityEdition } from "@nearzero/edition-community";
import { shouldEnforceCloudBilling } from "@nearzero/server/constants";
import {
	EDITION_FEATURES,
	getRuntimeEdition,
	hasAnyPaidEditionFeature,
	isEditionFeatureEnabled,
} from "@nearzero/server/services/edition-policy";
import {
	assertByoGitProvidersAllowed,
	assertGitProviderConnectionAllowed,
	assertHostedManagedGitProvidersAvailable,
	isHostedEditionMode,
} from "@nearzero/server/services/git-provider-policy";
import { hasValidLicense } from "@nearzero/server/services/license-key";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) {
			delete process.env[key];
		}
	}
	Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
	bootstrapCommunityEdition();
});

afterEach(() => {
	restoreEnv();
	bootstrapCommunityEdition();
});

describe("edition policy", () => {
	it("defaults to Community mode and disables paid features", () => {
		expect(getRuntimeEdition()).toBe("community");
		expect(isEditionFeatureEnabled(EDITION_FEATURES.sso)).toBe(false);
		expect(isEditionFeatureEnabled(EDITION_FEATURES.customRoles)).toBe(false);
		expect(isEditionFeatureEnabled(EDITION_FEATURES.auditLogs)).toBe(false);
		expect(isEditionFeatureEnabled(EDITION_FEATURES.whitelabeling)).toBe(false);
		expect(hasAnyPaidEditionFeature()).toBe(false);
	});

	it("keeps the license helper disabled in Community mode", async () => {
		await expect(hasValidLicense("org-1")).resolves.toBe(false);
	});

	it("never enforces Cloud billing in Community mode", () => {
		process.env.NODE_ENV = "production";
		process.env.STRIPE_SECRET_KEY = "sk_test_123";

		expect(shouldEnforceCloudBilling()).toBe(false);
	});

	it("allows BYO git providers in Community mode", () => {
		expect(isHostedEditionMode()).toBe(false);
		expect(() => assertByoGitProvidersAllowed("GitHub")).not.toThrow();
		expect(() =>
			assertGitProviderConnectionAllowed({ connectionMode: "byo" }, "GitHub"),
		).not.toThrow();
		expect(() => assertHostedManagedGitProvidersAvailable()).toThrow(
			"Cloud/Enterprise mode",
		);
	});
});
