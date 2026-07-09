import { bootstrapCloudEdition } from "@nearzero/cloud";
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

	it("enables paid features in Cloud mode", () => {
		bootstrapCloudEdition();

		expect(getRuntimeEdition()).toBe("cloud");
		expect(isEditionFeatureEnabled(EDITION_FEATURES.sso)).toBe(true);
		expect(isEditionFeatureEnabled(EDITION_FEATURES.customRoles)).toBe(true);
		expect(isEditionFeatureEnabled(EDITION_FEATURES.auditLogs)).toBe(true);
		expect(isEditionFeatureEnabled(EDITION_FEATURES.whitelabeling)).toBe(true);
		expect(hasAnyPaidEditionFeature()).toBe(true);
	});

	it("keeps the license helper aligned with the active edition", async () => {
		await expect(hasValidLicense("org-1")).resolves.toBe(false);

		bootstrapCloudEdition();
		await expect(hasValidLicense("org-1")).resolves.toBe(true);
	});

	it("never enforces Cloud billing in Community mode", () => {
		process.env.NODE_ENV = "production";
		process.env.STRIPE_SECRET_KEY = "sk_test_123";

		expect(shouldEnforceCloudBilling()).toBe(false);
	});

	it("enforces billing only when Cloud mode, production, and Stripe are configured", () => {
		bootstrapCloudEdition();
		process.env.NODE_ENV = "production";
		process.env.STRIPE_SECRET_KEY = "sk_test_123";
		delete process.env.NEARZERO_DEV_BYPASS_BILLING;

		expect(shouldEnforceCloudBilling()).toBe(true);
	});

	it("respects the billing bypass even in Cloud mode", () => {
		bootstrapCloudEdition();
		process.env.NODE_ENV = "production";
		process.env.STRIPE_SECRET_KEY = "sk_test_123";
		process.env.NEARZERO_DEV_BYPASS_BILLING = "true";

		expect(shouldEnforceCloudBilling()).toBe(false);
	});

	it("allows BYO git providers only in Community mode", () => {
		expect(isHostedEditionMode()).toBe(false);
		expect(() => assertByoGitProvidersAllowed("GitHub")).not.toThrow();
		expect(() =>
			assertGitProviderConnectionAllowed({ connectionMode: "byo" }, "GitHub"),
		).not.toThrow();
		expect(() => assertHostedManagedGitProvidersAvailable()).toThrow(
			"Cloud/Enterprise mode",
		);
	});

	it("requires Nearzero-managed git providers in Cloud/Enterprise mode", () => {
		bootstrapCloudEdition();

		expect(isHostedEditionMode()).toBe(true);
		expect(() => assertByoGitProvidersAllowed("GitHub")).toThrow(
			"Nearzero-managed app",
		);
		expect(() =>
			assertGitProviderConnectionAllowed({ connectionMode: "byo" }, "GitHub"),
		).toThrow("Nearzero-managed GitHub app");
		expect(() =>
			assertGitProviderConnectionAllowed(
				{ connectionMode: "nearzero_managed" },
				"GitHub",
			),
		).not.toThrow();
		expect(() => assertHostedManagedGitProvidersAvailable()).not.toThrow();
	});
});
