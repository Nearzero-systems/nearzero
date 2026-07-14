import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ContainerCreateOptions, CreateServiceOptions } from "dockerode";
import { stringify } from "yaml";
import { paths } from "../constants";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import type { FileConfig } from "../utils/traefik/file-types";
import type { MainTraefikConfig } from "../utils/traefik/types";

const RESERVED_PUBLIC_PORTS = new Set([4500, 8080]);

export function normalizeTraefikPort(
	value: string | undefined,
	fallback: number,
	field: string,
) {
	const raw = value?.trim() || String(fallback);
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${field} must be an integer between 1 and 65535`);
	}
	const port = Number(raw);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${field} must be an integer between 1 and 65535`);
	}
	if (RESERVED_PUBLIC_PORTS.has(port)) {
		throw new Error(`${field} uses a port reserved by a Nearzero host service`);
	}
	return port;
}

export const TRAEFIK_SSL_PORT = normalizeTraefikPort(
	process.env.TRAEFIK_SSL_PORT,
	443,
	"TRAEFIK_SSL_PORT",
);
export const TRAEFIK_PORT = normalizeTraefikPort(
	process.env.TRAEFIK_PORT,
	80,
	"TRAEFIK_PORT",
);
export const TRAEFIK_HTTP3_PORT = normalizeTraefikPort(
	process.env.TRAEFIK_HTTP3_PORT,
	443,
	"TRAEFIK_HTTP3_PORT",
);
if (TRAEFIK_PORT === TRAEFIK_SSL_PORT) {
	throw new Error(
		"TRAEFIK_PORT and TRAEFIK_SSL_PORT must use different TCP ports",
	);
}

export function normalizeTraefikVersion(value: string) {
	const normalized = value.trim();
	if (
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(normalized)
	) {
		throw new Error("TRAEFIK_VERSION must be an exact semantic version");
	}
	return normalized;
}

export function normalizeDockerImageReference(value: string, field: string) {
	const normalized = value.trim();
	// Docker performs the full reference validation. This boundary additionally
	// guarantees that an administrator-provided reference remains one inert shell
	// word when it is embedded into the generated remote setup script. Digests,
	// registry ports, and conventional tag characters remain supported.
	if (
		!normalized ||
		normalized.length > 512 ||
		!/^[A-Za-z0-9][A-Za-z0-9._+:/@-]*$/.test(normalized)
	) {
		throw new Error(`${field} contains unsupported image-reference characters`);
	}
	return normalized;
}

export const TRAEFIK_VERSION = normalizeTraefikVersion(
	process.env.TRAEFIK_VERSION || "3.6.17",
);
export const TRAEFIK_IMAGE = normalizeDockerImageReference(
	process.env.TRAEFIK_IMAGE || `traefik:v${TRAEFIK_VERSION}`,
	"TRAEFIK_IMAGE",
);
export const TRAEFIK_SOCKET_PROXY_IMAGE = normalizeDockerImageReference(
	process.env.TRAEFIK_SOCKET_PROXY_IMAGE ||
		"ghcr.io/tecnativa/docker-socket-proxy:0.4.2",
	"TRAEFIK_SOCKET_PROXY_IMAGE",
);
export const TRAEFIK_SOCKET_PROXY_NAME = "nearzero-docker-proxy";
export const TRAEFIK_CONTROL_NETWORK = "nearzero-traefik-control";
export const TRAEFIK_DOCKER_ENDPOINT = `tcp://${TRAEFIK_SOCKET_PROXY_NAME}:2375`;

export interface TraefikOptions {
	env?: string[];
	serverId?: string;
	additionalPorts?: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[];
}

export function validateAdditionalTraefikPorts(
	ports: TraefikOptions["additionalPorts"] = [],
) {
	for (const port of ports) {
		if (
			!Number.isInteger(port.targetPort) ||
			port.targetPort < 1 ||
			port.targetPort > 65535 ||
			!Number.isInteger(port.publishedPort) ||
			port.publishedPort < 1 ||
			port.publishedPort > 65535
		) {
			throw new Error("Traefik ports must be integers between 1 and 65535");
		}
		if (!new Set(["tcp", "udp"]).has(port.protocol ?? "tcp")) {
			throw new Error("Traefik only supports TCP or UDP published ports");
		}
		if (RESERVED_PUBLIC_PORTS.has(port.publishedPort)) {
			throw new Error(
				`Port ${port.publishedPort} is reserved and cannot be published by Traefik`,
			);
		}
	}
	return ports;
}

