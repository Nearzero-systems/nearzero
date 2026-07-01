import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const platformEnv = join(root, "apps/platform/.env");
const platformEnvExample = join(root, "apps/platform/.env.example");
const consoleEnv = join(root, "apps/console/.env");
const consoleEnvExample = join(root, "apps/console/.env.example");

/** Swarm postgres created by apps/platform/setup.ts */
export const DEV_DATABASE_URL =
	"postgres://nearzero:nearzero-local-password@localhost:5432/nearzero";

export function log(message: string) {
	console.log(message);
}

export function fail(message: string, code = 1): never {
	console.error(message);
	process.exit(code);
}

export function runSync(
	label: string,
	command: string,
	args: string[],
	cwd = root,
): SpawnSyncReturns<string> {
	log(`→ ${label}`);
	const result = spawnSync(command, args, {
		cwd,
		stdio: "inherit",
		env: process.env,
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		fail(
			`${label} failed (exit ${result.status ?? "unknown"})`,
			result.status ?? 1,
		);
	}
	return result;
}

export function ensureEnvFile(target: string, example: string) {
	if (!existsSync(target) && existsSync(example)) {
		copyFileSync(example, target);
		log(`Created ${target.replace(`${root}/`, "")} from example`);
	}
}

type EnsureEnvFilesOptions = {
	localInfra?: boolean;
};

export function ensureEnvFiles(options: EnsureEnvFilesOptions = {}) {
	ensureEnvFile(platformEnv, platformEnvExample);
	ensureEnvFile(consoleEnv, consoleEnvExample);
	normalizePlatformEnv(options);
}

/** Point local .env at the swarm postgres/redis from platform setup. */
function normalizePlatformEnv({ localInfra = false }: EnsureEnvFilesOptions) {
	if (!existsSync(platformEnv)) return;
	if (!localInfra) return;

	let contents = readFileSync(platformEnv, "utf8");
	let changed = false;

	if (
		contents.includes("localhost:5433") ||
		contents.includes("nearzero-local-password") ||
		/^DATABASE_URL="?postgres:\/\/nearzero:[^@\s"]+@localhost:5432\/nearzero"?$/m.test(
			contents,
		)
	) {
		contents = contents.replace(
			/^DATABASE_URL=.*$/m,
			`DATABASE_URL="${DEV_DATABASE_URL}"`,
		);
		changed = true;
	}

	if (!/^REDIS_URL=/m.test(contents)) {
		contents = `${contents.trimEnd()}\nREDIS_URL=redis://127.0.0.1:6379\n`;
		changed = true;
	}

	if (changed) {
		writeFileSync(platformEnv, contents);
		log("Updated apps/platform/.env for local Docker infra");
	}
}

export async function waitForDocker(maxMs = 120_000) {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
		if (probe.status === 0) return;
		await Bun.sleep(2_000);
	}
	fail(
		"Docker is not running. Start Docker Desktop (or the Docker daemon) and run setup again.",
	);
}

export function isContainerRunning(name: string) {
	const result = spawnSync(
		"docker",
		["ps", "--filter", `name=^${name}`, "--filter", "status=running", "-q"],
		{ encoding: "utf8" },
	);
	return Boolean(result.stdout?.trim());
}

export function isSwarmServiceRunning(name: string) {
	const result = spawnSync(
		"docker",
		[
			"service",
			"ls",
			"--filter",
			`name=^${name}$`,
			"--format",
			"{{.Replicas}}",
		],
		{ encoding: "utf8" },
	);
	const replicas = result.stdout?.trim();
	return replicas === "1/1" || replicas?.startsWith("1/");
}

export function isDevInfraRunning() {
	return (
		(isContainerRunning("nearzero-postgres") ||
			isSwarmServiceRunning("nearzero-postgres")) &&
		(isContainerRunning("nearzero-redis") ||
			isSwarmServiceRunning("nearzero-redis"))
	);
}

export async function waitForPostgres(maxMs = 90_000) {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		const containerId = spawnSync(
			"docker",
			["ps", "--filter", "name=nearzero-postgres", "-q"],
			{ encoding: "utf8" },
		)
			.stdout?.trim()
			.split("\n")[0];

		if (containerId) {
			const probe = spawnSync(
				"docker",
				[
					"exec",
					"-e",
					"PGPASSWORD=nearzero-local-password",
					containerId,
					"psql",
					"-U",
					"nearzero",
					"-d",
					"nearzero",
					"-c",
					"select 1",
				],
				{ stdio: "ignore" },
			);
			if (probe.status === 0) return;
		}
		await Bun.sleep(1_000);
	}
	fail(
		"Postgres did not become ready. Check `docker ps` and nearzero-postgres logs.",
	);
}

export function runConsoleCheck() {
	runSync(
		"Console astro check",
		"bun",
		["run", "--filter", "@nearzero/console", "check"],
		root,
	);
}

export function buildServerPackages() {
	runSync(
		"Build @nearzero/server",
		"bunx",
		["tsx", "./esbuild.config.ts"],
		join(root, "packages/server"),
	);
	runSync(
		"Switch @nearzero/server to source exports",
		"bun",
		["run", "switch:dev"],
		join(root, "packages/server"),
	);
}

export function ensureMonitoringImage() {
	const hasImage =
		spawnSync("docker", [
			"image",
			"inspect",
			"ghcr.io/nearzero-systems/monitoring:nightly",
		], {
			stdio: "ignore",
		}).status === 0;

	if (hasImage) {
		log("Monitoring image ghcr.io/nearzero-systems/monitoring:nightly already exists");
		return;
	}

	runSync("Build ghcr.io/nearzero-systems/monitoring:nightly", "docker", [
		"build",
		"-f",
		"Dockerfile.monitoring",
		"-t",
		"ghcr.io/nearzero-systems/monitoring:nightly",
		".",
	]);
	runSync("Tag ghcr.io/nearzero-systems/monitoring:latest", "docker", [
		"tag",
		"ghcr.io/nearzero-systems/monitoring:nightly",
		"ghcr.io/nearzero-systems/monitoring:latest",
	]);
}

export function runPlatformSetup() {
	runSync("Nearzero platform setup (Docker infra)", "bun", [
		"run",
		"--filter",
		"@nearzero/platform",
		"setup",
	]);
}

export async function ensureDevInfra() {
	await waitForDocker();
	if (isDevInfraRunning()) {
		log("Docker infra already running (postgres + redis)");
		return;
	}
	log("Docker infra not running — starting setup…");
	runPlatformSetup();
	await waitForPostgres();
}

export async function waitForHealth(url: string, maxMs = 90_000) {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// still booting
		}
		await Bun.sleep(500);
	}
	fail(
		`Service did not become healthy at ${url}. Check apps/platform/.env and that the port is free.`,
	);
}

type DevUrlOptions = {
	console?: boolean;
	platform?: boolean;
	infra?: boolean;
};

export function printDevUrls(options: DevUrlOptions = {}) {
	const {
		console: showConsole = true,
		platform: showPlatform = true,
		infra: showInfra = false,
	} = options;

	log("");
	log(
		showInfra && !showConsole && !showPlatform
			? "Nearzero local infra is running:"
			: "Nearzero dev stack is running:",
	);
	if (showConsole) log("  Console:  http://localhost:4321");
	if (showPlatform) log("  Platform: http://localhost:3000");
	if (showInfra) {
		log("  Postgres: localhost:5432");
		log("  Redis:    localhost:6379");
	}
	log("");
}
