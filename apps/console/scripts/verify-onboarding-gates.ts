import assert from "node:assert/strict";
import {
	invitationPathFromToken,
	inviteMemberSetupPath,
	registerOnboardingResumePath,
	registerPathForSession,
	workspaceSetupPath,
} from "../src/lib/onboarding-gates.ts";

assert.equal(
	registerOnboardingResumePath({ profileComplete: false }),
	"/register?step=profile",
);
assert.equal(
	registerOnboardingResumePath({ profileComplete: true }),
	"/register?step=role",
);
assert.equal(
	registerOnboardingResumePath({
		profileComplete: false,
		pendingInvitationId: "invite123",
	}),
	"/invitation?token=invite123",
);
assert.equal(
	registerOnboardingResumePath({
		profileComplete: false,
		needsWorkspaceSetup: true,
	}),
	workspaceSetupPath(),
);
assert.equal(
	registerOnboardingResumePath({
		profileComplete: false,
		pendingInvitationId: "invite123",
		needsWorkspaceSetup: true,
	}),
	"/invitation?token=invite123",
);

assert.equal(
	registerOnboardingResumePath({
		profileComplete: false,
		needsInviteMemberSetup: true,
		inviteMemberProfileComplete: false,
	}),
	inviteMemberSetupPath("profile"),
);
assert.equal(
	registerOnboardingResumePath({
		profileComplete: true,
		needsInviteMemberSetup: true,
		inviteMemberProfileComplete: true,
	}),
	inviteMemberSetupPath("role"),
);

assert.equal(
	registerPathForSession("profile", { complete: false, profileComplete: false }),
	null,
);
assert.equal(
	registerPathForSession("role", { complete: false, profileComplete: false }),
	"/register?step=profile",
);
assert.equal(
	registerPathForSession("signup", { complete: false, profileComplete: true }),
	"/register?step=role",
);
assert.equal(
	registerPathForSession("role", { complete: false, profileComplete: true }),
	null,
);
assert.equal(
	registerPathForSession("profile", { complete: true, profileComplete: true }),
	"/dashboard/agent",
);
assert.equal(
	registerPathForSession("verify", { complete: false, profileComplete: false }),
	"/register?step=profile",
);
assert.equal(
	registerPathForSession("verify", { complete: false, profileComplete: true }),
	"/register?step=role",
);
assert.equal(
	registerPathForSession("verify", { complete: true, profileComplete: false }),
	"/dashboard/agent",
);

assert.equal(
	registerPathForSession(
		"profile",
		{ complete: false, profileComplete: false, pendingInvitationId: "abc" },
	),
	"/invitation?token=abc",
);
assert.equal(
	registerPathForSession(
		"profile",
		{ complete: false, profileComplete: false },
		{ invitationToken: "xyz" },
	),
	"/invitation?token=xyz",
);
assert.equal(
	registerPathForSession(
		"role",
		{ complete: false, profileComplete: false, needsWorkspaceSetup: true },
	),
	workspaceSetupPath(),
);
assert.equal(
	registerPathForSession(
		"verify",
		{ complete: false, profileComplete: false, needsWorkspaceSetup: true },
	),
	workspaceSetupPath(),
);
assert.equal(
	registerPathForSession(
		"profile",
		{ complete: false, profileComplete: false, needsWorkspaceSetup: true },
		{ workspaceSetupMode: true },
	),
	null,
);

assert.equal(
	registerPathForSession(
		"invite",
		{
			complete: false,
			profileComplete: true,
			needsInviteMemberSetup: true,
			inviteMemberProfileComplete: true,
		},
	),
	inviteMemberSetupPath("workspace"),
);
assert.equal(
	registerPathForSession(
		"verify",
		{
			complete: false,
			profileComplete: false,
			needsInviteMemberSetup: true,
			inviteMemberProfileComplete: false,
		},
	),
	inviteMemberSetupPath("profile"),
);
assert.equal(
	registerPathForSession(
		"verify",
		{
			complete: false,
			profileComplete: true,
			needsInviteMemberSetup: true,
			inviteMemberProfileComplete: true,
		},
	),
	inviteMemberSetupPath("role"),
);
assert.equal(
	registerPathForSession(
		"profile",
		{
			complete: false,
			profileComplete: false,
			needsInviteMemberSetup: true,
			inviteMemberProfileComplete: false,
		},
		{ inviteMemberSetupMode: true },
	),
	null,
);

assert.equal(invitationPathFromToken("token/id"), "/invitation?token=token%2Fid");

console.log("onboarding-gates checks passed");
