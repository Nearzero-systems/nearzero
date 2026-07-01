import { db } from "@nearzero/server/db";
import {
	applications,
	compose,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { findMemberByUserId } from "./permission";
import { findProjectById } from "./project";

export type ProjectAccessContext = {
	userId: string;
	organizationId: string;
	userRole?: string;
};

export function buildServiceFilter(
	fieldName: AnyPgColumn,
	accessedServices: string[],
) {
	return accessedServices.length === 0
		? sql`false`
		: sql`${fieldName} IN (${sql.join(
				accessedServices.map((serviceId) => sql`${serviceId}`),
				sql`, `,
			)})`;
}

function environmentFilter(accessedEnvironments: string[]) {
	return accessedEnvironments.length === 0
		? sql`false`
		: sql`${environments.environmentId} IN (${sql.join(
				accessedEnvironments.map((envId) => sql`${envId}`),
				sql`, `,
			)})`;
}

function memberServiceRelations(accessedServices: string[]) {
	return {
		applications: {
			where: buildServiceFilter(applications.applicationId, accessedServices),
			columns: {
				applicationId: true,
				name: true,
				applicationStatus: true,
			},
		},
		libsql: {
			where: buildServiceFilter(libsql.libsqlId, accessedServices),
			columns: {
				libsqlId: true,
				name: true,
				applicationStatus: true,
			},
		},
		mariadb: {
			where: buildServiceFilter(mariadb.mariadbId, accessedServices),
			columns: {
				mariadbId: true,
				name: true,
				applicationStatus: true,
			},
		},
		mongo: {
			where: buildServiceFilter(mongo.mongoId, accessedServices),
			columns: {
				mongoId: true,
				name: true,
				applicationStatus: true,
			},
		},
		mysql: {
			where: buildServiceFilter(mysql.mysqlId, accessedServices),
			columns: {
				mysqlId: true,
				name: true,
				applicationStatus: true,
			},
		},
		postgres: {
			where: buildServiceFilter(postgres.postgresId, accessedServices),
			columns: {
				postgresId: true,
				name: true,
				applicationStatus: true,
			},
		},
		redis: {
			where: buildServiceFilter(redis.redisId, accessedServices),
			columns: {
				redisId: true,
				name: true,
				applicationStatus: true,
			},
		},
		compose: {
			where: buildServiceFilter(compose.composeId, accessedServices),
			columns: {
				composeId: true,
				name: true,
				composeStatus: true,
			},
		},
	} as const;
}

function adminServiceRelations() {
	return {
		applications: {
			columns: {
				applicationId: true,
				name: true,
				applicationStatus: true,
			},
		},
		mariadb: {
			columns: {
				mariadbId: true,
			},
		},
		mongo: {
			columns: {
				mongoId: true,
			},
		},
		mysql: {
			columns: {
				mysqlId: true,
			},
		},
		postgres: {
			columns: {
				postgresId: true,
			},
		},
		redis: {
			columns: {
				redisId: true,
			},
		},
		compose: {
			columns: {
				composeId: true,
				name: true,
				composeStatus: true,
			},
		},
		libsql: {
			columns: {
				libsqlId: true,
			},
		},
	} as const;
}

function isPrivilegedRole(role?: string) {
	return role === "owner" || role === "admin";
}

export async function queryAccessibleProjects(ctx: ProjectAccessContext) {
	if (!isPrivilegedRole(ctx.userRole)) {
		const { accessedProjects, accessedEnvironments, accessedServices } =
			await findMemberByUserId(ctx.userId, ctx.organizationId);

		if (accessedProjects.length === 0) {
			return [];
		}

		return db.query.projects.findMany({
			where: and(
				sql`${projects.projectId} IN (${sql.join(
					accessedProjects.map((projectId) => sql`${projectId}`),
					sql`, `,
				)})`,
				eq(projects.organizationId, ctx.organizationId),
			),
			with: {
				environments: {
					where: environmentFilter(accessedEnvironments),
					with: memberServiceRelations(accessedServices),
					columns: {
						environmentId: true,
						isDefault: true,
						name: true,
					},
				},
				projectTags: {
					with: {
						tag: true,
					},
				},
			},
			orderBy: desc(projects.createdAt),
		});
	}

	return db.query.projects.findMany({
		with: {
			environments: {
				with: adminServiceRelations(),
				columns: {
					name: true,
					environmentId: true,
					isDefault: true,
				},
			},
			projectTags: {
				with: {
					tag: true,
				},
			},
		},
		where: eq(projects.organizationId, ctx.organizationId),
		orderBy: desc(projects.createdAt),
	});
}

export async function queryAccessibleProject(
	ctx: ProjectAccessContext,
	projectId: string,
) {
	if (!isPrivilegedRole(ctx.userRole)) {
		const { accessedServices, accessedProjects } = await findMemberByUserId(
			ctx.userId,
			ctx.organizationId,
		);

		if (!accessedProjects.includes(projectId)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this project",
			});
		}

		const project = await db.query.projects.findFirst({
			where: and(
				eq(projects.projectId, projectId),
				eq(projects.organizationId, ctx.organizationId),
			),
			with: {
				environments: {
					with: {
						applications: {
							where: buildServiceFilter(
								applications.applicationId,
								accessedServices,
							),
							columns: {
								applicationId: true,
								name: true,
								applicationStatus: true,
							},
						},
						compose: {
							where: buildServiceFilter(compose.composeId, accessedServices),
						},
						libsql: {
							where: buildServiceFilter(libsql.libsqlId, accessedServices),
						},
						mariadb: {
							where: buildServiceFilter(mariadb.mariadbId, accessedServices),
						},
						mongo: {
							where: buildServiceFilter(mongo.mongoId, accessedServices),
						},
						mysql: {
							where: buildServiceFilter(mysql.mysqlId, accessedServices),
						},
						postgres: {
							where: buildServiceFilter(postgres.postgresId, accessedServices),
						},
						redis: {
							where: buildServiceFilter(redis.redisId, accessedServices),
						},
					},
				},
				projectTags: {
					with: {
						tag: true,
					},
				},
			},
		});

		if (!project) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Project not found",
			});
		}
		return project;
	}

	const project = await findProjectById(projectId);
	if (project.organizationId !== ctx.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this project",
		});
	}
	return project;
}