const socketProxyEnv = [
	"ALLOW_START=0",
	"ALLOW_STOP=0",
	"ALLOW_RESTARTS=0",
	"AUTH=0",
	"BUILD=0",
	"COMMIT=0",
	"CONFIGS=0",
	"CONTAINERS=1",
	"EVENTS=1",
	"EXEC=0",
	"IMAGES=0",
	"INFO=1",
	"NETWORKS=1",
	"NODES=1",
	"PING=1",
	"PLUGINS=0",
	"POST=0",
	"SECRETS=0",
	"SERVICES=1",
	"SESSION=0",
	"SWARM=0",
	"SYSTEM=0",
	"TASKS=1",
	"VERSION=1",
	"VOLUMES=0",
];

async function pullDockerImage(
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	imageName: string,
) {
	const stream = await docker.pull(imageName);
	await new Promise<void>((resolve, reject) => {
		docker.modem.followProgress(stream, (error: unknown) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function assertContainerRunning(
	container: ReturnType<
		Awaited<ReturnType<typeof getRemoteDocker>>["getContainer"]
	>,
	label: string,
	waitMs = 1500,
) {
	await new Promise((resolve) => setTimeout(resolve, waitMs));
	const info = await container.inspect();
	if (!info.State.Running) {
		throw new Error(
			info.State.Error ||
				`${label} exited with code ${info.State.ExitCode ?? "unknown"}`,
		);
	}
}

/**
 * Validate a replacement without public ports, then cut over with a named
 * rollback container. Docker cannot mutate standalone container host bindings,
 * so deleting the active ingress first creates an avoidable outage and removes
 * the only rollback path.
 */
async function replaceStandaloneContainerSafely(
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	containerName: string,
	settings: ContainerCreateOptions,
	waitMs = 1500,
) {
	let existing: ReturnType<
		Awaited<ReturnType<typeof getRemoteDocker>>["getContainer"]
	> | null = null;
	try {
		existing = docker.getContainer(containerName);
		await existing.inspect();
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
		existing = null;
	}

	const suffix = randomUUID().slice(0, 8);
	const candidateName = `${containerName}-check-${suffix}`;
	const candidateSettings: ContainerCreateOptions = {
		...settings,
		name: candidateName,
		HostConfig: {
			...settings.HostConfig,
			NetworkMode: "none",
			PortBindings: {},
			RestartPolicy: { Name: "no" },
		},
		NetworkingConfig: undefined,
	};
	const candidate = await docker.createContainer(candidateSettings);
	try {
		await candidate.start();
		await assertContainerRunning(
			candidate,
			`${containerName} validation`,
			waitMs,
		);
	} finally {
		await candidate.remove({ force: true }).catch(() => undefined);
	}

	if (!existing) {
		const created = await docker.createContainer(settings);
		try {
			await created.start();
			await assertContainerRunning(created, containerName, waitMs);
			return;
		} catch (error) {
			await created.remove({ force: true }).catch(() => undefined);
			throw error;
		}
	}

	const rollbackName = `${containerName}-rollback-${suffix}`;
	await existing.stop().catch((error: { statusCode?: number }) => {
		if (error.statusCode !== 304) throw error;
	});
	await existing.rename({ name: rollbackName });

	try {
		const replacement = await docker.createContainer(settings);
		await replacement.start();
		await assertContainerRunning(replacement, containerName, waitMs);
		await docker
			.getContainer(rollbackName)
			.remove({ force: true })
			.catch(() => undefined);
	} catch (error) {
		await docker
			.getContainer(containerName)
			.remove({ force: true })
			.catch(() => undefined);
		const rollback = docker.getContainer(rollbackName);
		await rollback.rename({ name: containerName });
		await rollback.start();
		await assertContainerRunning(rollback, `${containerName} rollback`, waitMs);
		throw error;
	}
}

async function ensureStandaloneControlNetwork(
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
) {
	try {
		const info = await docker.getNetwork(TRAEFIK_CONTROL_NETWORK).inspect();
		if (info.Driver !== "bridge" || info.Internal !== true) {
			throw new Error(
				`${TRAEFIK_CONTROL_NETWORK} exists but is not an internal bridge network`,
			);
		}
	} catch (error) {
		const statusCode = (error as { statusCode?: number }).statusCode;
		if (statusCode !== 404) throw error;
		await docker.createNetwork({
			Name: TRAEFIK_CONTROL_NETWORK,
			Driver: "bridge",
			Internal: true,
		});
	}
}

async function ensureStandaloneSocketProxy(
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
) {
	await ensureStandaloneControlNetwork(docker);
	await pullDockerImage(docker, TRAEFIK_SOCKET_PROXY_IMAGE);
	const settings: ContainerCreateOptions = {
		name: TRAEFIK_SOCKET_PROXY_NAME,
		Image: TRAEFIK_SOCKET_PROXY_IMAGE,
		Env: socketProxyEnv,
		NetworkingConfig: {
			EndpointsConfig: {
				[TRAEFIK_CONTROL_NETWORK]: {},
			},
		},
		HostConfig: {
			Binds: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
			RestartPolicy: { Name: "always" },
			ReadonlyRootfs: true,
			SecurityOpt: ["no-new-privileges:true"],
			CapDrop: ["ALL"],
			Tmpfs: {
				"/run": "rw,noexec,nosuid,size=16m",
				"/tmp": "rw,noexec,nosuid,size=16m",
				"/var/lib/haproxy": "rw,noexec,nosuid,size=16m",
			},
		},
	};
	await replaceStandaloneContainerSafely(
		docker,
		TRAEFIK_SOCKET_PROXY_NAME,
		settings,
	);
}

async function ensureSwarmControlNetwork(
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
) {
	try {
		const info = await docker.getNetwork(TRAEFIK_CONTROL_NETWORK).inspect();
		if (info.Driver !== "overlay" || info.Internal !== true) {
			throw new Error(
				`${TRAEFIK_CONTROL_NETWORK} exists but is not an internal overlay network`,
			);
		}
	} catch (error) {
		const statusCode = (error as { statusCode?: number }).statusCode;
		if (statusCode !== 404) throw error;
		await docker.createNetwork({
			Name: TRAEFIK_CONTROL_NETWORK,
			Driver: "overlay",
			Internal: true,
			Attachable: false,
		});
	}
}

async function ensureSwarmSocketProxy(
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
) {
	await ensureSwarmControlNetwork(docker);
	await pullDockerImage(docker, TRAEFIK_SOCKET_PROXY_IMAGE);
	const settings: CreateServiceOptions = {
		Name: TRAEFIK_SOCKET_PROXY_NAME,
		TaskTemplate: {
			ContainerSpec: {
				Image: TRAEFIK_SOCKET_PROXY_IMAGE,
				Env: socketProxyEnv,
				ReadOnly: true,
				CapabilityDrop: ["ALL"],
				Mounts: [
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
						ReadOnly: true,
					},
					{
						Type: "tmpfs",
						Source: "",
						Target: "/run",
						TmpfsOptions: { SizeBytes: 16 * 1024 * 1024, Mode: 0o755 },
					},
					{
						Type: "tmpfs",
						Source: "",
						Target: "/tmp",
						TmpfsOptions: { SizeBytes: 16 * 1024 * 1024, Mode: 0o1777 },
					},
					{
						Type: "tmpfs",
						Source: "",
						Target: "/var/lib/haproxy",
						TmpfsOptions: { SizeBytes: 16 * 1024 * 1024, Mode: 0o755 },
					},
				],
			},
			Networks: [{ Target: TRAEFIK_CONTROL_NETWORK }],
			Placement: { Constraints: ["node.role==manager"] },
		},
		Mode: { Replicated: { Replicas: 1 } },
	};

	try {
		const service = docker.getService(TRAEFIK_SOCKET_PROXY_NAME);
		const inspect = await service.inspect();
		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1,
			},
		});
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
		await docker.createService(settings);
	}
}

