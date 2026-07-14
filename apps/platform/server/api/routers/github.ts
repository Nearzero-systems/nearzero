import {
	assertByoGitProvidersAllowed,
	detectGithubRepositoryApps,
	findGithubById,
	getAccessibleGitProviderIds,
	getGithubBranches,
	getGithubInstallationAccountName,
	getGithubRepositories,
	haveGithubRequirements,
	isGitProviderConnectionAllowed,
	updateGithub,
	updateGitProvider,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
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
	toPublicGithubDetails,
	toPublicGitProvider,
} from "@/server/api/utils/git-provider-security";
import {
	apiFindGithubBranches,
	apiFindOneGithub,
	apiUpdateGithub,
	github,
} from "@/server/db/schema";

export const githubRouter = createTRPCRouter({
	one: protectedProcedure
		.input(apiFindOneGithub)
		.query(async ({ input, ctx }) => {
			const provider = await findGithubById(input.githubId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			return {
				...toPublicGithubDetails(provider),
				gitProvider: toPublicGitProvider(provider.gitProvider),
			};
		}),
	getGithubRepositories: protectedProcedure
		.input(apiFindOneGithub)
		.query(async ({ input, ctx }) => {
			const provider = await findGithubById(input.githubId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				return await getGithubRepositories(input.githubId);
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching GitHub repositories",
				});
			}
		}),
	getGithubBranches: protectedProcedure
		.input(apiFindGithubBranches)
		.query(async ({ input, ctx }) => {
			if (!input.githubId) return [];
			const provider = await findGithubById(input.githubId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				return await getGithubBranches(input);
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching GitHub branches",
				});
			}
		}),
	detectRepositoryApps: protectedProcedure
		.input(
			z.object({
				githubId: z.string().min(1),
				owner: z.string().min(1),
				repo: z.string().min(1),
				branch: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const provider = await findGithubById(input.githubId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				return await detectGithubRepositoryApps(input);
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error inspecting the GitHub repository",
				});
			}
		}),
	githubProviders: protectedProcedure.query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleGitProviderIds(ctx.session);
		if (accessibleIds.size === 0) return [];

		let result = await db.query.github.findMany({
			where: inArray(github.gitProviderId, [...accessibleIds]),
			with: {
				gitProvider: true,
			},
		});

		result = result.filter(
			(provider) =>
				provider.gitProvider.organizationId ===
					ctx.session.activeOrganizationId &&
				accessibleIds.has(provider.gitProvider.gitProviderId) &&
				isGitProviderConnectionAllowed(provider),
		);

		const filtered = await Promise.all(
			result
				.filter((provider) => haveGithubRequirements(provider))
				.map(async (provider) => {
					const githubUsername = await getGithubInstallationAccountName(
						provider.githubId,
					);
					return {
						githubId: provider.githubId,
						githubUsername,
						gitProvider: toPublicGitProvider(provider.gitProvider),
					};
				}),
		);

		return filtered;
	}),

	testConnection: protectedProcedure
		.input(apiFindOneGithub)
		.mutation(async ({ input, ctx }) => {
			const provider = await findGithubById(input.githubId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			try {
				const result = await getGithubRepositories(input.githubId);
				return `Found ${result.length} repositories`;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the GitHub connection",
				});
			}
		}),
	update: withPermission("gitProviders", "create")
		.input(apiUpdateGithub)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("GitHub");
			const provider = await findGithubById(input.githubId);
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

				await updateGithub(input.githubId, {
					githubAppName: input.githubAppName,
				});
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating this GitHub provider",
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
