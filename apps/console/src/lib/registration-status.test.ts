import { describe, expect, it } from "vitest";
import {
	type PublicRegistrationStatus,
	resolveRegistrationExperience,
} from "./registration-status";

function status(
	overrides: Partial<PublicRegistrationStatus> = {},
): PublicRegistrationStatus {
	return {
		mode: "bootstrap",
		normalSignupAllowed: false,
		ownerExists: false,
		...overrides,
	};
}

describe("registration experience", () => {
	it("points to the server command before an owner exists", () => {
		expect(resolveRegistrationExperience(status(), false)).toBe(
			"owner_required",
		);
	});

	it("requires an invitation once the owner exists", () => {
		expect(
			resolveRegistrationExperience(status({ ownerExists: true }), false),
		).toBe("invitation_required");
		expect(
			resolveRegistrationExperience(
				status({ mode: "invite_only", ownerExists: true }),
				false,
			),
		).toBe("invitation_required");
	});

	it("keeps signup open for open installs, invitations, and unknown status", () => {
		expect(
			resolveRegistrationExperience(
				status({ mode: "open", normalSignupAllowed: true }),
				false,
			),
		).toBe("open");
		expect(resolveRegistrationExperience(status(), true)).toBe("open");
		expect(resolveRegistrationExperience(null, false)).toBe("open");
	});
});
