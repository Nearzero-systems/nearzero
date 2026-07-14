import { db } from "@nearzero/server/db";
import {
	type apiCreateServer,
	applications,
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
import { hasValidLicense } from "@nearzero/server/services/license-key";
import { toPublicSshKey } from "@nearzero/server/services/ssh-key";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

export type Server = typeof server.$inferSelect;

type PublicSshKey<T> = T extends { privateKey?: unknown }
	? Omit<T, "privateKey">
	: T;
type PublicMetricsConfig<T> = T extends { server: infer S }
	? Omit<T, "server"> & {
			server: S extends { token?: unknown } ? Omit<S, "token"> : S;
		}
	: T;

export type PublicServer<T extends object> = Omit<
	T,
	"sshKey" | "metricsConfig"
> &
	("sshKey" extends keyof T ? { sshKey: PublicSshKey<T["sshKey"]> } : unknown) &
	("metricsConfig" extends keyof T
		? { metricsConfig: PublicMetricsConfig<T["metricsConfig"]> }
		: unknown);

export const toPublicServer = <T extends object>(
	currentServer: T,
): PublicServer<T> => {
	const publicServer = { ...currentServer } as Record<string, unknown>;
	const sshKey = publicServer.sshKey;
	if (sshKey && typeof sshKey === "object") {
		publicServer.sshKey = toPublicSshKey(sshKey as { privateKey?: unknown });
	}

	const metricsConfig = publicServer.metricsConfig;
	if (metricsConfig && typeof metricsConfig === "object") {
		const metricsServer = (metricsConfig as { server?: unknown }).server;
		if (metricsServer && typeof metricsServer === "object") {
			const publicMetricsServer = {
				...(metricsServer as Record<string, unknown>),
			};
			delete publicMetricsServer.token;
			publicServer.metricsConfig = {
				...(metricsConfig as Record<string, unknown>),
				server: publicMetricsServer,
			};
		}
	}

	return publicServer as PublicServer<T>;
};

type PublicRelatedServer<T> = T extends object ? PublicServer<T> : T;

export type PublicServerRelation<T extends object> = Omit<T, "server"> &
	("server" extends keyof T
		? { server: PublicRelatedServer<T["server"]> }
		: unknown);

/**
 * Redact a nested Drizzle `server` relation at an API boundary while leaving
 * the internal service result (and its monitoring/SSH credentials) untouched.
 */
export const toPublicServerRelation = <T extends object>(
	resource: T,
): PublicServerRelation<T> => {
	const relatedServer = (resource as { server?: unknown }).server;
	if (!relatedServer || typeof relatedServer !== "object") {
		return resource as PublicServerRelation<T>;
	}
	return {
		...resource,
		server: toPublicServer(relatedServer),
	} as PublicServerRelation<T>;
};

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
