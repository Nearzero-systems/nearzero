import {
	buildPublicRegistrationStatus,
	CREATE_OWNER_COMMAND,
	decideRegistration,
	registrationDecisionMessage,
	resolveRegistrationPolicy,
} from "@nearzero/server/lib/registration-policy";
import { ownerFirstNameFromEmail } from "@nearzero/server/services/instance-owner";
import { describe, expect, it } from "vitest";

describe("Community registration policy", () => {
	it("defaults production Community installations to bootstrap", () => {
		expect(resolveRegistrationPolicy({ NODE_ENV: "production" }, true)).toEqual(
			{ mode: "bootstrap" },
		);
	});

	it("keeps development, test, and Cloud open unless explicitly configured", () => {
		expect(
			resolveRegistrationPolicy({ NODE_ENV: "development" }, true).mode,
		).toBe("open");
		expect(resolveRegistrationPolicy({ NODE_ENV: "test" }, true).mode).toBe(
			"open",
		);
		expect(
			resolveRegistrationPolicy({ NODE_ENV: "production" }, false).mode,
		).toBe("open");
		expect(
			resolveRegistrationPolicy(
				{
					NODE_ENV: "test",
					NEARZERO_REGISTRATION_MODE: "invite_only",
				},
				true,
			).mode,
		).toBe("invite_only");
	});

	it("rejects invalid modes", () => {
		expect(() =>
			resolveRegistrationPolicy(
				{
					NODE_ENV: "production",
					NEARZERO_REGISTRATION_MODE: "closed",
				},
				true,
			),
		).toThrow("bootstrap, invite_only, open");
	});

	it("never creates the first owner from the web", () => {
		const policy = { mode: "bootstrap" as const };
		const beforeOwner = decideRegistration({
			policy,
			hasValidInvitation: false,
			ownerExists: false,
		});
		expect(beforeOwner).toEqual({ allowed: false, reason: "owner_required" });
		expect(registrationDecisionMessage(beforeOwner)).toContain(
			CREATE_OWNER_COMMAND,
		);

		expect(
			decideRegistration({
				policy,
				hasValidInvitation: false,
				ownerExists: true,
			}),
		).toEqual({ allowed: false, reason: "invite_only" });
	});

	it("allows validated invitation registrations in every mode", () => {
		for (const mode of ["bootstrap", "invite_only", "open"] as const) {
			expect(
				decideRegistration({
					policy: { mode },
					hasValidInvitation: true,
					ownerExists: true,
				}),
			).toEqual({ allowed: true, reason: "invitation" });
		}
	});

	it("keeps invite-only closed to normal registration", () => {
		expect(
			decideRegistration({
				policy: { mode: "invite_only" },
				hasValidInvitation: false,
				ownerExists: false,
			}),
		).toEqual({ allowed: false, reason: "invite_only" });
	});

	it("reports public signup only for open installations", () => {
		expect(buildPublicRegistrationStatus({ mode: "bootstrap" }, false)).toEqual(
			{ mode: "bootstrap", normalSignupAllowed: false, ownerExists: false },
		);
		expect(buildPublicRegistrationStatus({ mode: "open" }, true)).toEqual({
			mode: "open",
			normalSignupAllowed: true,
			ownerExists: true,
		});
	});
});

describe("server-created owner", () => {
	it("derives a first name from the email address", () => {
		expect(ownerFirstNameFromEmail("jane.doe@acme.com")).toBe("Jane");
		expect(ownerFirstNameFromEmail("ADMIN@Example.com")).toBe("Admin");
		expect(ownerFirstNameFromEmail("ops+nz@example.com")).toBe("Ops");
		expect(ownerFirstNameFromEmail("123@example.com")).toBe("Admin");
	});
});
