import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { paths } from "../constants";

const createDirectoryIfNotExist = (dirPath: string) => {
	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, { recursive: true });
		console.log(`Directory created: ${dirPath}`);
	}
};

export const setupDirectories = () => {
	const {
		APPLICATIONS_PATH,
		BASE_PATH,
		CERTIFICATES_PATH,
		COMPOSE_ENV_PATH,
		COMPOSE_PATH,
		DNS_PATH,
		DNS_ZONES_PATH,
		DYNAMIC_TRAEFIK_PATH,
		LOGS_PATH,
		MAIN_TRAEFIK_PATH,
		MONITORING_PATH,
		PATCH_REPOS_PATH,
		REGISTRY_PATH,
		SSH_PATH,
		SCHEDULES_PATH,
		VOLUME_BACKUPS_PATH,
	} = paths();
	const directories = [
		BASE_PATH,
		MAIN_TRAEFIK_PATH,
		DYNAMIC_TRAEFIK_PATH,
		LOGS_PATH,
		APPLICATIONS_PATH,
		COMPOSE_PATH,
		COMPOSE_ENV_PATH,
		SSH_PATH,
		CERTIFICATES_PATH,
		MONITORING_PATH,
		REGISTRY_PATH,
		SCHEDULES_PATH,
		VOLUME_BACKUPS_PATH,
		PATCH_REPOS_PATH,
		DNS_PATH,
		DNS_ZONES_PATH,
	];

	for (const dir of directories) {
		try {
			createDirectoryIfNotExist(dir);
			chmodSync(dir, "700");
		} catch (error) {
			console.log(error, " On path: ", dir);
		}
	}
};
