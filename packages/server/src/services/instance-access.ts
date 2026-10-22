import { db } from "@nearzero/server/db";
import {
	applications,
	compose,
	libsql,
	mariadb,
	member,
	mongo,
	mysql,
	postgres,
	previewDeployments,
	redis,
} from "@nearzero/server/db/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDocker, paths } from "../constants";
import { checkServiceAccess, type PermissionCtx } from "./permission";

/**
 * The local Docker host is shared by every organization on an installation,
 * and every user also owns a personal organization. Host-level operations can
 * therefore not rely on the caller's role in their active organization: any
 * user could switch to the organization they own and pass an owner/admin check.
 *
 * Instance administrators are the owners and admins of the installation's
 * primary organization, which is the first organization that received an
 * owner (the bootstrap owner's organization).
 */
export async function getPrimaryOrganizationId(): Promise<string | null> {
	const firstOwner = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
		orderBy: [asc(member.createdAt), asc(member.id)],
		columns: { organizationId: true },
	});
	return firstOwner?.organizationId ?? null;
}

export async function isInstanceAdministrator(
	userId: string | null | undefined,
): Promise<boolean> {
	if (!userId) return false;
	const organizationId = await getPrimaryOrganizationId();
	if (!organizationId) return false;
	const membership = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
			inArray(member.role, ["owner", "admin"]),
		),
		columns: { id: true },
	});
	return Boolean(membership);
}

/**
 * Control-plane containers and swarm services. A user-chosen appName that
 * collides with one of these must never grant access to the system workload.
 */
const RESERVED_SYSTEM_APP_NAMES = new Set([
	"nearzero",
	"nearzero-postgres",
	"nearzero-redis",
	"nearzero-traefik",
	"nearzero-monitoring",
	"nearzero-docker-proxy",
	"nearzero-dns",
]);

export function isReservedSystemAppName(appName: string): boolean {
	return RESERVED_SYSTEM_APP_NAMES.has(appName.trim().toLowerCase());
}

/**
 * Derives the Nearzero appNames a local container belongs to from the labels
 * that the platform's own deploy paths set:
 * - swarm services (applications, databases, previews): service name = appName
 * - docker compose: project = appName, working dir inside COMPOSE_PATH/appName
 * - docker stack: namespace = appName
 */
export function extractLocalContainerAppNames(
	labels: Record<string, string> | null | undefined,
	composePath: string,
): string[] {
	const names = new Set<string>();
	if (!labels) return [];

	const swarmService = labels["com.docker.swarm.service.name"];
	if (swarmService) {
		const stackNamespace = labels["com.docker.stack.namespace"];
		if (stackNamespace) {
			names.add(stackNamespace);
		} else {
			names.add(swarmService);
		}
	}

	const composeProject = labels["com.docker.compose.project"];
	const workingDir = labels["com.docker.compose.project.working_dir"];
	if (
		composeProject &&
		workingDir &&
		workingDir.startsWith(`${composePath}/${composeProject}/`)
	) {
		names.add(composeProject);
	}

	return [...names].filter((name) => !isReservedSystemAppName(name));
}

type LocalServiceMatch = { serviceId: string; organizationId: string };

const withProject = { environment: { with: { project: true } } } as const;

