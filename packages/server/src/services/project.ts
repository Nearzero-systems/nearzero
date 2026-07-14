import { db } from "@nearzero/server/db";
import {
	type apiCreateProject,
	applications,
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
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { createDefaultEnvironment } from "./environment";

export type Project = typeof projects.$inferSelect;

export const createProject = async (
	input: z.infer<typeof apiCreateProject>,
	organizationId: string,
) => {
	return await db.transaction(async (tx) => {
		const newProject = await tx
			.insert(projects)
			.values({
				...input,
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newProject) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the project",
			});
		}

		const newEnvironment = await createDefaultEnvironment(
			newProject.projectId,
			tx,
		);
		return {
			project: newProject,
			environment: newEnvironment,
		};
	});
};

export const findProjectById = async (projectId: string) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.projectId, projectId),
		with: {
			environments: {
				with: {
					applications: {
						columns: {
							customInstallCommand: false,
							customBuildCommand: false,
							customStartCommand: false,
						},
					},
					compose: true,
					libsql: true,
					mariadb: true,
					mongo: true,
					mysql: true,
					postgres: true,
					redis: true,
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
};

export const deleteProject = async (projectId: string) => {
	return db.transaction(async (tx) => {
		const [lockedProject] = await tx
			.select({ projectId: projects.projectId })
			.from(projects)
			.where(eq(projects.projectId, projectId))
			.for("update");
		if (!lockedProject) return undefined;

		// Lock the project row before checking children. PostgreSQL foreign-key
		// inserts take a conflicting key-share lock, so no service can race into the
		// project between this check and the parent delete.
		const projectEnvironments = await tx.query.environments.findMany({
			where: eq(environments.projectId, projectId),
			columns: { environmentId: true },
			with: {
				applications: { columns: { applicationId: true } },
				compose: { columns: { composeId: true } },
				libsql: { columns: { libsqlId: true } },
				mariadb: { columns: { mariadbId: true } },
				mongo: { columns: { mongoId: true } },
				mysql: { columns: { mysqlId: true } },
				postgres: { columns: { postgresId: true } },
				redis: { columns: { redisId: true } },
			},
		});
		const hasServices = projectEnvironments.some(
			(environment) =>
				environment.applications.length > 0 ||
				environment.compose.length > 0 ||
				environment.libsql.length > 0 ||
				environment.mariadb.length > 0 ||
				environment.mongo.length > 0 ||
				environment.mysql.length > 0 ||
				environment.postgres.length > 0 ||
				environment.redis.length > 0,
		);
		if (hasServices) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Project still contains services. Delete every service first so routes, managed DNS, and remote resources can be cleaned up safely.",
			});
		}

		return tx
			.delete(projects)
			.where(eq(projects.projectId, projectId))
			.returning()
			.then((value) => value[0]);
	});
};

export const updateProjectById = async (
	projectId: string,
	projectData: Partial<Project>,
) => {
	const result = await db
		.update(projects)
		.set({
			...projectData,
		})
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const validUniqueServerAppName = async (appName: string) => {
	const query = await db.query.environments.findMany({
		with: {
			applications: {
				where: eq(applications.appName, appName),
				columns: {
					applicationId: true,
				},
			},
			libsql: {
				where: eq(libsql.appName, appName),
			},
			mariadb: {
				where: eq(mariadb.appName, appName),
			},
			mongo: {
				where: eq(mongo.appName, appName),
			},
			mysql: {
				where: eq(mysql.appName, appName),
			},
			postgres: {
				where: eq(postgres.appName, appName),
			},
			redis: {
				where: eq(redis.appName, appName),
			},
		},
	});

	// Filter out items with non-empty fields
	const nonEmptyProjects = query.filter(
		(project) =>
			project.applications.length > 0 ||
			project.libsql.length > 0 ||
			project.mariadb.length > 0 ||
			project.mongo.length > 0 ||
			project.mysql.length > 0 ||
			project.postgres.length > 0 ||
			project.redis.length > 0,
	);

	return nonEmptyProjects.length === 0;
};
