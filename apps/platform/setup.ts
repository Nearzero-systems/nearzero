import { exec } from "node:child_process";
import { exit } from "node:process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import { setupDirectories } from "@nearzero/server/setup/config-paths";
import { initializePostgres } from "@nearzero/server/setup/postgres-setup";
import { initializeRedis } from "@nearzero/server/setup/redis-setup";
import { isCommunityMode } from "@nearzero/server/services/runtime-mode";
import {
	initializeNetwork,
	initializeSwarm,
} from "@nearzero/server/setup/setup";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	initializeStandaloneTraefik,
	TRAEFIK_VERSION,
} from "@nearzero/server/setup/traefik-setup";

(async () => {
	try {
		if (!isCommunityMode()) {
			console.log(
				"Cloud control-plane mode does not install Docker, Swarm, Traefik, Postgres, or Redis locally. Configure remote deploy servers instead.",
			);
			exit(0);
		}

		setupDirectories();
		createDefaultMiddlewares();
		await initializeSwarm();
		await initializeNetwork();
		createDefaultTraefikConfig();
		createDefaultServerTraefikConfig();
		await execAsync(`docker pull traefik:v${TRAEFIK_VERSION}`);
		await initializeStandaloneTraefik();
		await initializeRedis();
		await initializePostgres();
		console.log("Nearzero setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in nearzero setup", e);
	}
})();
