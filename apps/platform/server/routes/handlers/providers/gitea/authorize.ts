import { isHostedEditionMode } from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { eq } from "drizzle-orm";
import { parseGitProviderBaseUrl } from "@/server/api/utils/git-provider-url-security";
import { gitea } from "@/server/db/schema";
import { inspectByoGitProviderTargetState } from "@/server/routes/handlers/providers/byo-oauth-state";
import type { ApiRequest, ApiResponse } from "@/server/types/api";
import { redirectWithError } from "./helper";

export default async function handler(req: ApiRequest, res: ApiResponse) {
	try {
		if (req.method !== "GET") {
			return res.status(405).json({ error: "Method not allowed" });
		}
		if (isHostedEditionMode()) {
			return redirectWithError(
				res,
				"Cloud/Enterprise workspaces connect Gitea with the Nearzero-managed app.",
			);
		}

		const { state } = req.query;

		if (!state || Array.isArray(state)) {
			return res
				.status(400)
				.json({ error: "Invalid Gitea authorization state" });
		}

		const { provider } = await inspectByoGitProviderTargetState(state, "gitea");
		const integration = await db.query.gitea.findFirst({
			where: eq(gitea.gitProviderId, provider.gitProviderId),
		});
		if (!integration?.clientId || !integration.redirectUri) {
			return redirectWithError(res, "Incomplete OAuth configuration");
		}

		// Generate the Gitea authorization URL
		const giteaUrl = parseGitProviderBaseUrl(integration.giteaUrl, "Gitea URL");
		const authorizationUrl = new URL(`${giteaUrl}/login/oauth/authorize`);
		authorizationUrl.searchParams.append("client_id", integration.clientId);
		authorizationUrl.searchParams.append("response_type", "code");
		authorizationUrl.searchParams.append(
			"redirect_uri",
			integration.redirectUri,
		);
		authorizationUrl.searchParams.append("scope", "read:user repo");
		authorizationUrl.searchParams.append("state", state);

		// Redirect user to Gitea authorization URL
		return res.redirect(307, authorizationUrl.toString());
	} catch {
		return redirectWithError(
			res,
			"Invalid or expired Gitea authorization state",
		);
	}
}