const resolveLocalNearzeroVolume = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	serverId?: string,
) => {
	if (serverId) return null;
	const containerId = process.env.HOSTNAME?.trim();
	if (!containerId) return null;

	try {
		const currentContainer = await docker.getContainer(containerId).inspect();
		const mount = currentContainer.Mounts?.find(
			(item) => item.Name && item.Destination === "/etc/nearzero",
		);
		return mount?.Name || mount?.Source || null;
	} catch {
		return null;
	}
};

export const initializeStandaloneTraefik = async ({
	env,
	serverId,
	additionalPorts = [],
}: TraefikOptions = {}) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const imageName = TRAEFIK_IMAGE;
	const containerName = "nearzero-traefik";
	const docker = await getRemoteDocker(serverId);
	const nearzeroVolume = await resolveLocalNearzeroVolume(docker, serverId);
	validateAdditionalTraefikPorts(additionalPorts);
	await ensureStandaloneSocketProxy(docker);

	const exposedPorts: Record<string, {}> = {
		[`${TRAEFIK_PORT}/tcp`]: {},
		[`${TRAEFIK_SSL_PORT}/tcp`]: {},
		[`${TRAEFIK_SSL_PORT}/udp`]: {},
	};

	const portBindings: Record<string, Array<{ HostPort: string }>> = {
		[`${TRAEFIK_PORT}/tcp`]: [{ HostPort: TRAEFIK_PORT.toString() }],
		[`${TRAEFIK_SSL_PORT}/tcp`]: [{ HostPort: TRAEFIK_SSL_PORT.toString() }],
		[`${TRAEFIK_SSL_PORT}/udp`]: [{ HostPort: TRAEFIK_HTTP3_PORT.toString() }],
	};

	for (const port of additionalPorts) {
		const portKey = `${port.targetPort}/${port.protocol ?? "tcp"}`;
		exposedPorts[portKey] = {};
		portBindings[portKey] = [{ HostPort: port.publishedPort.toString() }];
	}

	const settings: ContainerCreateOptions = {
		name: containerName,
		Image: imageName,
		...(nearzeroVolume && {
			Cmd: ["--configFile=/etc/nearzero/traefik/traefik.yml"],
		}),
		NetworkingConfig: {
			EndpointsConfig: {
				"nearzero-network": {},
				[TRAEFIK_CONTROL_NETWORK]: {},
			},
		},
		ExposedPorts: exposedPorts,
		HostConfig: {
			RestartPolicy: {
				Name: "always",
			},
			Binds: [
				...(nearzeroVolume
					? []
					: [
							`${MAIN_TRAEFIK_PATH}/traefik.yml:/etc/traefik/traefik.yml:ro`,
							`${DYNAMIC_TRAEFIK_PATH}:/etc/nearzero/traefik/dynamic`,
						]),
			],
			SecurityOpt: ["no-new-privileges:true"],
			ReadonlyRootfs: true,
			CapDrop: ["ALL"],
			CapAdd: ["NET_BIND_SERVICE"],
			Tmpfs: {
				"/tmp": "rw,noexec,nosuid,size=16m",
			},
			...(nearzeroVolume && {
				Mounts: [
					{
						Type: "volume",
						Source: nearzeroVolume,
						Target: "/etc/nearzero",
					},
				],
			}),
			PortBindings: portBindings,
		},
		Env: env,
	};

	await pullDockerImage(docker, imageName);
	console.log("Traefik Image Pulled ✅");
	try {
		await replaceStandaloneContainerSafely(
			docker,
			containerName,
			settings,
			2500,
		);
		console.log("Traefik Started ✅");
	} catch (error) {
		console.error("Could not start Traefik", error);
		throw error;
	}
};

