import {
	consumeByoGitProviderOAuthState,
	consumeManagedGitProviderState,
	createGithub,
	findGitProviderById,
	getManagedGithubConfig,
	isByoGitProviderOAuthState,
	isHostedEditionMode,
	isManagedGitProviderState,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { eq } from "drizzle-orm";
import { Octokit } from "octokit";
import { github } from "@/server/db/schema";
import type { ApiRequest, ApiResponse } from "@/server/types/api";

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

export default async function handler(req: ApiRequest, res: ApiResponse) {
	const code = typeof req.query.code === "string" ? req.query.code : "";
	const state = typeof req.query.state === "string" ? req.query.state : "";
	const installationId =
		typeof req.query.installation_id === "string"
			? req.query.installation_id
			: "";
	if (!state) {
		return redirectWithError(res, "Invalid GitHub authorization state");
	}

	if (isManagedGitProviderState(state)) {
		if (!installationId) {
			return res
				.status(400)
				.json({ error: "Missing installation_id parameter" });
		}
		const managedState = await consumeManagedGitProviderState(state, "github");
		const config = getManagedGithubConfig();
		await createGithub(
			{
				name: "GitHub",
				githubAppName: `https://github.com/apps/${config.appSlug}`,
				githubAppId: config.appId,
				githubClientId: config.clientId,
				githubInstallationId: installationId,
				githubWebhookSecret: null,
			},
			managedState.organizationId,
			managedState.userId,
			{ connectionMode: "nearzero_managed" },
		);
		return res.redirect(
			307,
			managedState.returnTo ||
				"/dashboard/settings/git-providers?connected=true",
		);
	}

	if (isHostedEditionMode()) {
		return redirectWithError(
			res,
			"Cloud/Enterprise workspaces connect GitHub with the Nearzero-managed app.",
		);
	}

	if (!isByoGitProviderOAuthState(state)) {
		return redirectWithError(res, "Invalid GitHub authorization state");
	}

	try {
		const byoState = await consumeByoGitProviderOAuthState(state, "github");
		if (!byoState.targetGitProviderId) {
			if (!code) {
				return redirectWithError(res, "Missing GitHub manifest code");
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
				byoState.organizationId,
				byoState.userId,
			);
		} else {
			if (!installationId) {
				return redirectWithError(res, "Missing GitHub installation ID");
			}
			const provider = await findGitProviderById(byoState.targetGitProviderId);
			if (
				provider.organizationId !== byoState.organizationId ||
				provider.providerType !== "github" ||
				provider.connectionMode !== "byo"
			) {
				return redirectWithError(res, "Invalid GitHub authorization state");
			}
			const updated = await db
				.update(github)
				.set({ githubInstallationId: installationId })
				.where(eq(github.gitProviderId, provider.gitProviderId))
				.returning({ githubId: github.githubId });
			if (updated.length !== 1) {
				return redirectWithError(res, "GitHub provider not found");
			}
		}

		const target = safeReturnTo(byoState.returnTo ?? undefined);
		return res.redirect(
			307,
			target || "/dashboard/settings/git-providers?connected=true",
		);
	} catch {
		return redirectWithError(
			res,
			"Invalid or expired GitHub authorization state",
		);
	}
}
