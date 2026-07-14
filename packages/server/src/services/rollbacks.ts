import type { CreateServiceOptions } from "dockerode";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type createRollbackSchema,
	deployments as deploymentsSchema,
	rollbacks,
} from "../db/schema";
import type { ApplicationNested } from "../utils/builders";
import { getRegistryTag } from "../utils/cluster/upload";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateVolumeMounts,
	prepareEnvironmentVariables,
	upsertSwarmService,
} from "../utils/docker/utils";
import { execAsyncRemote, execFileAsync } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import { type Application, findApplicationById } from "./application";
import { findDeploymentById } from "./deployment";
import type { Mount } from "./mount";
import type { Port } from "./port";
import type { Project } from "./project";
import { loginDockerRegistry, type Registry } from "./registry";

export type PublicRollback = Omit<typeof rollbacks.$inferSelect, "fullContext">;

export function toPublicRollback(
	value: typeof rollbacks.$inferSelect,
): PublicRollback {
	return {
		rollbackId: value.rollbackId,
		deploymentId: value.deploymentId,
		version: value.version,
		image: value.image,
		createdAt: value.createdAt,
	};
}

export const createRollback = async (
	input: z.infer<typeof createRollbackSchema>,
) => {
	try {
		return await db.transaction(async (tx) => {
			const { fullContext, ...other } = input;
			const rollback = await tx
				.insert(rollbacks)
				.values(other)
				.returning()
				.then((res) => res[0]);

			if (!rollback) {
				throw new Error("Failed to create rollback");
			}

			const tagImage = `${input.appName}:v${rollback.version}`;
			const deployment = await findDeploymentById(rollback.deploymentId);

			if (!deployment?.applicationId) {
				throw new Error("Deployment not found");
			}

			const {
				deployments: _,
				bitbucket,
				github,
				gitlab,
				gitea,
				...rest
			} = await findApplicationById(deployment.applicationId);

			await tx
				.update(rollbacks)
				.set({
					image: tagImage,
					fullContext: rest,
				})
				.where(eq(rollbacks.rollbackId, rollback.rollbackId));

			// Update the deployment to reference this rollback
			await tx
				.update(deploymentsSchema)
				.set({
					rollbackId: rollback.rollbackId,
				})
				.where(eq(deploymentsSchema.deploymentId, rollback.deploymentId));

			const updatedRollback = await tx.query.rollbacks.findFirst({
				where: eq(rollbacks.rollbackId, rollback.rollbackId),
			});

			return updatedRollback;
		});
	} catch {
		// Drizzle includes SQL parameters in its error message. The rollback
		// context contains application and registry secrets, so never propagate or
		// attach the original database error to queue/API-visible failures.
		throw new Error("Failed to create rollback metadata");
	}
};

export const findRollbackById = async (rollbackId: string) => {
	const result = await db.query.rollbacks.findFirst({
		where: eq(rollbacks.rollbackId, rollbackId),
		with: {
			deployment: {
				with: {
					application: {
						with: {
							environment: {
								with: {
									project: true,
								},
							},
						},
					},
				},
			},
		},
	});

	if (!result) {
		throw new Error("Rollback not found");
	}

	return result;
};

const deleteRollbackImage = async (image: string, serverId?: string | null) => {
	if (serverId) {
		const quotedImage = `'${image.replaceAll("'", `'"'"'`)}'`;
		await execAsyncRemote(
			serverId,
			`docker image rm --force -- ${quotedImage}`,
		);
	} else {
		await execFileAsync("docker", ["image", "rm", "--force", image]);
	}
};