export const initializeTraefikService = async ({
	env,
	additionalPorts = [],
	serverId,
}: TraefikOptions) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const imageName = TRAEFIK_IMAGE;
	const appName = "nearzero-traefik";
	const docker = await getRemoteDocker(serverId);
	const nearzeroVolume = await resolveLocalNearzeroVolume(docker, serverId);
	validateAdditionalTraefikPorts(additionalPorts);
	await ensureSwarmSocketProxy(docker);

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: env,
				ReadOnly: true,
				CapabilityDrop: ["ALL"],
				CapabilityAdd: ["NET_BIND_SERVICE"],
				...(nearzeroVolume && {
					Args: ["--configFile=/etc/nearzero/traefik/traefik.yml"],
				}),
				Mounts: [
					...(nearzeroVolume
						? [
								{
									Type: "volume" as const,
									Source: nearzeroVolume,
									Target: "/etc/nearzero",
								},
							]
						: [
								{
									Type: "bind" as const,
									Source: `${MAIN_TRAEFIK_PATH}/traefik.yml`,
									Target: "/etc/traefik/traefik.yml",
								},
								{
									Type: "bind" as const,
									Source: DYNAMIC_TRAEFIK_PATH,
									Target: "/etc/nearzero/traefik/dynamic",
								},
							]),
					{
						Type: "tmpfs" as const,
						Source: "",
						Target: "/tmp",
						TmpfsOptions: { SizeBytes: 16 * 1024 * 1024, Mode: 0o1777 },
					},
				],
			},
			Networks: [
				{ Target: "nearzero-network" },
				{ Target: TRAEFIK_CONTROL_NETWORK },
			],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		UpdateConfig: {
			Parallelism: 1,
			Delay: 0,
			Monitor: 10_000_000_000,
			FailureAction: "rollback",
			MaxFailureRatio: 0,
			Order: "stop-first",
		},
		RollbackConfig: {
			Parallelism: 1,
			Delay: 0,
			Monitor: 10_000_000_000,
			FailureAction: "pause",
			MaxFailureRatio: 0,
			Order: "stop-first",
		},
		EndpointSpec: {
			Ports: [
				{
					TargetPort: TRAEFIK_SSL_PORT,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},
				{
					TargetPort: TRAEFIK_SSL_PORT,
					PublishedPort: TRAEFIK_HTTP3_PORT,
					PublishMode: "host",
					Protocol: "udp",
				},
				{
					TargetPort: TRAEFIK_PORT,
					PublishedPort: TRAEFIK_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},

				...additionalPorts.map((port) => ({
					TargetPort: port.targetPort,
					PublishedPort: port.publishedPort,
					Protocol: port.protocol as "tcp" | "udp" | undefined,
					PublishMode: "host" as const,
				})),
			],
		},
	};
	try {
		const service = docker.getService(appName);
		const inspect = await service.inspect();

		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1,
			},
		});
		console.log("Traefik Updated ✅");
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
		await docker.createService(settings);
		console.log("Traefik Started ✅");
	}
};

