import type { InferResultType } from "@nearzero/server/types/with";
import type { CreateServiceOptions } from "dockerode";
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

export type RedisNested = InferResultType<
	"redis",
	{ mounts: true; environment: { with: { project: true } } }
>;
export const buildRedis = async (redis: RedisNested) => {
	const {
		appName,
		env,
		externalPort,
		dockerImage,
		memoryLimit,
		memoryReservation,
		databasePassword,
		cpuLimit,
		cpuReservation,
		command,
		args,
		mounts,
		replicas,
	} = redis;

	const defaultRedisEnv = `REDIS_PASSWORD="${databasePassword}"${
		env ? `\n${env}` : ""
	}`;

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
	} = generateConfigContainer(redis);
	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});
	const envVariables = prepareEnvironmentVariables(
		defaultRedisEnv,
		redis.environment.project.env,
		redis.environment.env,
	);
	const volumesMount = generateVolumeMounts(mounts);
	const bindsMount = generateBindMounts(mounts);
	const filesMount = generateFileMounts(appName, redis);

	const docker = await getRemoteDocker(redis.serverId);

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: dockerImage,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				...(StopGracePeriod !== null &&
					StopGracePeriod !== undefined && { StopGracePeriod }),
				...(command || args
					? {
							...(command && {
								Command: command.split(" "),
							}),
							...(args &&
								args.length > 0 && {
									Args: args,
								}),
						}
					: {
							Command: ["/bin/sh"],
							// Keep the credential out of the service command/Args and the
							// host process list. The service environment remains a Docker
							// manager trust boundary, consistent with the other databases.
							Args: ["-c", 'exec redis-server --requirepass "$REDIS_PASSWORD"'],
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
					Mode: "dnsrr" as const,
					Ports: externalPort
						? [
								{
									Protocol: "tcp" as const,
									TargetPort: 6379,
									PublishedPort: externalPort,
									PublishMode: "host" as const,
								},
							]
						: [],
				},
		UpdateConfig,
	};

	await upsertSwarmService({
		dockerClient: docker,
		settings,
		serverId: redis.serverId,
		appName,
		replicas,
	});
};
