import {
	assertByoGitProvidersAllowed,
	createGitea,
	findGiteaById,
	getAccessibleGitProviderIds,
	getGiteaBranches,
	getGiteaRepositories,
	haveGiteaRequirements,
	isGitProviderConnectionAllowed,
	testGiteaConnection,
	updateGitea,
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
	toPublicGiteaDetails,
	toPublicGitProvider,
} from "@/server/api/utils/git-provider-security";
import { assertGitProviderUrlConfigurationAllowed } from "@/server/api/utils/git-provider-url-security";
import {
	apiCreateGitea,
	apiFindGiteaBranches,
	apiFindOneGitea,
	apiGiteaTestConnection,
	apiUpdateGitea,
	gitea,
} from "@/server/db/schema";

export const giteaRouter = createTRPCRouter({
	create: withPermission("gitProviders", "create")
		.input(apiCreateGitea)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("Gitea");
			const urls = assertGitProviderUrlConfigurationAllowed({
				providerType: "gitea",
				userRole: ctx.user.role,
				providerUrl: input.giteaUrl,
				internalUrl: input.giteaInternalUrl,
			});
			try {
				const result = await createGitea(
					{
						...input,
						giteaUrl: urls.providerUrl,
						giteaInternalUrl: urls.internalUrl,
					},
					ctx.session.activeOrganizationId,
					ctx.session.userId,
				);
				const provider = await findGiteaById(result.giteaId);
				await assertGitProviderReadable(ctx.session, provider.gitProvider);

				await audit(ctx, {
					action: "create",
					resourceType: "gitProvider",
					resourceId: result.giteaId,
					resourceName: input.name,
				});

				return {
					...toPublicGiteaDetails(provider),
					gitProvider: toPublicGitProvider(provider.gitProvider),
				};
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating this Gitea provider",
				});
			}
		}),

	one: protectedProcedure
		.input(apiFindOneGitea)
		.query(async ({ input, ctx }) => {
			const provider = await findGiteaById(input.giteaId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);
			return {
				...toPublicGiteaDetails(provider),
				gitProvider: toPublicGitProvider(provider.gitProvider),
			};
		}),

	giteaProviders: protectedProcedure.query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleGitProviderIds(ctx.session);
		if (accessibleIds.size === 0) return [];

		let result = await db.query.gitea.findMany({
			where: inArray(gitea.gitProviderId, [...accessibleIds]),
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

		const filtered = result
			.filter((provider) => haveGiteaRequirements(provider))
			.map((provider) => {
				return {
					giteaId: provider.giteaId,
					gitProvider: toPublicGitProvider(provider.gitProvider),
				};
			});

		return filtered;
	}),

	getGiteaRepositories: protectedProcedure
		.input(apiFindOneGitea)
		.query(async ({ input, ctx }) => {
			const { giteaId } = input;

			if (!giteaId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Gitea provider ID is required.",
				});
			}
			const provider = await findGiteaById(giteaId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);

			try {
				const repositories = await getGiteaRepositories(giteaId);
				return repositories;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching Gitea repositories",
				});
			}
		}),

	getGiteaBranches: protectedProcedure
		.input(apiFindGiteaBranches)
		.query(async ({ input, ctx }) => {
			const { giteaId, owner, repositoryName } = input;

			if (!giteaId || !owner || !repositoryName) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Gitea provider ID, owner, and repository name are required.",
				});
			}
			const provider = await findGiteaById(giteaId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);

			try {
				return await getGiteaBranches({
					giteaId,
					owner,
					repo: repositoryName,
				});
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching Gitea branches",
				});
			}
		}),

	testConnection: protectedProcedure
		.input(apiGiteaTestConnection)
		.mutation(async ({ input, ctx }) => {
			const giteaId = input.giteaId ?? "";
			const provider = await findGiteaById(giteaId);
			await assertGitProviderReadable(ctx.session, provider.gitProvider);

			try {
				const result = await testGiteaConnection({
					giteaId,
				});

				return `Found ${result} repositories`;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the Gitea connection",
				});
			}
		}),

	update: withPermission("gitProviders", "create")
		.input(apiUpdateGitea)
		.mutation(async ({ input, ctx }) => {
			assertByoGitProvidersAllowed("Gitea");
			const urls = assertGitProviderUrlConfigurationAllowed({
				providerType: "gitea",
				userRole: ctx.user.role,
				providerUrl: input.giteaUrl,
				internalUrl: input.giteaInternalUrl,
			});
			const provider = await findGiteaById(input.giteaId);
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
				await updateGitea(input.giteaId, {
					giteaUrl: urls.providerUrl,
					giteaInternalUrl: urls.internalUrl,
					redirectUri: input.redirectUri,
					clientId: input.clientId,
					expiresAt: input.expiresAt,
					scopes: input.scopes,
					lastAuthenticatedAt: input.lastAuthenticatedAt,
					...(input.clientSecret?.trim()
						? { clientSecret: input.clientSecret }
						: {}),
					...(input.accessToken?.trim()
						? { accessToken: input.accessToken }
						: {}),
					...(input.refreshToken?.trim()
						? { refreshToken: input.refreshToken }
						: {}),
				});
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating this Gitea provider",
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

	getGiteaUrl: protectedProcedure
		.input(apiFindOneGitea)
		.query(async ({ input, ctx }) => {
			const { giteaId } = input;

			if (!giteaId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Gitea provider ID is required.",
				});
			}

			const giteaProvider = await findGiteaById(giteaId);
			await assertGitProviderReadable(ctx.session, giteaProvider.gitProvider);

			// Return the base URL of the Gitea instance
			return giteaProvider.giteaUrl;
		}),
});
