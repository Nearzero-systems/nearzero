import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import {
	deployments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
} from "@nearzero/server/db/schema";
import { findProjectById } from "@nearzero/server/services/project";
import { execAsyncRemote } from "@nearzero/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { format } from "date-fns";
import { desc, eq, like } from "drizzle-orm";
import { nanoid } from "nanoid";

export const DB_DEPLOYMENT_PREFIX = "NZ_DB:";

export type DatabaseDeploymentMeta = {
	variant: string;
	serviceId: string;
	environmentId: string;
	projectId: string;
	name: string;
	projectName?: string;
	environmentName?: string;
	serviceExists?: boolean;
	serviceStatus?: string | null;
	serviceServerId?: string | null;
	serviceServerName?: string | null;
};

export function encodeDatabaseDeploymentDescription(
	meta: DatabaseDeploymentMeta,
): string {
	return `${DB_DEPLOYMENT_PREFIX}${JSON.stringify(meta)}`;
}

export function decodeDatabaseDeploymentDescription(
	description: string | null | undefined,
): DatabaseDeploymentMeta | null {
	if (!description?.startsWith(DB_DEPLOYMENT_PREFIX)) return null;
	try {
		return JSON.parse(
			description.slice(DB_DEPLOYMENT_PREFIX.length),
		) as DatabaseDeploymentMeta;
	} catch {
		return null;
	}
}

