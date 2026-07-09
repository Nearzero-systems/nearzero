import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { db } from "@nearzero/server/db";
import {
	gitProviderType,
	gitProviderOAuthState,
} from "@nearzero/server/db/schema";
import { readSecret } from "@nearzero/server/db/constants";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
	assertHostedManagedGitProvidersAvailable,
	isNearzeroManagedConnection,
} from "@nearzero/server/services/git-provider-policy";

export type ManagedGitProviderType =
	(typeof gitProviderType.enumValues)[number];

export type ManagedGitProviderState = {
	stateId: string;
	providerType: ManagedGitProviderType;
	organizationId: string;
	userId: string;
	returnTo: string | null;
};

const MANAGED_STATE_PREFIX = "nz_m_";
const STATE_TTL_MS = 10 * 60 * 1000;

function normalizeAbsoluteUrl(value: string, variableName: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${variableName} must be a valid absolute URL.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${variableName} must use http or https.`);
	}
	return url.toString().replace(/\/$/, "");
}

function optionalEnv(name: string) {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function requiredEnv(name: string) {
	const value = optionalEnv(name);
	if (!value) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `${name} is required for Nearzero-managed git providers.`,
		});
	}
	return value;
}

function requiredSecret(name: string) {
	const file = optionalEnv(`${name}_FILE`);
	if (file) return readSecret(file);
	const value = optionalEnv(name);
	if (!value) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `${name} or ${name}_FILE is required for Nearzero-managed git providers.`,
		});
	}
	return value;
}

function normalizePrivateKey(value: string) {
	return value.replace(/\\n/g, "\n");
}

function hashStateToken(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

function safeReturnTo(value: string | null | undefined) {
	if (!value) return "";
	if (!value.startsWith("/") || value.startsWith("//")) return "";
	return value;
}

export function isNearzeroManagedGitProvider(input: unknown) {
	return isNearzeroManagedConnection(
		input as Parameters<typeof isNearzeroManagedConnection>[0],
	);
}

export function getManagedGitProviderCallbackBaseUrl() {
	const configured =
		optionalEnv("PUBLIC_GIT_PROVIDER_BASE_URL") ||
		optionalEnv("PUBLIC_BACKEND_URL") ||
		optionalEnv("BETTER_AUTH_URL") ||
		optionalEnv("CONSOLE_URL");
	if (configured) {
		return normalizeAbsoluteUrl(configured, "PUBLIC_GIT_PROVIDER_BASE_URL");
	}
	if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
		return "http://localhost:4321";
	}
	throw new TRPCError({
		code: "PRECONDITION_FAILED",
		message: "PUBLIC_GIT_PROVIDER_BASE_URL is required for managed git providers.",
	});
}

export function getManagedGithubConfig() {
	const appId = Number(requiredEnv("NEARZERO_GITHUB_APP_ID"));
	if (!Number.isFinite(appId) || appId <= 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "NEARZERO_GITHUB_APP_ID must be a positive number.",
		});
	}
	return {
		appId,
		privateKey: normalizePrivateKey(requiredSecret("NEARZERO_GITHUB_APP_PRIVATE_KEY")),
		appSlug: requiredEnv("NEARZERO_GITHUB_APP_SLUG"),
		clientId: optionalEnv("NEARZERO_GITHUB_CLIENT_ID"),
		clientSecret: optionalEnv("NEARZERO_GITHUB_CLIENT_SECRET"),
		webhookSecret:
			optionalEnv("NEARZERO_GITHUB_WEBHOOK_SECRET") ||
			optionalEnv("GITHUB_WEBHOOK_SECRET"),
	};
}

export function getManagedGitlabConfig() {
	return {
		clientId: requiredEnv("NEARZERO_GITLAB_CLIENT_ID"),
		clientSecret: requiredSecret("NEARZERO_GITLAB_CLIENT_SECRET"),
		gitlabUrl: normalizeAbsoluteUrl(
			optionalEnv("NEARZERO_GITLAB_URL") || "https://gitlab.com",
			"NEARZERO_GITLAB_URL",
		),
		gitlabInternalUrl: optionalEnv("NEARZERO_GITLAB_INTERNAL_URL"),
		scope: optionalEnv("NEARZERO_GITLAB_SCOPE") || "api read_user read_repository",
	};
}

export function getManagedGiteaConfig() {
	return {
		clientId: requiredEnv("NEARZERO_GITEA_CLIENT_ID"),
		clientSecret: requiredSecret("NEARZERO_GITEA_CLIENT_SECRET"),
		giteaUrl: normalizeAbsoluteUrl(
			optionalEnv("NEARZERO_GITEA_URL") || "https://gitea.com",
			"NEARZERO_GITEA_URL",
		),
		giteaInternalUrl: optionalEnv("NEARZERO_GITEA_INTERNAL_URL"),
		scope:
			optionalEnv("NEARZERO_GITEA_SCOPE") ||
			"read:repository read:user read:organization",
	};
}

export function getManagedBitbucketConfig() {
	return {
		clientId: requiredEnv("NEARZERO_BITBUCKET_CLIENT_ID"),
		clientSecret: requiredSecret("NEARZERO_BITBUCKET_CLIENT_SECRET"),
		scope: optionalEnv("NEARZERO_BITBUCKET_SCOPE") || "account repository",
	};
}

async function createManagedOAuthState(input: {
	providerType: ManagedGitProviderType;
	organizationId: string;
	userId: string;
	returnTo?: string | null;
}) {
	const stateId = randomBytes(16).toString("hex");
	const secret = randomBytes(32).toString("hex");
	const token = `${MANAGED_STATE_PREFIX}${stateId}.${secret}`;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + STATE_TTL_MS).toISOString();

	await db.insert(gitProviderOAuthState).values({
		stateId,
		stateHash: hashStateToken(token),
		providerType: input.providerType,
		organizationId: input.organizationId,
		userId: input.userId,
		returnTo: safeReturnTo(input.returnTo),
		createdAt: now.toISOString(),
		expiresAt,
	});

	return token;
}

export function isManagedGitProviderState(value: unknown) {
	return typeof value === "string" && value.startsWith(MANAGED_STATE_PREFIX);
}

export async function consumeManagedGitProviderState(
	token: string,
	expectedProviderType: ManagedGitProviderType,
): Promise<ManagedGitProviderState> {
	if (!isManagedGitProviderState(token)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid managed git provider state.",
		});
	}

	const [stateId] = token.slice(MANAGED_STATE_PREFIX.length).split(".");
	const now = new Date().toISOString();
	const [state] = await db
		.update(gitProviderOAuthState)
		.set({ consumedAt: now })
		.where(
			and(
				eq(gitProviderOAuthState.stateId, stateId ?? ""),
				eq(gitProviderOAuthState.stateHash, hashStateToken(token)),
				eq(gitProviderOAuthState.providerType, expectedProviderType),
				isNull(gitProviderOAuthState.consumedAt),
				gt(gitProviderOAuthState.expiresAt, now),
			),
		)
		.returning();

	if (!state) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Managed git provider state expired or was already used.",
		});
	}

	return {
		stateId: state.stateId,
		providerType: state.providerType,
		organizationId: state.organizationId,
		userId: state.userId,
		returnTo: state.returnTo,
	};
}

export async function startManagedGitProviderConnection(input: {
	providerType: ManagedGitProviderType;
	organizationId: string;
	userId: string;
	returnTo?: string | null;
}) {
	assertHostedManagedGitProvidersAvailable();
	const callbackBaseUrl = getManagedGitProviderCallbackBaseUrl();
	const state = await createManagedOAuthState(input);

	if (input.providerType === "github") {
		const config = getManagedGithubConfig();
		const url = new URL(
			`/apps/${encodeURIComponent(config.appSlug)}/installations/new`,
			"https://github.com",
		);
		url.searchParams.set("state", state);
		return { url: url.toString() };
	}

	if (input.providerType === "gitlab") {
		const config = getManagedGitlabConfig();
		const url = new URL("/oauth/authorize", config.gitlabUrl);
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set(
			"redirect_uri",
			`${callbackBaseUrl}/api/providers/gitlab/callback`,
		);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", config.scope);
		url.searchParams.set("state", state);
		return { url: url.toString() };
	}

	if (input.providerType === "gitea") {
		const config = getManagedGiteaConfig();
		const url = new URL("/login/oauth/authorize", config.giteaUrl);
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set(
			"redirect_uri",
			`${callbackBaseUrl}/api/providers/gitea/callback`,
		);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", config.scope);
		url.searchParams.set("state", state);
		return { url: url.toString() };
	}

	const config = getManagedBitbucketConfig();
	const url = new URL(
		"/site/oauth2/authorize",
		"https://bitbucket.org",
	);
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set(
		"redirect_uri",
		`${callbackBaseUrl}/api/providers/bitbucket/callback`,
	);
	url.searchParams.set("scope", config.scope);
	url.searchParams.set("state", state);
	return { url: url.toString() };
}
