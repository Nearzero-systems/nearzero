import {
	consumeManagedGitProviderState,
	createGithub,
	getManagedGithubConfig,
	isHostedEditionMode,
	isManagedGitProviderState,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { eq } from "drizzle-orm";
import type { ApiRequest, ApiResponse } from "@/server/types/api";
import { Octokit } from "octokit";
import { github } from "@/server/db/schema";

type Query = {
	code: string;
	state: string;
	installation_id: string;
	setup_action: string;
	returnTo?: string;
};

function safeReturnTo(value: unknown) {
	if (typeof value !== "string") return "";
	if (!value.startsWith("/") || value.startsWith("//")) return "";
	return value;
}

function redirectWithError(res: ApiResponse, error: string) {
	return res.redirect(
		307,
		`/dashboard/settings/git-providers?error=${encodeURIComponent(error)}`,
	);
}

export default async function handler(
	req: ApiRequest,
	res: ApiResponse,
) {
	const { code, state, installation_id, returnTo }: Query = req.query as Query;

	if (isManagedGitProviderState(state)) {
		if (!installation_id) {
			return res.status(400).json({ error: "Missing installation_id parameter" });
		}
		const managedState = await consumeManagedGitProviderState(state, "github");
		const config = getManagedGithubConfig();
		await createGithub(
			{
				name: "GitHub",
				githubAppName: `https://github.com/apps/${config.appSlug}`,
				githubAppId: config.appId,
				githubClientId: config.clientId,
				githubInstallationId: installation_id,
				githubWebhookSecret: null,
			},
			managedState.organizationId,
			managedState.userId,
			{ connectionMode: "nearzero_managed" },
		);
		return res.redirect(
			307,
			managedState.returnTo || "/dashboard/settings/git-providers?connected=true",
		);
	}

	if (isHostedEditionMode()) {
		return redirectWithError(
			res,
			"Cloud/Enterprise workspaces connect GitHub with the Nearzero-managed app.",
		);
	}

	if (!code) {
		return res.status(400).json({ error: "Missing code parameter" });
	}
	const [action, ...rest] = state?.split(":");
	// For gh_init: rest[0] = organizationId, rest[1] = userId
	// For gh_setup: rest[0] = githubProviderId

	if (action === "gh_init") {
		const organizationId = rest[0];
		const userId = rest[1] || (req.query.userId as string);

		if (!userId) {
			return res.status(400).json({ error: "Missing userId parameter" });
		}

		const octokit = new Octokit({});
		const { data } = await octokit.request(
			"POST /app-manifests/{code}/conversions",
			{
				code: code as string,
			},
		);

		await createGithub(
			{
				name: data.name,
				githubAppName: data.html_url,
				githubAppId: data.id,
				githubClientId: data.client_id,
				githubClientSecret: data.client_secret,
				githubWebhookSecret: data.webhook_secret,
				githubPrivateKey: data.pem,
			},
			organizationId as string,
			userId,
		);
	} else if (action === "gh_setup") {
		await db
			.update(github)
			.set({
				githubInstallationId: installation_id,
			})
			.where(eq(github.githubId, rest[0] as string))
			.returning();
	}

	const target = safeReturnTo(returnTo);
	res.redirect(307, target || "/dashboard/settings/git-providers?connected=true");
}
