import type { IncomingMessage, ServerResponse } from "node:http";
import { runApiHandler } from "@/server/routes/http-api";
import healthHandler from "@/server/routes/handlers/health";
import deployRefreshToken from "@/server/routes/handlers/deploy/refresh-token";
import deployCompose from "@/server/routes/handlers/deploy/compose-refresh-token";
import deployGithub from "@/server/routes/handlers/deploy/github";
import bitbucketCallback from "@/server/routes/handlers/providers/bitbucket/callback";
import gitlabCallback from "@/server/routes/handlers/providers/gitlab/callback";
import giteaAuthorize from "@/server/routes/handlers/providers/gitea/authorize";
import giteaCallback from "@/server/routes/handlers/providers/gitea/callback";
import declineInvitation from "@/server/routes/handlers/invitation/decline";
import githubSetup from "@/server/routes/handlers/providers/github/setup";
import githubWebhook from "@/server/routes/handlers/providers/github/webhook";
import { handleAgent } from "@/server/routes/agent";
import { handleAuth } from "@/server/routes/auth";
import { handleSocialAuthProviders } from "@/server/routes/handlers/auth/social-providers";
import { handleOpenApi } from "@/server/routes/trpc-openapi";
import { handleTrpc } from "@/server/routes/trpc";

function pathnameOf(req: IncomingMessage) {
	return (req.url ?? "/").split("?")[0] ?? "/";
}

function methodOf(req: IncomingMessage) {
	return (req.method ?? "GET").toUpperCase();
}

/** Returns true if the request was handled. */
export async function routeRequest(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const pathname = pathnameOf(req);
	const method = methodOf(req);

	if (pathname === "/api/health" && method === "GET") {
		await runApiHandler(req, res, {}, healthHandler);
		return true;
	}

	if (pathname.startsWith("/api/trpc")) {
		await handleTrpc(req, res);
		return true;
	}

	if (pathname.startsWith("/api/agent")) {
		await handleAgent(req, res);
		return true;
	}

	if (pathname === "/api/auth/social-providers" && method === "GET") {
		handleSocialAuthProviders(req, res);
		return true;
	}

	if (pathname.startsWith("/api/auth")) {
		await handleAuth(req, res);
		return true;
	}

	if (pathname === "/api/deploy/github") {
		await runApiHandler(req, res, {}, deployGithub);
		return true;
	}

	const composeDeployMatch = pathname.match(
		/^\/api\/deploy\/compose\/([^/]+)$/,
	);
	if (composeDeployMatch) {
		await runApiHandler(req, res, { refreshToken: composeDeployMatch[1]! }, deployCompose);
		return true;
	}

	const deployMatch = pathname.match(/^\/api\/deploy\/([^/]+)$/);
	if (deployMatch && deployMatch[1] !== "github" && deployMatch[1] !== "compose") {
		await runApiHandler(req, res, { refreshToken: deployMatch[1]! }, deployRefreshToken);
		return true;
	}

	if (pathname === "/api/providers/gitlab/callback") {
		await runApiHandler(req, res, {}, gitlabCallback);
		return true;
	}

	if (pathname === "/api/providers/bitbucket/callback") {
		await runApiHandler(req, res, {}, bitbucketCallback);
		return true;
	}

	if (pathname === "/api/providers/gitea/authorize") {
		await runApiHandler(req, res, {}, giteaAuthorize);
		return true;
	}

	if (pathname === "/api/providers/gitea/callback") {
		await runApiHandler(req, res, {}, giteaCallback);
		return true;
	}

	if (pathname === "/api/providers/github/setup") {
		await runApiHandler(req, res, {}, githubSetup);
		return true;
	}

	if (pathname === "/api/providers/github/webhook") {
		await runApiHandler(req, res, {}, githubWebhook);
		return true;
	}

	if (pathname === "/api/invitation/decline" && method === "POST") {
		await runApiHandler(req, res, {}, declineInvitation);
		return true;
	}

	// OpenAPI REST catch-all for remaining /api/* paths
	if (pathname.startsWith("/api/")) {
		await handleOpenApi(req, res);
		return true;
	}

	return false;
}
