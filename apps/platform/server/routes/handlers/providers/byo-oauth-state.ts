import {
	type ByoGitProviderOAuthState,
	type ByoGitProviderType,
	consumeByoGitProviderOAuthState,
	findGitProviderById,
	inspectByoGitProviderOAuthState,
} from "@nearzero/server";
import { TRPCError } from "@trpc/server";

function invalidState(): TRPCError {
	return new TRPCError({
		code: "BAD_REQUEST",
		message: "Invalid or expired Git provider authorization state",
	});
}

async function assertTarget(
	state: ByoGitProviderOAuthState,
	expectedProviderType: ByoGitProviderType,
) {
	if (!state.targetGitProviderId) throw invalidState();
	const provider = await findGitProviderById(state.targetGitProviderId);
	if (
		provider.organizationId !== state.organizationId ||
		provider.providerType !== expectedProviderType ||
		provider.connectionMode !== "byo"
	) {
		throw invalidState();
	}
	return { state, provider };
}

export async function consumeByoGitProviderTargetState(
	token: string,
	expectedProviderType: ByoGitProviderType,
) {
	return await assertTarget(
		await consumeByoGitProviderOAuthState(token, expectedProviderType),
		expectedProviderType,
	);
}

export async function inspectByoGitProviderTargetState(
	token: string,
	expectedProviderType: ByoGitProviderType,
) {
	return await assertTarget(
		await inspectByoGitProviderOAuthState(token, expectedProviderType),
		expectedProviderType,
	);
}
