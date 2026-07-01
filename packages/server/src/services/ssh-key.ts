import { db } from "@nearzero/server/db";
import {
	type apiCreateSshKey,
	type apiFindOneSshKey,
	type apiRemoveSshKey,
	type apiUpdateSshKey,
	server,
	sshKeys,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

export const createSshKey = async (input: z.infer<typeof apiCreateSshKey>) => {
	await db.transaction(async (tx) => {
		const sshKey = await tx
			.insert(sshKeys)
			.values(input)
			.returning()
			.then((response) => response[0])
			.catch((e) => console.error(e));

		if (!sshKey) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the SSH Key",
			});
		}
		return sshKey;
	});
};

export const removeSSHKeyById = async (
	sshKeyId: z.infer<typeof apiRemoveSshKey>["sshKeyId"],
	organizationId: string,
) => {
	const attachedServers = await db.query.server.findMany({
		where: and(
			eq(server.sshKeyId, sshKeyId),
			eq(server.organizationId, organizationId),
		),
		columns: { name: true },
	});

	if (attachedServers.length > 0) {
		const serverNames = attachedServers.map((item) => item.name).join(", ");
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `This SSH key is attached to ${attachedServers.length === 1 ? "server" : "servers"}: ${serverNames}. Remove ${attachedServers.length === 1 ? "that server" : "those servers"} first.`,
		});
	}

	const result = await db
		.delete(sshKeys)
		.where(eq(sshKeys.sshKeyId, sshKeyId))
		.returning();

	return result[0];
};

export const updateSSHKeyById = async ({
	sshKeyId,
	...input
}: z.infer<typeof apiUpdateSshKey>) => {
	const result = await db
		.update(sshKeys)
		.set(input)
		.where(eq(sshKeys.sshKeyId, sshKeyId))
		.returning();

	return result[0];
};

export const findSSHKeyById = async (
	sshKeyId: z.infer<typeof apiFindOneSshKey>["sshKeyId"],
) => {
	const sshKey = await db.query.sshKeys.findFirst({
		where: eq(sshKeys.sshKeyId, sshKeyId),
	});
	if (!sshKey) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "SSH Key not found",
		});
	}
	return sshKey;
};
