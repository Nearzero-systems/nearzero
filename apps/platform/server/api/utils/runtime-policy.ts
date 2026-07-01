import {
	assertRuntimePlacementPolicy,
	getAccessibleServerIds,
	getReadyRuntimeServers,
	RuntimePlacementPolicyError,
	type RuntimePlacementAction,
	type RuntimePlacementContext,
} from "@nearzero/server";
import { TRPCError } from "@trpc/server";

type RuntimePolicyCtx = {
	user: { id: string; email: string; role: string };
	session: { activeOrganizationId: string };
};

function normalizeServerId(serverId: string | null | undefined) {
	const trimmed = serverId?.trim();
	if (!trimmed || trimmed === "nearzero") return null;
	return trimmed;
}

export async function resolveRuntimeServerId(
	ctx: RuntimePolicyCtx,
	serverId: string | null | undefined,
) {
	const normalized = normalizeServerId(serverId);
	if (normalized) return normalized;

	const [readyServers, accessibleServerIds] = await Promise.all([
		getReadyRuntimeServers(ctx.session.activeOrganizationId),
		getAccessibleServerIds({
			userId: ctx.user.id,
			activeOrganizationId: ctx.session.activeOrganizationId,
		}),
	]);

	const defaultServer = readyServers.find((server) =>
		accessibleServerIds.has(server.serverId),
	);
	return defaultServer?.serverId ?? null;
}

export async function assertRuntimePlacement(
	ctx: RuntimePolicyCtx,
	action: RuntimePlacementAction,
	context: RuntimePlacementContext,
) {
	try {
		return await assertRuntimePlacementPolicy(
			{
				organizationId: ctx.session.activeOrganizationId,
				userId: ctx.user.id,
				userEmail: ctx.user.email,
				userRole: ctx.user.role,
				actorType: "user",
			},
			action,
			context,
		);
	} catch (error) {
		if (error instanceof RuntimePlacementPolicyError) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: error.toUserMessage(),
				cause: error,
			});
		}
		throw error;
	}
}
