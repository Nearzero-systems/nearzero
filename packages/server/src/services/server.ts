import { db } from "@nearzero/server/db";
import {
	applications,
	type apiCreateServer,
	compose,
	libsql,
	mariadb,
	member,
	mongo,
	mysql,
	organization,
	postgres,
	redis,
	server,
} from "@nearzero/server/db/schema";
import { hasValidLicense } from "@nearzero/server/services/proprietary/license-key";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

export type Server = typeof server.$inferSelect;

export const createServer = async (
	input: z.infer<typeof apiCreateServer>,
	organizationId: string,
) => {
	const newServer = await db
		.insert(server)
		.values({
			...input,
			organizationId: organizationId,
			createdAt: new Date().toISOString(),
		} as typeof server.$inferInsert)
		.returning()
		.then((value) => value[0]);

	if (!newServer) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the server",
		});
	}

	return newServer;
};

export const findServerById = async (serverId: string) => {
	const currentServer = await db.query.server.findFirst({
		where: eq(server.serverId, serverId),
		with: {
			deployments: true,
			sshKey: true,
		},
	});
	if (!currentServer) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Server not found",
		});
	}
	return currentServer;
};

export const findServersByUserId = async (userId: string) => {
	const orgs = await db.query.organization.findMany({
		where: eq(organization.ownerId, userId),
		with: {
			servers: true,
		},
	});

	const servers = orgs.flatMap((org) => org.servers);

	return servers;
};

export const deleteServer = async (serverId: string) => {
	const currentServer = await db
		.delete(server)
		.where(eq(server.serverId, serverId))
		.returning()
		.then((value) => value[0]);

	return currentServer;
};

export type ServerServiceInventoryLists = {
	applications: Array<{ applicationId: string }>;
	compose: Array<{ composeId: string }>;
	redis: Array<{ redisId: string }>;
	mariadb: Array<{ mariadbId: string }>;
	mongo: Array<{ mongoId: string }>;
	mysql: Array<{ mysqlId: string }>;
	postgres: Array<{ postgresId: string }>;
	libsql: Array<{ libsqlId: string }>;
};

export type ServerServiceInventory = ServerServiceInventoryLists & {
	total: number;
};

export const getServerServiceInventoryTotal = (
	inventory: ServerServiceInventoryLists,
) =>
	inventory.applications.length +
	inventory.compose.length +
	inventory.redis.length +
	inventory.mariadb.length +
	inventory.mongo.length +
	inventory.mysql.length +
	inventory.postgres.length +
	inventory.libsql.length;

export const getServerServiceInventory = async (serverId: string) => {
	const [
		applicationRows,
		composeRows,
		redisRows,
		mariadbRows,
		mongoRows,
		mysqlRows,
		postgresRows,
		libsqlRows,
	] = await Promise.all([
		db.query.applications.findMany({
			where: eq(applications.serverId, serverId),
			columns: { applicationId: true },
		}),
		db.query.compose.findMany({
			where: eq(compose.serverId, serverId),
			columns: { composeId: true },
		}),
		db.query.redis.findMany({
			where: eq(redis.serverId, serverId),
			columns: { redisId: true },
		}),
		db.query.mariadb.findMany({
			where: eq(mariadb.serverId, serverId),
			columns: { mariadbId: true },
		}),
		db.query.mongo.findMany({
			where: eq(mongo.serverId, serverId),
			columns: { mongoId: true },
		}),
		db.query.mysql.findMany({
			where: eq(mysql.serverId, serverId),
			columns: { mysqlId: true },
		}),
		db.query.postgres.findMany({
			where: eq(postgres.serverId, serverId),
			columns: { postgresId: true },
		}),
		db.query.libsql.findMany({
			where: eq(libsql.serverId, serverId),
			columns: { libsqlId: true },
		}),
	]);

	const inventory: ServerServiceInventoryLists = {
		applications: applicationRows,
		compose: composeRows,
		redis: redisRows,
		mariadb: mariadbRows,
		mongo: mongoRows,
		mysql: mysqlRows,
		postgres: postgresRows,
		libsql: libsqlRows,
	};

	return {
		...inventory,
		total: getServerServiceInventoryTotal(inventory),
	};
};

export const haveActiveServices = async (serverId: string) =>
	(await getServerServiceInventory(serverId)).total > 0;

export const updateServerById = async (
	serverId: string,
	serverData: Partial<Server>,
) => {
	const result = await db
		.update(server)
		.set({
			...serverData,
		})
		.where(eq(server.serverId, serverId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const getAllServers = async () => {
	const servers = await db.query.server.findMany();
	return servers;
};

export const getAccessibleServerIds = async (session: {
	userId: string;
	activeOrganizationId: string;
}): Promise<Set<string>> => {
	const { userId, activeOrganizationId } = session;

	const allOrgServers = await db.query.server.findMany({
		where: eq(server.organizationId, activeOrganizationId),
		columns: {
			serverId: true,
		},
	});

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, activeOrganizationId),
		),
		columns: { accessedServers: true, role: true },
	});

	if (memberRecord?.role === "owner" || memberRecord?.role === "admin") {
		return new Set(allOrgServers.map((s) => s.serverId));
	}

	const licensed = await hasValidLicense(activeOrganizationId);

	if (!licensed) {
		return new Set(allOrgServers.map((s) => s.serverId));
	}

	return new Set(memberRecord?.accessedServers ?? []);
};