export async function appendDatabaseDeploymentLog(
	logPath: string,
	line: string,
	serverId?: string | null,
) {
	const normalized = line.endsWith("\n") ? line : `${line}\n`;
	if (serverId) {
		const quotedPath = `'${logPath.replace(/'/g, `'\\''`)}'`;
		await execAsyncRemote(
			serverId,
			`umask 077; cat >> ${quotedPath}`,
			undefined,
			{ input: normalized },
		);
		return;
	}
	await fsPromises.appendFile(logPath, normalized);
}

export async function createDatabaseServiceDeployment(input: {
	meta: DatabaseDeploymentMeta;
	appName: string;
	serverId?: string | null;
	title?: string;
}) {
	const { meta, appName, serverId, title } = input;
	const { LOGS_PATH } = paths(!!serverId);
	const timestamp = format(new Date(), "yyyy-MM-dd-HH-mm-ss-SSS");
	const fileName = `${appName}-${timestamp}-${nanoid(8)}.log`;
	const logFilePath = path.join(LOGS_PATH, appName, fileName);

	try {
		if (serverId) {
			const command = `
mkdir -p '${LOGS_PATH}/${appName}';
printf '%s\\n' "Initializing deployment" >> '${logFilePath}';
`;
			await execAsyncRemote(serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing deployment\n");
		}

		const created = await db
			.insert(deployments)
			.values({
				title: title ?? `Deploy ${meta.name}`,
				description: encodeDatabaseDeploymentDescription(meta),
				status: "running",
				logPath: logFilePath,
				serverId: serverId ?? null,
				startedAt: new Date().toISOString(),
			})
			.returning();

		if (!created[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return created[0];
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
}

export async function findDatabaseDeploymentsForService(serviceId: string) {
	const rows = await db.query.deployments.findMany({
		where: like(deployments.description, `${DB_DEPLOYMENT_PREFIX}%`),
		orderBy: desc(deployments.createdAt),
		with: {
			server: {
				columns: { serverId: true, name: true },
			},
		},
		limit: 100,
	});
	return rows.filter(
		(row) =>
			decodeDatabaseDeploymentDescription(row.description)?.serviceId ===
			serviceId,
	);
}

// A deployment is considered "in progress" only for a bounded window. If a
// process crashed and left a row stuck at "running", we don't want it to block
// deploys forever, so anything older than this is treated as stale/abandoned.
const IN_PROGRESS_DEPLOYMENT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Returns true when the database service already has a deployment in progress
 * (status "running") that was started recently. Used to make deploys idempotent
 * so a duplicate trigger (e.g. auto-deploy on create plus a manual click) does
 * not spawn a second overlapping deployment for the same service.
 */
export async function hasInProgressDatabaseDeployment(
	serviceId: string,
): Promise<boolean> {
	const rows = await findDatabaseDeploymentsForService(serviceId);
	const now = Date.now();
	return rows.some((row) => {
		if (row.status !== "running") return false;
		const startedAt = row.startedAt ?? row.createdAt;
		const startedMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
		if (Number.isNaN(startedMs)) return true;
		return now - startedMs < IN_PROGRESS_DEPLOYMENT_MAX_AGE_MS;
	});
}

async function findDatabaseRuntime(meta: DatabaseDeploymentMeta): Promise<{
	serviceExists: boolean;
	serviceStatus: string | null;
	serviceServerId: string | null;
	serviceServerName: string | null;
}> {
	const columns = { applicationStatus: true, serverId: true } as const;
	const withServer = {
		server: { columns: { serverId: true, name: true } },
	} as const;

	const normalize = (
		row:
			| {
					applicationStatus?: string | null;
					serverId?: string | null;
					server?: { name?: string | null } | null;
			  }
			| null
			| undefined,
	) => ({
		// A row that came back from the DB means the service still exists; if the
		// lookup returns nothing the underlying database service was deleted.
		serviceExists: !!row,
		serviceStatus: row?.applicationStatus ?? null,
		serviceServerId: row?.serverId ?? null,
		serviceServerName: row?.server?.name ?? null,
	});

	switch (meta.variant) {
		case "postgres":
			return normalize(
				await db.query.postgres.findFirst({
					where: eq(postgres.postgresId, meta.serviceId),
					columns,
					with: withServer,
				}),
			);
		case "mysql":
			return normalize(
				await db.query.mysql.findFirst({
					where: eq(mysql.mysqlId, meta.serviceId),
					columns,
					with: withServer,
				}),
			);
		case "mariadb":
			return normalize(
				await db.query.mariadb.findFirst({
					where: eq(mariadb.mariadbId, meta.serviceId),
					columns,
					with: withServer,
				}),
			);
		case "mongo":
			return normalize(
				await db.query.mongo.findFirst({
					where: eq(mongo.mongoId, meta.serviceId),
					columns,
					with: withServer,
				}),
			);
		case "redis":
			return normalize(
				await db.query.redis.findFirst({
					where: eq(redis.redisId, meta.serviceId),
					columns,
					with: withServer,
				}),
			);
		case "libsql":
			return normalize(
				await db.query.libsql.findFirst({
					where: eq(libsql.libsqlId, meta.serviceId),
					columns,
					with: withServer,
				}),
			);
		default:
			return {
				serviceExists: false,
				serviceStatus: null,
				serviceServerId: null,
				serviceServerName: null,
			};
	}
}

export async function findDatabaseDeploymentsCentralized(
	orgId: string,
	accessedServices: string[] | null,
) {
	const rows = await db.query.deployments.findMany({
		where: like(deployments.description, `${DB_DEPLOYMENT_PREFIX}%`),
		orderBy: desc(deployments.createdAt),
		with: {
			server: {
				columns: { serverId: true, name: true },
			},
		},
		limit: 300,
	});

	const projectCache = new Map<
		string,
		Awaited<ReturnType<typeof findProjectById>>
	>();
	const result: Array<
		(typeof rows)[number] & { meta: DatabaseDeploymentMeta }
	> = [];

	for (const row of rows) {
		const meta = decodeDatabaseDeploymentDescription(row.description);
		if (!meta) continue;
		if (
			accessedServices !== null &&
			!accessedServices.includes(meta.serviceId)
		) {
			continue;
		}
		let project = projectCache.get(meta.projectId);
		if (!project) {
			try {
				project = await findProjectById(meta.projectId);
				projectCache.set(meta.projectId, project);
			} catch {
				continue;
			}
		}
		if (project.organizationId !== orgId) continue;
		const runtime = await findDatabaseRuntime(meta);
		result.push({
			...row,
			meta: {
				...meta,
				...runtime,
			},
		});
	}

	return result;
}

export async function finalizeDatabaseDeployment(
	deploymentId: string,
	status: "done" | "error",
	logPath: string,
	serverId: string | null | undefined,
	message: string,
) {
	await appendDatabaseDeploymentLog(logPath, message, serverId);
	await db
		.update(deployments)
		.set({
			status,
			finishedAt: new Date().toISOString(),
		})
		.where(eq(deployments.deploymentId, deploymentId));
}

export async function readDeploymentLogFile(
	logPath: string,
	serverId?: string | null,
): Promise<string> {
	if (!logPath?.trim()) return "";
	if (serverId) {
		try {
			const { stdout } = await execAsyncRemote(
				serverId,
				`test -f '${logPath.replace(/'/g, `'\\''`)}' && cat '${logPath.replace(/'/g, `'\\''`)}' || true`,
			);
			return stdout;
		} catch {
			return "";
		}
	}
	if (!existsSync(logPath)) return "";
	return fsPromises.readFile(logPath, "utf8");
}
