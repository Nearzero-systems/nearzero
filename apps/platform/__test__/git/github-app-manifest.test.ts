import {
	githubAppManifestAction,
	normalizeGithubOrganizationSlug,
} from "../../../console/src/lib/github-app-manifest";
import { describe, expect, it } from "vitest";

const baseInput = {
	organizationId: "nearzero-org",
	userId: "nearzero-user",
};

describe("GitHub App manifest target", () => {
	it("uses the personal settings route when organization mode is disabled", () => {
		expect(
			githubAppManifestAction({
				...baseInput,
				useGithubOrganization: false,
				githubOrganizationSlug: "",
			}),
		).toBe(
			"https://github.com/settings/apps/new?state=gh_init:nearzero-org:nearzero-user",
		);
	});

	it("uses the requested GitHub organization route", () => {
		expect(
			githubAppManifestAction({
				...baseInput,
				useGithubOrganization: true,
				githubOrganizationSlug: "nearzero-systems",
			}),
		).toBe(
			"https://github.com/organizations/nearzero-systems/settings/apps/new?state=gh_init:nearzero-org:nearzero-user",
		);
	});

	it("never falls back to a personal account for an invalid organization", () => {
		expect(
			githubAppManifestAction({
				...baseInput,
				useGithubOrganization: true,
				githubOrganizationSlug: "",
			}),
		).toBeNull();
		expect(normalizeGithubOrganizationSlug("invalid--slug")).toBeNull();
	});
});
