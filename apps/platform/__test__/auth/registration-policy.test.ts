import {
	buildPublicRegistrationStatus,
	decideRegistration,
	mergeRegistrationPolicyAdminEmail,
	registrationDecisionMessage,
	resolveRegistrationPolicy,
} from "@nearzero/server/lib/registration-policy";
import { describe, expect, it } from "vitest";

describe("Community registration policy", () => {
	it("defaults production Community installations to bootstrap", () => {
		expect(
			resolveRegistrationPolicy(
				{
					NODE_ENV: "production",
					NEARZERO_ADMIN_EMAIL: " Admin@Example.com ",
				},
				true,
			),
		).toEqual({ mode: "bootstrap", adminEmail: "admin@example.com" });
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

	it("rejects invalid modes and bootstrap configurations", () => {
		expect(() =>
			resolveRegistrationPolicy(
				{
					NODE_ENV: "production",
					NEARZERO_REGISTRATION_MODE: "closed",
				},
				true,
			),
		).toThrow("bootstrap, invite_only, open");
		expect(
			resolveRegistrationPolicy({ NODE_ENV: "production" }, true),
		).toEqual({ mode: "bootstrap", adminEmail: null });
		expect(() =>
			resolveRegistrationPolicy(
				{
					NODE_ENV: "test",
					NEARZERO_REGISTRATION_MODE: "bootstrap",
					NEARZERO_ADMIN_EMAIL: "not-an-email",
				},
				true,
			),
		).toThrow("NEARZERO_ADMIN_EMAIL");
	});

	it("allows only the configured administrator until bootstrap is claimed", () => {
		const policy = {
			mode: "bootstrap" as const,
			adminEmail: "admin@example.com",
		};
		expect(
			decideRegistration({
				policy,
				email: "ADMIN@example.com",
				hasValidInvitation: false,
				bootstrapClaimed: false,
			}),
		).toEqual({ allowed: true, reason: "bootstrap_admin" });

		const wrongEmail = decideRegistration({
			policy,
			email: "other@example.com",
			hasValidInvitation: false,
			bootstrapClaimed: false,
		});
		expect(wrongEmail).toEqual({
			allowed: false,
			reason: "bootstrap_admin_only",
		});
		expect(registrationDecisionMessage(wrongEmail)).toContain(
			"configured bootstrap administrator",
		);

		expect(
			decideRegistration({
				policy,
				email: "admin@example.com",
				hasValidInvitation: false,
				bootstrapClaimed: true,
			}),
		).toEqual({ allowed: false, reason: "invite_only" });
	});

	it("allows validated invitation registrations in every mode", () => {
		for (const mode of ["bootstrap", "invite_only", "open"] as const) {
			expect(
				decideRegistration({
					policy: {
						mode,
						adminEmail: mode === "bootstrap" ? "admin@example.com" : null,
					},
					email: "invitee@example.com",
					hasValidInvitation: true,
					bootstrapClaimed: true,
				}),
			).toEqual({ allowed: true, reason: "invitation" });
		}
	});

	it("keeps invite-only closed to normal registration", () => {
		expect(
			decideRegistration({
				policy: { mode: "invite_only", adminEmail: null },
				email: "person@example.com",
				hasValidInvitation: false,
				bootstrapClaimed: false,
			}),
		).toEqual({ allowed: false, reason: "invite_only" });
	});

	it("builds a non-sensitive public status", () => {
		const status = buildPublicRegistrationStatus(
			{ mode: "bootstrap", adminEmail: "private-admin@example.com" },
			false,
		);
		expect(status).toEqual({
			mode: "bootstrap",
			normalSignupAllowed: true,
			bootstrapClaimed: false,
			adminEmailConfigured: true,
		});
		expect(status).not.toHaveProperty("adminEmail");
	});

	it("merges wizard admin email when env bootstrap email is unset", () => {
		expect(
			mergeRegistrationPolicyAdminEmail(
				{ mode: "bootstrap", adminEmail: null },
				" Owner@Example.com ",
			),
		).toEqual({ mode: "bootstrap", adminEmail: "owner@example.com" });
	});
});
