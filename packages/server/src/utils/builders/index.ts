import type { InferResultType } from "@nearzero/server/types/with";
import type { CreateServiceOptions } from "dockerode";
import type { ApplicationBuildType } from "../../types/application-build-plan";
import { getRegistryTag, uploadImageRemoteCommand } from "../cluster/upload";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateFileMounts,
	generateVolumeMounts,
	prepareEnvironmentVariables,
	upsertSwarmService,
} from "../docker/utils";
import { getRemoteDocker } from "../servers/remote-docker";
import { getDockerCommand } from "./docker-file";
import { getHerokuCommand } from "./heroku";
import { getNixpacksCommand } from "./nixpacks";
import { getPaketoCommand } from "./paketo";
import { getRailpackBuildCommand, getRailpackCommand } from "./railpack";
import { getStaticCommand } from "./static";

const getPositiveTimeout = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const RUNTIME_PORT_IMAGE_INSPECT_TIMEOUT_MS = getPositiveTimeout(
	process.env.RUNTIME_PORT_IMAGE_INSPECT_TIMEOUT_MS,
	10_000,
);

const withTimeout = async <T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
) => {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
};

// NIXPACKS codeDirectory = where is the path of the code directory
// HEROKU codeDirectory = where is the path of the code directory
// PAKETO codeDirectory = where is the path of the code directory
// DOCKERFILE codeDirectory = where is the exact path of the (Dockerfile)
export type ApplicationNested = InferResultType<
	"applications",
	{
		mounts: true;
		security: true;
		redirects: true;
		ports: true;
		registry: true;
		rollbackRegistry: true;
		deployments: true;
		environment: { with: { project: true } };
	}
>;

export const getBuildCommand = async (
	application: ApplicationNested,
	options: {
		buildServerId: string | null;
		buildType?: ApplicationBuildType;
		railpackPrepared?: boolean;
	},
) => {
	let command = "";
	const { buildServerId } = options;

	if (application.sourceType !== "docker") {
		const buildType = options.buildType ?? application.buildType;
		const buildApplication =
			buildType === application.buildType
				? application
				: ({ ...application, buildType } as ApplicationNested);
		switch (buildType) {
			case "nixpacks":
				command = getNixpacksCommand(buildApplication, buildServerId);
				break;
			case "heroku_buildpacks":
				command = getHerokuCommand(buildApplication, buildServerId);
				break;
			case "paketo_buildpacks":
				command = getPaketoCommand(buildApplication, buildServerId);
				break;
			case "static":
				command = getStaticCommand(buildApplication, buildServerId);
				break;
			case "dockerfile":
				command = getDockerCommand(buildApplication, buildServerId);
				break;
			case "railpack":
				command = options.railpackPrepared
					? getRailpackBuildCommand(buildApplication, buildServerId)
					: getRailpackCommand(buildApplication, buildServerId);
				break;
		}
	}

	if (application.registry || application.rollbackRegistry) {
		command += await uploadImageRemoteCommand(application);
	}

	return command;
};

export const mechanizeDockerContainer = async (
	application: ApplicationNested,
	options?: {
		deployServerId?: string | null;
		onProgress?: Parameters<typeof upsertSwarmService>[0]["onProgress"];
		stabilityOptions?: Parameters<
			typeof upsertSwarmService
		>[0]["stabilityOptions"];
	},
) => {
	const {
		appName,
		env,
		mounts,
		cpuLimit,
		memoryLimit,
		memoryReservation,
		cpuReservation,
		command,
		args,
		ports,
		replicas,
	} = application;

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
		StopGracePeriod,
		EndpointSpec,
		Ulimits,
	} = generateConfigContainer(application);

	const bindsMount = generateBindMounts(mounts);
	const filesMount = generateFileMounts(appName, application);
	const envVariables = prepareEnvironmentVariables(
		env,
		application.environment.project.env,
		application.environment.env,
	);

	const image = getImageName(application);
	const authConfig = getAuthConfig(application);
	const deployServerId =
		options?.deployServerId ?? application.serverId ?? null;
	const docker = await getRemoteDocker(deployServerId);

	const settings: CreateServiceOptions = {
		authconfig: authConfig,
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: image,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				...(StopGracePeriod !== null &&
					StopGracePeriod !== undefined && { StopGracePeriod }),
				...(command && {
					Command: command.split(" "),
				}),
				...(args &&
					args.length > 0 && {
						Args: args,
					}),
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
		EndpointSpec: EndpointSpec
			? EndpointSpec
			: {
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
		serverId: deployServerId,
		appName,
		replicas,
		onProgress: options?.onProgress,
		stabilityOptions: options?.stabilityOptions,
	});
};

