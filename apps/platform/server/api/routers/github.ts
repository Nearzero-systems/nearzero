import {
	detectGithubRepositoryApps,
	findGithubById,
	getAccessibleGitProviderIds,
	getGithubBranches,
	getGithubInstallationAccountName,
	getGithubRepositories,
	haveGithubRequirements,
	assertByoGitProvidersAllowed,
	isGitProviderConnectionAllowed,
	updateGithub,
	updateGitProvider,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindGithubBranches,
	apiFindOneGithub,
	apiUpdateGithub,
} from "@/server/db/schema";

export const githubRouter = createTRPCRouter({
	one: protectedProcedure.input(apiFindOneGithub).query(async ({ input }) => {
		return await findGithubById(input.githubId);
	}),
	getGithubRepositories: protectedProcedure
		.input(apiFindOneGithub)
		.query(async ({ input }) => {
			return await getGithubRepositories(input.githubId);
		}),
	getGithubBranches: protectedProcedure
		.input(apiFindGithubBranches)
		.query(async ({ input }) => {
			return await getGithubBranches(input);
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
		.query(async ({ input }) => {
			return await detectGithubRepositoryApps(input);
		}),
	githubProviders: protectedProcedure.query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleGitProviderIds(ctx.session);

		let result = await db.query.github.findMany({
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
						gitProvider: {
							...provider.gitProvider,
						},
					};
				}),
		);

		return filtered;
	}),

	testConnection: protectedProcedure
		.input(apiFindOneGithub)
		.mutation(async ({ input }) => {
			try {
				const result = await getGithubRepositories(input.githubId);
				return `Found ${result.length} repositories`;
			} catch (err) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: err instanceof Error ? err?.message : `Error: ${err}`,
				});
			}
		}),
	update: withPermission("gitProviders", "create")
		.input(apiUpdateGithub)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("GitHub");
			await updateGitProvider(input.gitProviderId, {
				name: input.name,
				organizationId: ctx.session.activeOrganizationId,
			});

			await updateGithub(input.githubId, {
				...input,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "gitProvider",
				resourceId: input.gitProviderId,
				resourceName: input.name,
			});
		}),
});
