const GITHUB_ORGANIZATION_SLUG = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function normalizeGithubOrganizationSlug(value: string) {
	const slug = value.trim();
	if (
		!slug ||
		slug.length > 39 ||
		!GITHUB_ORGANIZATION_SLUG.test(slug)
	) {
		return null;
	}
	return slug;
}

export function githubAppManifestAction(input: {
	organizationId: string;
	userId: string;
	useGithubOrganization: boolean;
	githubOrganizationSlug: string;
}) {
	const state = `gh_init:${input.organizationId}:${input.userId}`;
	if (!input.useGithubOrganization) {
		return `https://github.com/settings/apps/new?state=${state}`;
	}

	const slug = normalizeGithubOrganizationSlug(input.githubOrganizationSlug);
	if (!slug) return null;
	return `https://github.com/organizations/${encodeURIComponent(slug)}/settings/apps/new?state=${state}`;
}
