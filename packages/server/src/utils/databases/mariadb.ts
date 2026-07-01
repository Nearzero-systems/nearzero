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

export type MariadbNested = InferResultType<
	"mariadb",
	{ mounts: true; environment: { with: { project: true } } }
>;
export const buildMariadb = async (mariadb: MariadbNested) => {
	const {
		appName,
		env,
		externalPort,
		dockerImage,
		memoryLimit,
		memoryReservation,
		databaseName,
		databaseUser,
		databasePassword,
		databaseRootPassword,
		cpuLimit,
		cpuReservation,
		command,
		args,
		mounts,
		replicas,
	} = mariadb;

	const defaultMariadbEnv = `MARIADB_DATABASE="${databaseName}"\nMARIADB_USER="${databaseUser}"\nMARIADB_PASSWORD="${databasePassword}"\nMARIADB_ROOT_PASSWORD="${databaseRootPassword}"${
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
	} = generateConfigContainer(mariadb);
	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});
	const envVariables = prepareEnvironmentVariables(
		defaultMariadbEnv,
		mariadb.environment.project.env,
		mariadb.environment.env,
	);
	const volumesMount = generateVolumeMounts(mounts);
	const bindsMount = generateBindMounts(mounts);
	const filesMount = generateFileMounts(appName, mariadb);

	const docker = await getRemoteDocker(mariadb.serverId);

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
					Mode: "dnsrr" as const,
					Ports: externalPort
						? [
								{
									Protocol: "tcp" as const,
									TargetPort: 3306,
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
		serverId: mariadb.serverId,
		appName,
		replicas,
	});
};