export const removeRollbackById = async (rollbackId: string) => {
	const rollback = await findRollbackById(rollbackId);

	if (!rollback) {
		throw new Error("Rollback not found");
	}

	if (rollback.image) {
		const deployment = await findDeploymentById(rollback.deploymentId);

		if (!deployment?.applicationId) {
			throw new Error("Deployment not found");
		}

		const application = await findApplicationById(deployment.applicationId);
		await deleteRollbackImage(rollback.image, application.serverId);
	}

	const deleted = await db
		.delete(rollbacks)
		.where(eq(rollbacks.rollbackId, rollbackId))
		.returning()
		.then((res) => res[0]);
	if (!deleted) throw new Error("Rollback not found");
	return deleted;
};

export const rollback = async (rollbackId: string) => {
	const result = await findRollbackById(rollbackId);

	const deployment = await findDeploymentById(result.deploymentId);

	if (!deployment?.applicationId) {
		throw new Error("Deployment not found");
	}

	const application = await findApplicationById(deployment.applicationId);

	if (!result.fullContext) {
		throw new Error("Rollback context not found");
	}
	// Use the full context for rollback
	await rollbackApplication(
		application.appName,
		result.image || "",
		application.serverId,
		result.fullContext,
	);
};

const dockerLoginForRegistry = async (
	registry: Registry,
	serverId?: string | null,
) => {
	await loginDockerRegistry({
		registryUrl: registry.registryUrl,
		username: registry.username,
		password: registry.password,
		serverId,
	});
};

const rollbackApplication = async (
	appName: string,
	image: string,
	serverId?: string | null,
	fullContext?: Application & {
		environment: {
			project: Project;
		};
		mounts: Mount[];
		ports: Port[];
		rollbackRegistry?: Registry;
	},
) => {
	if (!fullContext) {
		throw new Error("Full context is required for rollback");
	}

	// Ensure Docker daemon is authenticated with the rollback registry
	// before updating the swarm service. The authconfig in CreateServiceOptions
	// alone is not sufficient — Docker Swarm also relies on the daemon's
	// cached credentials (~/.docker/config.json) to distribute auth to nodes.
	if (fullContext.rollbackRegistry) {
		await dockerLoginForRegistry(fullContext.rollbackRegistry, serverId);
	}

	const docker = await getRemoteDocker(serverId);

	// Use the same configuration as mechanizeDockerContainer
	const {
		env,
		mounts,
		cpuLimit,
		memoryLimit,
		memoryReservation,
		cpuReservation,
		command,
		ports,
		replicas,
	} = fullContext;

	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});

	const volumesMount = generateVolumeMounts(mounts);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
		Networks,
		Ulimits,
	} = generateConfigContainer(fullContext as ApplicationNested);

	const bindsMount = generateBindMounts(mounts);
	const envVariables = prepareEnvironmentVariables(
		env,
		fullContext.environment.project.env,
	);

	// Build the full registry image path if rollbackRegistry is available
	// e.g., "appName:v5" -> "nearzero/appName:v5" or "registry.com/prefix/appName:v5"
	let rollbackImage = image;
	if (fullContext.rollbackRegistry) {
		rollbackImage = getRegistryTag(fullContext.rollbackRegistry, image);
	}

	const settings: CreateServiceOptions = {
		authconfig: {
			password: fullContext.rollbackRegistry?.password || "",
			username: fullContext.rollbackRegistry?.username || "",
			serveraddress: fullContext.rollbackRegistry?.registryUrl || "",
		},
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: rollbackImage,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount],
				...(command
					? {
							Command: ["/bin/sh"],
							Args: ["-c", command],
						}
					: {}),
				...(Ulimits && { Ulimits }),
				Labels,
			},
			Networks,
			RestartPolicy,
			Placement,
			Resources: {
				...resources,
			},
		},
		Mode,
		RollbackConfig,
		EndpointSpec: {
			Ports: ports.map((port) => ({
				PublishMode: port.publishMode,
				Protocol: port.protocol,
				TargetPort: port.targetPort,
				PublishedPort: port.publishedPort,
			})),
		},
		UpdateConfig,
	};

	await upsertSwarmService({
		dockerClient: docker,
		settings,
		serverId,
		appName,
		replicas,
	});
};