export const getImageName = (application: ApplicationNested) => {
	const { appName, sourceType, dockerImage, registry } = application;
	const imageName = `${appName}:latest`;
	if (sourceType === "docker") {
		return dockerImage || "ERROR-NO-IMAGE-PROVIDED";
	}

	if (registry) {
		const registryTag = getRegistryTag(registry, imageName);
		return registryTag;
	}

	return imageName;
};

export const selectApplicationRuntimePort = (input: {
	configuredPorts?: Array<{
		targetPort: number;
		protocol?: string | null;
	}>;
	exposedPorts?: string[];
	buildType?: string | null;
	previewPort?: number | null;
}) => {
	const configuredPort = input.configuredPorts
		?.filter((port) => !port.protocol || port.protocol === "tcp")
		.map((port) => port.targetPort)
		.find((port) => Number.isInteger(port) && port > 0);
	if (configuredPort) {
		return configuredPort;
	}

	const exposedPorts = [
		...new Set(
			(input.exposedPorts ?? [])
				.filter((port) => port.endsWith("/tcp"))
				.map((port) => Number.parseInt(port.split("/")[0] ?? "", 10))
				.filter((port) => Number.isInteger(port) && port > 0),
		),
	];
	const preferredPorts = [80, 3000, 8080, 8000, 5000, 4173];
	for (const preferredPort of preferredPorts) {
		if (exposedPorts.includes(preferredPort)) {
			return preferredPort;
		}
	}
	if (exposedPorts.length > 0) {
		return exposedPorts.sort((left, right) => left - right)[0] ?? 3000;
	}

	if (input.buildType === "static") {
		return 80;
	}
	if (
		input.previewPort &&
		Number.isInteger(input.previewPort) &&
		input.previewPort > 0
	) {
		return input.previewPort;
	}
	return 3000;
};

export const resolveApplicationRuntimePort = async (
	application: ApplicationNested,
	serverId: string | null,
) => {
	let exposedPorts: string[] = [];
	try {
		const docker = await getRemoteDocker(serverId);
		const image = await withTimeout(
			docker.getImage(getImageName(application)).inspect(),
			RUNTIME_PORT_IMAGE_INSPECT_TIMEOUT_MS,
			"Timed out inspecting the built image for exposed ports.",
		);
		exposedPorts = Object.keys(image.Config?.ExposedPorts ?? {});
	} catch {
		// Some registries do not expose image metadata before deployment. The
		// deterministic builder/config fallback below still gives Traefik a route.
	}

	return selectApplicationRuntimePort({
		configuredPorts: application.ports,
		exposedPorts,
		buildType: application.buildType,
		previewPort: application.previewPort,
	});
};

export const getAuthConfig = (application: ApplicationNested) => {
	const { registry, username, password, sourceType, registryUrl } = application;

	if (sourceType === "docker") {
		if (username && password) {
			return {
				password,
				username,
				serveraddress: registryUrl || "",
			};
		}
	} else if (registry) {
		return {
			password: registry.password,
			username: registry.username,
			serveraddress: registry.registryUrl,
		};
	}

	return undefined;
};
