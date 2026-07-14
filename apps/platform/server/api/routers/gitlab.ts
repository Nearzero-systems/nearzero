import {
	assertByoGitProvidersAllowed,
	createGitlab,
	findGitlabById,
	getAccessibleGitProviderIds,
	getGitlabBranches,
	getGitlabRepositories,
	haveGitlabRequirements,
	isGitProviderConnectionAllowed,
	testGitlabConnection,
	updateGitlab,
	updateGitProvider,
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
	toPublicGitlabDetails,
	toPublicGitProvider,
} from "@/server/api/utils/git-provider-security";
import { assertGitProviderUrlConfigurationAllowed } from "@/server/api/utils/git-provider-url-security";
import {
	apiCreateGitlab,
	apiFindGitlabBranches,
	apiFindOneGitlab,
	apiGitlabTestConnection,
	apiUpdateGitlab,
	gitlab,
} from "@/server/db/schema";

export const gitlabRouter = createTRPCRouter({
	create: withPermission("gitProviders", "create")
		.input(apiCreateGitlab)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("GitLab");
			const urls = assertGitProviderUrlConfigurationAllowed({
				providerType: "gitlab",
				userRole: ctx.user.role,
				providerUrl: input.gitlabUrl,
				internalUrl: input.gitlabInternalUrl,
			});
			try {
				const result = await createGitlab(
					{
						...input,
						gitlabUrl: urls.providerUrl,
						gitlabInternalUrl: urls.internalUrl,
					},
					ctx.session.activeOrganizationId,
					ctx.session.userId,
				);
				if (!result) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Error creating this Gitlab provider",
					});
				}
				const provider = await findGitlabById(result.gitlabId);
				await assertGitProviderReadable(ctx.session, provider.gitProvider);

				await audit(ctx, {
					action: "create",
					resourceType: "gitProvider",
					resourceName: input.name,
				});

				return {
					...toPublicGitlabDetails(provider),
					gitProvider: toPublicGitProvider(provider.gitProvider),
				};
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating this Gitlab provider",
				});
			}
		}),
	one: protectedProcedure
		.input(apiFindOneGitlab)
		.query(async ({ input, ctx }) => {
			const provider = await findGitlabById(input.gitlabId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			return {
				...toPublicGitlabDetails(provider),
				gitProvider: toPublicGitProvider(provider.gitProvider),
			};
		}),
	gitlabProviders: protectedProcedure.query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleGitProviderIds(ctx.session);
		if (accessibleIds.size === 0) return [];

		let result = await db.query.gitlab.findMany({
			where: inArray(gitlab.gitProviderId, [...accessibleIds]),
			with: {
				gitProvider: true,
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
		const filtered = result
			.filter((provider) => haveGitlabRequirements(provider))
			.map((provider) => {
				return {
					gitlabId: provider.gitlabId,
					gitProvider: toPublicGitProvider(provider.gitProvider),
					gitlabUrl: provider.gitlabUrl,
				};
			});

		return filtered;
	}),
	getGitlabRepositories: protectedProcedure
		.input(apiFindOneGitlab)
		.query(async ({ input, ctx }) => {
			const provider = await findGitlabById(input.gitlabId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				return await getGitlabRepositories(input.gitlabId);
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching GitLab repositories",
				});
			}
		}),

	getGitlabBranches: protectedProcedure
		.input(apiFindGitlabBranches)
		.query(async ({ input, ctx }) => {
			if (!input.gitlabId) return [];
			const provider = await findGitlabById(input.gitlabId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				return await getGitlabBranches(input);
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching GitLab branches",
				});
			}
		}),
	testConnection: protectedProcedure
		.input(apiGitlabTestConnection)
		.mutation(async ({ input, ctx }) => {
			const provider = await findGitlabById(input.gitlabId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				const result = await testGitlabConnection(input);

				return `Found ${result} repositories`;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the GitLab connection",
				});
			}
		}),
	update: withPermission("gitProviders", "create")
		.input(apiUpdateGitlab)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("GitLab");
			const urls = assertGitProviderUrlConfigurationAllowed({
				providerType: "gitlab",
				userRole: ctx.user.role,
				providerUrl: input.gitlabUrl,
				internalUrl: input.gitlabInternalUrl,
			});
			const provider = await findGitlabById(input.gitlabId);
			await assertGitProviderWritable(
				ctx.session,
				ctx.user.role,
				provider.gitProvider,
				input.gitProviderId,
			);
			try {
				await updateGitProvider(provider.gitProviderId, {
					name: input.name,
					organizationId: ctx.session.activeOrganizationId,
				});
				await updateGitlab(input.gitlabId, {
					gitlabUrl: urls.providerUrl,
					gitlabInternalUrl: urls.internalUrl,
					applicationId: input.applicationId,
					redirectUri: input.redirectUri,
					groupName: input.groupName,
					...(input.secret?.trim() ? { secret: input.secret } : {}),
				});
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating this GitLab provider",
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
