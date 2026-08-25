import { describe, expect, it } from "vitest";
import {
	type PublicRegistrationStatus,
	resolveLoginRegistrationExperience,
	resolveRegistrationExperience,
} from "./registration-status";

function status(
	overrides: Partial<PublicRegistrationStatus> = {},
): PublicRegistrationStatus {
	return {
		mode: "bootstrap",
		normalSignupAllowed: true,
		bootstrapClaimed: false,
		adminEmailConfigured: true,
		...overrides,
	};
}

describe("registration experience", () => {
	it("shows first-owner copy only before bootstrap is claimed", () => {
		expect(resolveRegistrationExperience(status(), false)).toBe(
			"bootstrap_owner",
		);
	});

	it("hides first-owner copy after the first owner exists", () => {
		expect(
			resolveRegistrationExperience(
				status({
					bootstrapClaimed: true,
					normalSignupAllowed: false,
				}),
				false,
			),
		).toBe("invitation_required");
	});

	it("does not revive first-owner copy from a stale claimed status", () => {
		expect(
			resolveRegistrationExperience(
				status({
					bootstrapClaimed: true,
					normalSignupAllowed: true,
				}),
				false,
			),
		).toBe("invitation_required");
	});

	it("drops first-owner login copy after domain setup and after the first owner", () => {
		expect(
			resolveLoginRegistrationExperience("bootstrap_owner", {
				phase: "configured",
				bootstrapClaimed: false,
			}),
		).toBe("open");
		expect(
			resolveLoginRegistrationExperience("bootstrap_owner", {
				phase: "operational",
				bootstrapClaimed: true,
			}),
		).toBe("invitation_required");
	});
});
