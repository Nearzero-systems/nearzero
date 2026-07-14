import { createHash, randomBytes } from "node:crypto";
import { db } from "@nearzero/server/db";
import { gitProviderOAuthState } from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull } from "drizzle-orm";

const BYO_OAUTH_STATE_PREFIX = "nz_b_";
const BYO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type ByoGitProviderType = "github" | "gitlab" | "gitea";

export type ByoGitProviderOAuthState = {
	providerType: ByoGitProviderType;
	organizationId: string;
	userId: string;
	targetGitProviderId: string | null;
	returnTo: string | null;
	expiresAt: string;
};

function invalidState(): TRPCError {
	return new TRPCError({
		code: "BAD_REQUEST",
		message: "Invalid or expired Git provider authorization state",
	});
}

function safeReturnTo(value: string | null | undefined): string | null {
	if (
		!value ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		/[\r\n]/.test(value)
	) {
		return null;
	}
	try {
		const base = new URL("https://nearzero.invalid");
		const parsed = new URL(value, base);
		if (parsed.origin !== base.origin) return null;
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return null;
	}
}

function hashState(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function assertStateToken(token: string): void {
	if (
		!token.startsWith(BYO_OAUTH_STATE_PREFIX) ||
		token.length <= BYO_OAUTH_STATE_PREFIX.length
	) {
		throw invalidState();
	}
}

function toPublicState(
	state: typeof gitProviderOAuthState.$inferSelect,
): ByoGitProviderOAuthState {
	return {
		providerType: state.providerType as ByoGitProviderType,
		organizationId: state.organizationId,
		userId: state.userId,
		targetGitProviderId: state.targetGitProviderId,
		returnTo: state.returnTo,
		expiresAt: state.expiresAt,
	};
}

function assertUsableState(
	state: typeof gitProviderOAuthState.$inferSelect | undefined,
	expectedProviderType: ByoGitProviderType,
	requireUnconsumed: boolean,
): asserts state is typeof gitProviderOAuthState.$inferSelect {
	const expiresAt = state ? Date.parse(state.expiresAt) : Number.NaN;
	if (
		!state ||
		state.providerType !== expectedProviderType ||
		(requireUnconsumed && state.consumedAt !== null) ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= Date.now()
	) {
		throw invalidState();
	}
}

export function isByoGitProviderOAuthState(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(BYO_OAUTH_STATE_PREFIX);
}

export async function issueByoGitProviderOAuthState(input: {
	providerType: ByoGitProviderType;
	organizationId: string;
	userId: string;
	targetGitProviderId?: string | null;
	returnTo?: string | null;
}): Promise<{ state: string; expiresAt: string }> {
	const state = `${BYO_OAUTH_STATE_PREFIX}${randomBytes(32).toString("base64url")}`;
	const expiresAt = new Date(Date.now() + BYO_OAUTH_STATE_TTL_MS).toISOString();

	await db.insert(gitProviderOAuthState).values({
		stateHash: hashState(state),
		providerType: input.providerType,
		organizationId: input.organizationId,
		userId: input.userId,
		targetGitProviderId: input.targetGitProviderId ?? null,
		returnTo: safeReturnTo(input.returnTo),
		expiresAt,
	});

	return { state, expiresAt };
}

export async function inspectByoGitProviderOAuthState(
	state: string,
	expectedProviderType: ByoGitProviderType,
): Promise<ByoGitProviderOAuthState> {
	assertStateToken(state);
	const now = new Date().toISOString();
	const record = await db.query.gitProviderOAuthState.findFirst({
		where: and(
			eq(gitProviderOAuthState.stateHash, hashState(state)),
			eq(gitProviderOAuthState.providerType, expectedProviderType),
			isNull(gitProviderOAuthState.consumedAt),
			gt(gitProviderOAuthState.expiresAt, now),
		),
	});
	assertUsableState(record, expectedProviderType, true);
	return toPublicState(record);
}

export async function consumeByoGitProviderOAuthState(
	state: string,
	expectedProviderType: ByoGitProviderType,
): Promise<ByoGitProviderOAuthState> {
	assertStateToken(state);
	const consumedAt = new Date().toISOString();
	const record = await db
		.update(gitProviderOAuthState)
		.set({ consumedAt })
		.where(
			and(
				eq(gitProviderOAuthState.stateHash, hashState(state)),
				eq(gitProviderOAuthState.providerType, expectedProviderType),
				isNull(gitProviderOAuthState.consumedAt),
				gt(gitProviderOAuthState.expiresAt, consumedAt),
			),
		)
		.returning()
		.then((rows) => rows[0]);

	assertUsableState(record, expectedProviderType, false);
	return toPublicState(record);
}
