import { db } from "@nearzero/server/db";
import {
	type apiCreateBitbucket,
	type apiUpdateBitbucket,
	bitbucket,
	gitProvider,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { assertGitProviderConnectionAllowed } from "./git-provider-policy";

export type Bitbucket = typeof bitbucket.$inferSelect;

export const createBitbucket = async (
	input: z.infer<typeof apiCreateBitbucket>,
	organizationId: string,
	userId: string,
	options?: { connectionMode?: "byo" | "nearzero_managed" },
) => {
	return await db.transaction(async (tx) => {
		const newGitProvider = await tx
			.insert(gitProvider)
			.values({
				providerType: "bitbucket",
				connectionMode: options?.connectionMode ?? "byo",
				organizationId: organizationId,
				name: input.name,
				userId: userId,
			})
			.returning()
			.then((response) => response[0]);

		if (!newGitProvider) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the Bitbucket provider",
			});
		}

		return await tx
			.insert(bitbucket)
			.values({
				...input,
				gitProviderId: newGitProvider?.gitProviderId,
			})
			.returning()
			.then((response) => response[0]);
	});
};

export const findBitbucketById = async (bitbucketId: string) => {
	const bitbucketProviderResult = await db.query.bitbucket.findFirst({
		where: eq(bitbucket.bitbucketId, bitbucketId),
		with: {
			gitProvider: true,
		},
	});

	if (!bitbucketProviderResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Bitbucket Provider not found",
		});
	}

	assertGitProviderConnectionAllowed(bitbucketProviderResult, "Bitbucket");

	return bitbucketProviderResult;
};

export const updateBitbucket = async (
	bitbucketId: string,
	input: z.infer<typeof apiUpdateBitbucket>,
) => {
	return await db.transaction(async (tx) => {
		// First get the current bitbucket provider to get gitProviderId
		const currentProvider = await tx.query.bitbucket.findFirst({
			where: eq(bitbucket.bitbucketId, bitbucketId),
		});

		if (!currentProvider) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Bitbucket provider not found",
			});
		}

		const result = await tx
			.update(bitbucket)
			.set({
				...(input.bitbucketUsername !== undefined
					? { bitbucketUsername: input.bitbucketUsername }
					: {}),
				...(input.bitbucketEmail !== undefined
					? { bitbucketEmail: input.bitbucketEmail }
					: {}),
				...(input.appPassword !== undefined ? { appPassword: input.appPassword } : {}),
				...(input.apiToken !== undefined ? { apiToken: input.apiToken } : {}),
				...(input.accessToken !== undefined
					? { accessToken: input.accessToken }
					: {}),
				...(input.refreshToken !== undefined
					? { refreshToken: input.refreshToken }
					: {}),
				...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
				...(input.bitbucketWorkspaceName !== undefined
					? { bitbucketWorkspaceName: input.bitbucketWorkspaceName }
					: {}),
			})
			.where(eq(bitbucket.bitbucketId, bitbucketId))
			.returning();

		if (input.name || input.organizationId) {
			await tx
				.update(gitProvider)
				.set({
					name: input.name,
					organizationId: input.organizationId,
				})
				.where(eq(gitProvider.gitProviderId, currentProvider.gitProviderId))
				.returning();
		}

		return result[0];
	});
};
