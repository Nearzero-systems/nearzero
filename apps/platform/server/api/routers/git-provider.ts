import {
	assertByoGitProvidersAllowed,
	assertHostedManagedGitProvidersAvailable,
	findGitProviderById,
	getAccessibleGitProviderIds,
	isGitProviderConnectionAllowed,
	issueByoGitProviderOAuthState,
	removeGitProvider,
	updateGitProvider,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { hasValidLicense } from "@nearzero/server/services/license-key";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	assertGitProviderReadable,
	assertGitProviderWritable,
	toPublicBitbucketDetails,
	toPublicGiteaDetails,
	toPublicGithubDetails,
	toPublicGitlabDetails,
	toPublicGitProvider,
} from "@/server/api/utils/git-provider-security";
import {
	apiRemoveGitProvider,
	apiToggleShareGitProvider,
	gitProvider,
} from "@/server/db/schema";

const apiStartManagedGitProviderConnection = z.object({
	providerType: z.enum(["github", "gitlab", "bitbucket", "gitea"]),
	returnTo: z.string().optional(),
});

const apiCreateByoGitProviderOAuthState = z.object({
	providerType: z.enum(["github", "gitlab", "gitea"]),
	targetGitProviderId: z.string().min(1).optional(),
	returnTo: z.string().max(2048).optional(),
});

function safeReturnTo(value: string | undefined) {
	if (!value) return "";
	if (!value.startsWith("/") || value.startsWith("//")) return "";
	return value;
}

export const gitProviderRouter = createTRPCRouter({
	getAll: protectedProcedure.query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleGitProviderIds(ctx.session);

		if (accessibleIds.size === 0) return [];

		const results = await db.query.gitProvider.findMany({
			with: {
				gitlab: true,
				bitbucket: true,
				github: true,
				gitea: true,
			},
			orderBy: desc(gitProvider.createdAt),
			where: and(
				eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
				inArray(gitProvider.gitProviderId, [...accessibleIds]),
			),
		});

		return results
			.filter((r) => isGitProviderConnectionAllowed(r))
			.map((r) => ({
				...toPublicGitProvider(r),
				isOwner: r.userId === ctx.session.userId,
				github: r.github ? toPublicGithubDetails(r.github) : null,
				gitlab: r.gitlab ? toPublicGitlabDetails(r.gitlab) : null,
				bitbucket: r.bitbucket ? toPublicBitbucketDetails(r.bitbucket) : null,
				gitea: r.gitea ? toPublicGiteaDetails(r.gitea) : null,
			}));
	}),

	toggleShare: protectedProcedure
		.input(apiToggleShareGitProvider)
		.mutation(async ({ input, ctx }) => {
			const provider = await findGitProviderById(input.gitProviderId);
			await assertGitProviderReadable(ctx.session, provider);

			if (
				provider.userId !== ctx.session.userId ||
				provider.organizationId !== ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Only the owner can share this provider",
				});
			}

			await audit(ctx, {
				action: "update",
				resourceType: "gitProvider",
				resourceId: provider.gitProviderId,
				resourceName: provider.name ?? provider.gitProviderId,
			});

			await updateGitProvider(input.gitProviderId, {
				sharedWithOrganization: input.sharedWithOrganization,
			});
			return {
				success: true,
				gitProviderId: provider.gitProviderId,
				sharedWithOrganization: input.sharedWithOrganization,
			};
		}),

	startManagedConnection: withPermission("gitProviders", "create")
		.input(apiStartManagedGitProviderConnection)
		.mutation(async ({ input: _input, ctx: _ctx }) => {
			assertHostedManagedGitProvidersAvailable();
			throw new TRPCError({
				code: "NOT_IMPLEMENTED",
				message:
					"Nearzero-managed git providers require Nearzero Cloud/Enterprise.",
			});
		}),

	createByoOAuthState: withPermission("gitProviders", "create")
		.input(apiCreateByoGitProviderOAuthState)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed(input.providerType);
			if (!input.targetGitProviderId && input.providerType !== "github") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "A target Git provider is required",
				});
			}

			if (input.targetGitProviderId) {
				const provider = await findGitProviderById(input.targetGitProviderId);
				await assertGitProviderWritable(ctx.session, ctx.user.role, provider);
				if (
					provider.providerType !== input.providerType ||
					provider.connectionMode !== "byo"
				) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Git provider not found",
					});
				}
			}

			try {
				return await issueByoGitProviderOAuthState({
					providerType: input.providerType,
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.session.userId,
					targetGitProviderId: input.targetGitProviderId,
					returnTo: safeReturnTo(input.returnTo),
				});
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Unable to start Git provider authorization",
				});
			}
		}),

	allForPermissions: withPermission("member", "update")
		.use(async ({ ctx, next }) => {
			const licensed = await hasValidLicense(ctx.session.activeOrganizationId);
			if (!licensed) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Valid enterprise license required",
				});
			}
			return next();
		})
		.query(async ({ ctx }) => {
			return await db.query.gitProvider.findMany({
				columns: {
					gitProviderId: true,
					name: true,
					providerType: true,
				},
				orderBy: desc(gitProvider.createdAt),
				where: eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
			});
		}),

	remove: withPermission("gitProviders", "delete")
		.input(apiRemoveGitProvider)
		.mutation(async ({ input, ctx }) => {
			try {
				const provider = await findGitProviderById(input.gitProviderId);
				await assertGitProviderWritable(ctx.session, ctx.user.role, provider);
				await audit(ctx, {
					action: "delete",
					resourceType: "gitProvider",
					resourceId: provider.gitProviderId,
					resourceName: provider.name ?? provider.gitProviderId,
				});
				await removeGitProvider(input.gitProviderId);
				return {
					success: true,
					gitProviderId: provider.gitProviderId,
				};
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error deleting this Git provider",
				});
			}
		}),
});