async function findLocalServiceByAppName(
	appName: string,
): Promise<LocalServiceMatch | null> {
	if (!appName || isReservedSystemAppName(appName)) return null;

	const application = await db.query.applications.findFirst({
		where: and(
			eq(applications.appName, appName),
			isNull(applications.serverId),
		),
		with: withProject,
	});
	if (application) {
		return {
			serviceId: application.applicationId,
			organizationId: application.environment.project.organizationId,
		};
	}

	const composeService = await db.query.compose.findFirst({
		where: and(eq(compose.appName, appName), isNull(compose.serverId)),
		with: withProject,
	});
	if (composeService) {
		return {
			serviceId: composeService.composeId,
			organizationId: composeService.environment.project.organizationId,
		};
	}

	const databaseLookups = [
		async () => {
			const row = await db.query.postgres.findFirst({
				where: and(eq(postgres.appName, appName), isNull(postgres.serverId)),
				with: withProject,
			});
			return (
				row && {
					id: row.postgresId,
					org: row.environment.project.organizationId,
				}
			);
		},
		async () => {
			const row = await db.query.mysql.findFirst({
				where: and(eq(mysql.appName, appName), isNull(mysql.serverId)),
				with: withProject,
			});
			return (
				row && { id: row.mysqlId, org: row.environment.project.organizationId }
			);
		},
		async () => {
			const row = await db.query.mariadb.findFirst({
				where: and(eq(mariadb.appName, appName), isNull(mariadb.serverId)),
				with: withProject,
			});
			return (
				row && {
					id: row.mariadbId,
					org: row.environment.project.organizationId,
				}
			);
		},
		async () => {
			const row = await db.query.mongo.findFirst({
				where: and(eq(mongo.appName, appName), isNull(mongo.serverId)),
				with: withProject,
			});
			return (
				row && { id: row.mongoId, org: row.environment.project.organizationId }
			);
		},
		async () => {
			const row = await db.query.redis.findFirst({
				where: and(eq(redis.appName, appName), isNull(redis.serverId)),
				with: withProject,
			});
			return (
				row && { id: row.redisId, org: row.environment.project.organizationId }
			);
		},
		async () => {
			const row = await db.query.libsql.findFirst({
				where: and(eq(libsql.appName, appName), isNull(libsql.serverId)),
				with: withProject,
			});
			return (
				row && { id: row.libsqlId, org: row.environment.project.organizationId }
			);
		},
	];
	for (const lookup of databaseLookups) {
		const match = await lookup();
		if (match) return { serviceId: match.id, organizationId: match.org };
	}

	const preview = await db.query.previewDeployments.findFirst({
		where: eq(previewDeployments.appName, appName),
		with: { application: { with: withProject } },
	});
	if (preview && !preview.application.serverId) {
		return {
			serviceId: preview.application.applicationId,
			organizationId: preview.application.environment.project.organizationId,
		};
	}

	return null;
}

/**
 * True when the caller may operate on the local-host workload named appName:
 * either an instance administrator, or a member of the owning organization
 * (as their active organization) with access to that service.
 */
export async function canAccessLocalAppName(
	ctx: PermissionCtx,
	appName: string,
): Promise<boolean> {
	if (await isInstanceAdministrator(ctx.user.id)) return true;
	return canAccessOwnedLocalAppName(ctx, appName);
}

async function canAccessOwnedLocalAppName(
	ctx: PermissionCtx,
	appName: string,
): Promise<boolean> {
	if (!ctx.session.activeOrganizationId) return false;
	const match = await findLocalServiceByAppName(appName);
	if (!match || match.organizationId !== ctx.session.activeOrganizationId) {
		return false;
	}
	try {
		await checkServiceAccess(ctx, match.serviceId, "read");
		return true;
	} catch {
		return false;
	}
}

async function resolveLocalTargetAppNames(
	target: string,
	kind: "container" | "service",
): Promise<string[]> {
	const docker = getDocker();
	const { COMPOSE_PATH } = paths();
	try {
		if (kind === "service") {
			const info = await docker.getService(target).inspect();
			const labels = (info.Spec?.Labels ?? {}) as Record<string, string>;
			const name = info.Spec?.Name as string | undefined;
			return extractLocalContainerAppNames(
				{
					...labels,
					...(name ? { "com.docker.swarm.service.name": name } : {}),
				},
				COMPOSE_PATH,
			);
		}
		const info = await docker.getContainer(target).inspect();
		return extractLocalContainerAppNames(
			(info.Config?.Labels ?? {}) as Record<string, string>,
			COMPOSE_PATH,
		);
	} catch {
		return [];
	}
}

/**
 * True when the caller may read logs from, exec into, or control a container
 * (or swarm service, for `kind: "service"`) on the shared local Docker host.
 */
export async function canAccessLocalContainer(
	ctx: PermissionCtx,
	target: string,
	kind: "container" | "service" = "container",
): Promise<boolean> {
	if (await isInstanceAdministrator(ctx.user.id)) return true;
	const appNames = await resolveLocalTargetAppNames(target, kind);
	for (const appName of appNames) {
		if (await canAccessOwnedLocalAppName(ctx, appName)) return true;
	}
	return false;
}
