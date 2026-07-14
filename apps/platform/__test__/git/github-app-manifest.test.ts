import { describe, expect, it } from "vitest";
import {
	githubAppManifestAction,
	normalizeGithubOrganizationSlug,
} from "../../../console/src/lib/github-app-manifest";

const baseInput = {
	state: "nz_b_secure-state-token",
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
			"https://github.com/settings/apps/new?state=nz_b_secure-state-token",
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
			"https://github.com/organizations/nearzero-systems/settings/apps/new?state=nz_b_secure-state-token",
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