export const createDefaultServerTraefikConfig = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configFilePath = path.join(DYNAMIC_TRAEFIK_PATH, "nearzero.yml");

	if (existsSync(configFilePath)) {
		console.log("Default traefik config already exists");
		return;
	}

	const appName = "nearzero";
	const serviceURLDefault = `http://${appName}:${process.env.PORT || 3000}`;
	const config: FileConfig = {
		http: {
			routers: {
				[`${appName}-router-app`]: {
					rule: `Host(\`${appName}.docker.localhost\`) && PathPrefix(\`/\`)`,
					service: `${appName}-service-app`,
					entryPoints: ["web"],
				},
			},
			services: {
				[`${appName}-service-app`]: {
					loadBalancer: {
						servers: [{ url: serviceURLDefault }],
						passHostHeader: true,
					},
				},
			},
		},
	};

	const yamlStr = stringify(config);
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`), yamlStr, {
		encoding: "utf8",
		mode: 0o600,
	});
};

export const getDefaultTraefikConfig = () => {
	const configObject: MainTraefikConfig = {
		global: {
			checkNewVersion: false,
			sendAnonymousUsage: false,
		},
		providers: {
			...(process.env.NODE_ENV === "development"
				? {
						docker: {
							endpoint: TRAEFIK_DOCKER_ENDPOINT,
							defaultRule:
								"Host(`{{ trimPrefix `/` .Name }}.docker.localhost`)",
						},
					}
				: {
						swarm: {
							endpoint: TRAEFIK_DOCKER_ENDPOINT,
							exposedByDefault: false,
							watch: true,
						},
						docker: {
							endpoint: TRAEFIK_DOCKER_ENDPOINT,
							exposedByDefault: false,
							watch: true,
							network: "nearzero-network",
						},
					}),
			file: {
				directory: "/etc/nearzero/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
			},
		},
		api: {
			dashboard: true,
			insecure: false,
		},
		...(process.env.NODE_ENV === "production" && {
			certificatesResolvers: {
				letsencrypt: {
					acme: {
						storage: "/etc/nearzero/traefik/dynamic/acme.json",
						httpChallenge: {
							entryPoint: "web",
						},
					},
				},
			},
		}),
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const getDefaultServerTraefikConfig = (acmeEmail?: string | null) => {
	const configObject: MainTraefikConfig = {
		global: {
			checkNewVersion: false,
			sendAnonymousUsage: false,
		},
		providers: {
			swarm: {
				endpoint: TRAEFIK_DOCKER_ENDPOINT,
				exposedByDefault: false,
				watch: true,
			},
			docker: {
				endpoint: TRAEFIK_DOCKER_ENDPOINT,
				exposedByDefault: false,
				watch: true,
				network: "nearzero-network",
			},
			file: {
				directory: "/etc/nearzero/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
			},
		},
		api: {
			dashboard: true,
			insecure: false,
		},
		certificatesResolvers: {
			letsencrypt: {
				acme: {
					...(acmeEmail?.trim() ? { email: acmeEmail.trim() } : {}),
					storage: "/etc/nearzero/traefik/dynamic/acme.json",
					httpChallenge: {
						entryPoint: "web",
					},
				},
			},
		},
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const createDefaultTraefikConfig = () => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths();
	const mainConfig = path.join(MAIN_TRAEFIK_PATH, "traefik.yml");
	const acmeJsonPath = path.join(DYNAMIC_TRAEFIK_PATH, "acme.json");

	// Create protected Traefik and ACME storage before the container starts.
	mkdirSync(MAIN_TRAEFIK_PATH, { recursive: true, mode: 0o700 });
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true, mode: 0o700 });
	chmodSync(MAIN_TRAEFIK_PATH, 0o700);
	chmodSync(DYNAMIC_TRAEFIK_PATH, 0o700);
	if (!existsSync(acmeJsonPath)) {
		writeFileSync(acmeJsonPath, "", {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	}
	chmodSync(acmeJsonPath, 0o600);

	// Check if traefik.yml exists and handle the case where it might be a directory
	if (existsSync(mainConfig)) {
		const stats = statSync(mainConfig);
		if (stats.isDirectory()) {
			// If traefik.yml is a directory, remove it
			console.log("Found traefik.yml as directory, removing it...");
			rmSync(mainConfig, { recursive: true, force: true });
		} else if (stats.isFile()) {
			chmodSync(mainConfig, 0o600);
			console.log("Main config already exists");
			return;
		}
	}

	const yamlStr = getDefaultTraefikConfig();
	writeFileSync(mainConfig, yamlStr, { encoding: "utf8", mode: 0o600 });
	console.log("Traefik config created successfully");
};

export const getDefaultMiddlewares = () => {
	const defaultMiddlewares = {
		http: {
			middlewares: {
				"redirect-to-https": {
					redirectScheme: {
						scheme: "https",
						permanent: true,
					},
				},
			},
		},
	};
	const yamlStr = stringify(defaultMiddlewares);
	return yamlStr;
};
export const createDefaultMiddlewares = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const middlewaresPath = path.join(DYNAMIC_TRAEFIK_PATH, "middlewares.yml");
	if (existsSync(middlewaresPath)) {
		console.log("Default middlewares already exists");
		return;
	}
	const yamlStr = getDefaultMiddlewares();
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true, mode: 0o700 });
	writeFileSync(middlewaresPath, yamlStr, {
		encoding: "utf8",
		mode: 0o600,
	});
};
