import type { ServerServiceInventory } from "@nearzero/server";
import { TRPCError } from "@trpc/server";

export type ServerAttachedServiceRef = {
	type:
		| "application"
		| "compose"
		| "redis"
		| "mariadb"
		| "mongo"
		| "mysql"
		| "postgres"
		| "libsql";
	id: string;
};

export const getServerAttachedServiceRefs = (
	inventory: ServerServiceInventory,
): ServerAttachedServiceRef[] => [
	...inventory.applications.map((item) => ({
		type: "application" as const,
		id: item.applicationId,
	})),
	...inventory.compose.map((item) => ({
		type: "compose" as const,
		id: item.composeId,
	})),
	...inventory.redis.map((item) => ({
		type: "redis" as const,
		id: item.redisId,
	})),
	...inventory.mariadb.map((item) => ({
		type: "mariadb" as const,
		id: item.mariadbId,
	})),
	...inventory.mongo.map((item) => ({
		type: "mongo" as const,
		id: item.mongoId,
	})),
	...inventory.mysql.map((item) => ({
		type: "mysql" as const,
		id: item.mysqlId,
	})),
	...inventory.postgres.map((item) => ({
		type: "postgres" as const,
		id: item.postgresId,
	})),
	...inventory.libsql.map((item) => ({
		type: "libsql" as const,
		id: item.libsqlId,
	})),
];

export const assertServerRemoveAllowed = (
	inventory: ServerServiceInventory,
	deleteAttachedServices: boolean,
) => {
	if (inventory.total > 0 && !deleteAttachedServices) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Server has active services, please delete them first",
		});
	}
};

export const preflightServerAttachedServiceDeleteAccess = async (
	inventory: ServerServiceInventory,
	checkAccess: (service: ServerAttachedServiceRef) => Promise<void>,
) => {
	const services = getServerAttachedServiceRefs(inventory);
	for (const service of services) {
		await checkAccess(service);
	}
	return services;
};

export const assertServerRemoveCleanupComplete = (
	inventory: ServerServiceInventory,
) => {
	if (inventory.total > 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Server still has attached services after cleanup. Refresh and try again.",
		});
	}
};
