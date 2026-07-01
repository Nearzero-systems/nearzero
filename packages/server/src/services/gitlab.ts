import { db } from "@nearzero/server/db";
import {
	type apiCreateGitlab,
	gitlab,
	gitProvider,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { assertGitProviderConnectionAllowed } from "./git-provider-policy";

export type Gitlab = typeof gitlab.$inferSelect;

export const createGitlab = async (
	input: z.infer<typeof apiCreateGitlab>,
	organizationId: string,
	userId: string,
	options?: { connectionMode?: "byo" | "nearzero_managed" },
) => {
	return await db.transaction(async (tx) => {
		const newGitProvider = await tx
			.insert(gitProvider)
			.values({
				providerType: "gitlab",
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
				message: "Error creating the Git provider",
			});
		}

		return await tx
			.insert(gitlab)
			.values({
				...input,
				gitProviderId: newGitProvider?.gitProviderId,
			})
			.returning()
			.then((response) => response[0]);
	});
};

export const findGitlabById = async (gitlabId: string) => {
	const gitlabProviderResult = await db.query.gitlab.findFirst({
		where: eq(gitlab.gitlabId, gitlabId),
		with: {
			gitProvider: true,
		},
	});

	if (!gitlabProviderResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Gitlab Provider not found",
		});
	}

	assertGitProviderConnectionAllowed(gitlabProviderResult, "GitLab");

	return gitlabProviderResult;
};

export const updateGitlab = async (
	gitlabId: string,
	input: Partial<Gitlab>,
) => {
	return await db
		.update(gitlab)
		.set({
			...input,
		})
		.where(eq(gitlab.gitlabId, gitlabId))
		.returning()
		.then((response) => response[0]);
};
