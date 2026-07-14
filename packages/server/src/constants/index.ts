import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";

export {
	getPlatformDefaultDomain,
	isStripeConfigured,
	shouldEnforceCloudBilling,
} from "./billing";

export {
	isSubscriptionFeatureEnabled,
	SUBSCRIPTION_FEATURES,
	type SubscriptionFeature,
	type SubscriptionFeatureContext,
	shouldHideSubscriptionFeature,
} from "./subscription-features";

export const NEARZERO_DOCKER_API_VERSION =
	process.env.NEARZERO_DOCKER_API_VERSION;
export const NEARZERO_DOCKER_HOST = process.env.NEARZERO_DOCKER_HOST;
export const NEARZERO_DOCKER_PORT = process.env.NEARZERO_DOCKER_PORT
	? Number(process.env.NEARZERO_DOCKER_PORT)
	: undefined;

export const CLEANUP_CRON_JOB = "50 23 * * *";

type DockerSocketCandidate = {
	label: string;
	path: string;
};

const canAccessDockerSocket = (candidate: DockerSocketCandidate) => {
	try {
		if (!candidate.path || !fs.existsSync(candidate.path)) {
			return false;
		}
		fs.accessSync(candidate.path, fs.constants.R_OK | fs.constants.W_OK);
		return true;
	} catch (e) {
		console.info(
			`Docker socket skipped for ${candidate.label} (${candidate.path}): ${e instanceof Error ? e.message : "not accessible"}`,
		);
		return false;
	}
};

const getDockerConfig = (): Docker => {
	const versionOption = NEARZERO_DOCKER_API_VERSION
		? { version: NEARZERO_DOCKER_API_VERSION }
		: {};

	// Explicit remote Docker host configuration
	if (NEARZERO_DOCKER_HOST) {
		console.info(
			`Using remote Docker host: ${NEARZERO_DOCKER_HOST}${NEARZERO_DOCKER_PORT ? `:${NEARZERO_DOCKER_PORT}` : ""}`,
		);
		return new Docker({
			host: NEARZERO_DOCKER_HOST,
			...(NEARZERO_DOCKER_PORT && { port: NEARZERO_DOCKER_PORT }),
			...versionOption,
		});
	}

	// Local socket auto-detection (Rancher Desktop, Colima, standard Docker)
	const dockerSocketCandidates: Array<DockerSocketCandidate> = [];

	if (process.env.DOCKER_HOST) {
		dockerSocketCandidates.push({
			label: "DOCKER_HOST environment variable",
			path: process.env.DOCKER_HOST.replace("unix://", ""),
		});
	}

	if (process.env.HOME) {
		dockerSocketCandidates.push({
			label: "Docker Desktop socket",
			path: `${process.env.HOME}/.docker/run/docker.sock`,
		});
		dockerSocketCandidates.push({
			label: "Rancher Desktop socket",
			path: `${process.env.HOME}/.rd/docker.sock`,
		});
		dockerSocketCandidates.push({
			label: "Colima socket",
			path: `${process.env.HOME}/.colima/default/docker.sock`,
		});
	}

	dockerSocketCandidates.push({
		label: "Standard Docker socket",
		path: "/var/run/docker.sock",
	});

	for (const candidate of dockerSocketCandidates) {
		if (canAccessDockerSocket(candidate)) {
			console.info(
				`Using Docker socket (${candidate.label}): ${candidate.path}`,
			);
			return new Docker({
				socketPath: candidate.path,
				...versionOption,
			});
		}
	}

	console.info(
		"Using default Docker configuration. You can set the DOCKER_HOST environment variable to specify a custom Docker socket path.",
	);
	return new Docker({ ...versionOption });
};

let _docker: Docker | undefined;
export const getDocker = (): Docker => {
	if (!_docker) {
		_docker = getDockerConfig();
	}
	return _docker;
};

export const paths = (isServer = false) => {
	const BASE_PATH =
		isServer || process.env.NODE_ENV === "production"
			? "/etc/nearzero"
			: path.join(process.cwd(), ".docker");
	const MAIN_TRAEFIK_PATH = `${BASE_PATH}/traefik`;
	const DYNAMIC_TRAEFIK_PATH = `${MAIN_TRAEFIK_PATH}/dynamic`;

	return {
		BASE_PATH,
		MAIN_TRAEFIK_PATH,
		DYNAMIC_TRAEFIK_PATH,
		LOGS_PATH: `${BASE_PATH}/logs`,
		APPLICATIONS_PATH: `${BASE_PATH}/applications`,
		COMPOSE_PATH: `${BASE_PATH}/compose`,
		COMPOSE_ENV_PATH: `${BASE_PATH}/secrets/compose-env`,
		SSH_PATH: `${BASE_PATH}/ssh`,
		CERTIFICATES_PATH: `${DYNAMIC_TRAEFIK_PATH}/certificates`,
		MONITORING_PATH: `${BASE_PATH}/monitoring`,
		REGISTRY_PATH: `${BASE_PATH}/registry`,
		SCHEDULES_PATH: `${BASE_PATH}/schedules`,
		VOLUME_BACKUPS_PATH: `${BASE_PATH}/volume-backups`,
		VOLUME_BACKUP_LOCK_PATH: `${BASE_PATH}/volume-backup-lock`,
		PATCH_REPOS_PATH: `${BASE_PATH}/patch-repos`,
		DNS_PATH: `${BASE_PATH}/dns`,
		DNS_ZONES_PATH: `${BASE_PATH}/dns/zones`,
		DNS_COREFILE_PATH: `${BASE_PATH}/dns/Corefile`,
	};
};
