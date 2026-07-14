import { db } from "@nearzero/server/db";
import {
	type apiCreateEnvironment,
	type apiDuplicateEnvironment,
	environments,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import type { z } from "zod";

export type Environment = typeof environments.$inferSelect;

export const DEFAULT_PROJECT_ENVIRONMENT_NAME = "development";

export function isProductionEnvironment(
	env: Pick<Environment, "name" | "isDefault">,
): boolean {
	return env.name.trim().toLowerCase() === "production";
}

export const createEnvironment = async (
	input: z.infer<typeof apiCreateEnvironment>,
) => {
	const newEnvironment = await db
		.insert(environments)
		.values({
			...input,
		})
		.returning()
		.then((value) => value[0]);

	if (!newEnvironment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the environment",
		});
	}

	return newEnvironment;
};

export const findEnvironmentById = async (environmentId: string) => {
	const environment = await db.query.environments.findFirst({
		where: eq(environments.environmentId, environmentId),
		columns: {
			name: true,
			description: true,
			environmentId: true,
			isDefault: true,
			projectId: true,
			env: true,
			dnsZoneId: true,
			domainPrefix: true,
		},
		with: {
			applications: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
					domains: true,
					deployments: {
						columns: {
							deploymentId: true,
							status: true,
							buildPlan: true,
							createdAt: true,
						},
						orderBy: (deployments, { desc }) => [desc(deployments.createdAt)],
						limit: 1,
					},
				},
				columns: {
					name: true,
					appName: true,
					applicationId: true,
					createdAt: true,
					applicationStatus: true,
					description: true,
					serverId: true,
					icon: true,
					buildType: true,
				},
			},
			mariadb: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
				},
				columns: {
					mariadbId: true,
					name: true,
					appName: true,
					createdAt: true,
					applicationStatus: true,
					description: true,
					serverId: true,
				},
			},
			mongo: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
				},
				columns: {
					mongoId: true,
					name: true,
					appName: true,
					createdAt: true,
					applicationStatus: true,
					description: true,
					serverId: true,
				},
			},
			mysql: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
				},
				columns: {
					mysqlId: true,
					name: true,
					appName: true,
					createdAt: true,
					applicationStatus: true,
					description: true,
					serverId: true,
				},
			},
			postgres: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
				},
				columns: {
					postgresId: true,
					name: true,
					appName: true,
					description: true,
					createdAt: true,
					applicationStatus: true,
					serverId: true,
				},
			},
			redis: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
				},
				columns: {
					redisId: true,
					name: true,
					appName: true,
					createdAt: true,
					applicationStatus: true,
					description: true,
					serverId: true,
				},
			},
			compose: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
					domains: true,
				},
				columns: {
					composeId: true,
					name: true,
					appName: true,
					createdAt: true,
					composeStatus: true,
					description: true,
					serverId: true,
				},
			},
			libsql: {
				with: {
					server: {
						columns: {
							name: true,
							serverId: true,
						},
					},
				},
				columns: {
					libsqlId: true,
					name: true,
					appName: true,
					createdAt: true,
					applicationStatus: true,
					description: true,
					serverId: true,
				},
			},
			project: true,
		},
	});
	if (!environment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Environment not found",
		});
	}
	return environment;
};

/** Environment + DNS fields + project name for domain provision/preview. */
export const findEnvironmentForDomain = async (environmentId: string) => {
	const environment = await db.query.environments.findFirst({
		where: eq(environments.environmentId, environmentId),
		columns: {
			environmentId: true,
			name: true,
			description: true,
			isDefault: true,
			projectId: true,
			dnsZoneId: true,
			domainPrefix: true,
		},
		with: {
			project: {
				columns: {
					projectId: true,
					name: true,
					organizationId: true,
				},
			},
		},
	});
	if (!environment?.project) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Environment not found",
		});
	}
	return environment;
};

export const findEnvironmentsByProjectId = async (projectId: string) => {
	const projectEnvironments = await db.query.environments.findMany({
		where: eq(environments.projectId, projectId),
		orderBy: asc(environments.createdAt),
		with: {
			applications: {
				columns: {
					customInstallCommand: false,
					customBuildCommand: false,
					customStartCommand: false,
				},
			},
			mariadb: true,
			mongo: true,
			mysql: true,
			postgres: true,
			redis: true,
			compose: true,
			libsql: true,
			project: true,
		},
		columns: {
			name: true,
			description: true,
			environmentId: true,
			isDefault: true,
		},
	});
	return projectEnvironments;
};

const environmentHasServices = (
	env: Awaited<ReturnType<typeof findEnvironmentById>>,
) => {
	return (
		(env.applications?.length ?? 0) > 0 ||
		(env.compose?.length ?? 0) > 0 ||
		(env.libsql?.length ?? 0) > 0 ||
		(env.mariadb?.length ?? 0) > 0 ||
		(env.mongo?.length ?? 0) > 0 ||
		(env.mysql?.length ?? 0) > 0 ||
		(env.postgres?.length ?? 0) > 0 ||
		(env.redis?.length ?? 0) > 0
	);
};

export const deleteEnvironment = async (environmentId: string) => {
	const currentEnvironment = await findEnvironmentById(environmentId);
	if (currentEnvironment.isDefault) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "You cannot delete the default environment",
		});
	}
	if (environmentHasServices(currentEnvironment)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Cannot delete environment: it has active services. Delete all services first.",
		});
	}
	const deletedEnvironment = await db
		.delete(environments)
		.where(eq(environments.environmentId, environmentId))
		.returning()
		.then((value) => value[0]);

	return deletedEnvironment;
};

export const updateEnvironmentById = async (
	environmentId: string,
	environmentData: Partial<Environment>,
) => {
	const result = await db
		.update(environments)
		.set({
			...environmentData,
		})
		.where(eq(environments.environmentId, environmentId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const duplicateEnvironment = async (
	input: z.infer<typeof apiDuplicateEnvironment>,
) => {
	// Find the original environment
	const originalEnvironment = await findEnvironmentById(input.environmentId);

	// Create a new environment with the provided name and description
	const newEnvironment = await db
		.insert(environments)
		.values({
			name: input.name,
			description: input.description || originalEnvironment.description,
			projectId: originalEnvironment.projectId,
			env: originalEnvironment.env,
		})
		.returning()
		.then((value) => value[0]);

	if (!newEnvironment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error duplicating the environment",
		});
	}

	return newEnvironment;
};

export const createDefaultEnvironment = async (
	projectId: string,
	tx: Pick<typeof db, "insert"> = db,
) => {
	const newEnvironment = await tx
		.insert(environments)
		.values({
			name: DEFAULT_PROJECT_ENVIRONMENT_NAME,
			description: "Default development environment",
			projectId,
			isDefault: true,
			env: "",
		})
		.returning()
		.then((value) => value[0]);

	if (!newEnvironment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the default environment",
		});
	}

	return newEnvironment;
};

export const createProductionEnvironment = async (projectId: string) => {
	const newEnvironment = await db
		.insert(environments)
		.values({
			name: "production",
			description: "Production environment",
			projectId,
			isDefault: false,
		})
		.returning()
		.then((value) => value[0]);

	if (!newEnvironment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the production environment",
		});
	}

	return newEnvironment;
};
