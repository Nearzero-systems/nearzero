import {
	assertByoGitProvidersAllowed,
	createBitbucket,
	findBitbucketById,
	getAccessibleGitProviderIds,
	getBitbucketBranches,
	getBitbucketRepositories,
	isGitProviderConnectionAllowed,
	testBitbucketConnection,
	updateBitbucket,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
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
	toPublicGitProvider,
} from "@/server/api/utils/git-provider-security";
import {
	apiBitbucketTestConnection,
	apiCreateBitbucket,
	apiFindBitbucketBranches,
	apiFindOneBitbucket,
	apiUpdateBitbucket,
	bitbucket,
} from "@/server/db/schema";

export const bitbucketRouter = createTRPCRouter({
	create: withPermission("gitProviders", "create")
		.input(apiCreateBitbucket)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("Bitbucket");
			try {
				const result = await createBitbucket(
					input,
					ctx.session.activeOrganizationId,
					ctx.session.userId,
				);
				if (!result) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Error creating this Bitbucket provider",
					});
				}
				const provider = await findBitbucketById(result.bitbucketId);
				await assertGitProviderReadable(ctx.session, provider.gitProvider);

				await audit(ctx, {
					action: "create",
					resourceType: "gitProvider",
					resourceName: input.name,
				});

				return {
					...toPublicBitbucketDetails(provider),
					gitProvider: toPublicGitProvider(provider.gitProvider),
				};
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating this Bitbucket provider",
				});
			}
		}),
	one: protectedProcedure
		.input(apiFindOneBitbucket)
		.query(async ({ input, ctx }) => {
			const provider = await findBitbucketById(input.bitbucketId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			return {
				...toPublicBitbucketDetails(provider),
				gitProvider: toPublicGitProvider(provider.gitProvider),
			};
		}),
	bitbucketProviders: protectedProcedure.query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleGitProviderIds(ctx.session);
		if (accessibleIds.size === 0) return [];

		let result = await db.query.bitbucket.findMany({
			where: inArray(bitbucket.gitProviderId, [...accessibleIds]),
			with: {
				gitProvider: true,
			},
			columns: {
				bitbucketId: true,
			},
		});

		result = result.filter((provider) => {
			return (
				provider.gitProvider.organizationId ===
					ctx.session.activeOrganizationId &&
				accessibleIds.has(provider.gitProvider.gitProviderId) &&
				isGitProviderConnectionAllowed(provider)
			);
		});
		return result.map((provider) => ({
			bitbucketId: provider.bitbucketId,
			gitProvider: toPublicGitProvider(provider.gitProvider),
		}));
	}),

	getBitbucketRepositories: protectedProcedure
		.input(apiFindOneBitbucket)
		.query(async ({ input, ctx }) => {
			const provider = await findBitbucketById(input.bitbucketId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				return await getBitbucketRepositories(input.bitbucketId);
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching Bitbucket repositories",
				});
			}
		}),
	getBitbucketBranches: protectedProcedure
		.input(apiFindBitbucketBranches)
		.query(async ({ input, ctx }) => {
			if (!input.bitbucketId) return [];
			const provider = await findBitbucketById(input.bitbucketId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				return await getBitbucketBranches(input);
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching Bitbucket branches",
				});
			}
		}),
	testConnection: protectedProcedure
		.input(apiBitbucketTestConnection)
		.mutation(async ({ input, ctx }) => {
			const provider = await findBitbucketById(input.bitbucketId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				const result = await testBitbucketConnection(input);

				return `Found ${result} repositories`;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the Bitbucket connection",
				});
			}
		}),
	update: withPermission("gitProviders", "create")
		.input(apiUpdateBitbucket)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("Bitbucket");
			const provider = await findBitbucketById(input.bitbucketId);
			await assertGitProviderWritable(
				ctx.session,
				ctx.user.role,
				provider.gitProvider,
				input.gitProviderId,
			);
			const { apiToken, appPassword, accessToken, refreshToken, ...updates } =
				input;
			try {
				await updateBitbucket(input.bitbucketId, {
					...updates,
					gitProviderId: provider.gitProviderId,
					organizationId: ctx.session.activeOrganizationId,
					...(apiToken?.trim() ? { apiToken } : {}),
					...(appPassword?.trim() ? { appPassword } : {}),
					...(accessToken?.trim() ? { accessToken } : {}),
					...(refreshToken?.trim() ? { refreshToken } : {}),
				});
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating this Bitbucket provider",
				});
			}

			await audit(ctx, {
				action: "update",
				resourceType: "gitProvider",
				resourceId: provider.gitProviderId,
				resourceName: input.name,
			});

			return { success: true };
		}),
});
