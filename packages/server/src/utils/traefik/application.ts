import { randomUUID } from "node:crypto";
import fs, { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { paths } from "@nearzero/server/constants";
import type { Domain } from "@nearzero/server/services/domain";
import { parse, stringify } from "yaml";
import { encodeBase64 } from "../docker/utils";
import { execAsyncRemote } from "../process/execAsync";
import type { FileConfig, HttpLoadBalancerService } from "./file-types";

const TRAEFIK_CONFIG_EXTENSIONS = new Set([".yml", ".yaml"]);
const SAFE_TRAEFIK_PATH = /^[A-Za-z0-9._/-]+$/;
const REMOTE_CONFIG_MISSING_MARKER = "__NEARZERO_CONFIG_MISSING__";
const TRAEFIK_LOCK_TIMEOUT_MS = 30_000;
const TRAEFIK_LOCK_STALE_MS = 10 * 60_000;

function isPathInside(basePath: string, candidatePath: string) {
	return (
		candidatePath === basePath ||
		candidatePath.startsWith(`${basePath}${path.sep}`)
	);
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeTraefikObjectName(value: string) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
		throw new Error("Traefik object name is not safe");
	}
	return value;
}

function localDynamicConfigPath(appName: string) {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	return path.join(
		DYNAMIC_TRAEFIK_PATH,
		`${safeTraefikObjectName(appName)}.yml`,
	);
}

function readLocalConfigFile(configPath: string) {
	if (!fs.existsSync(configPath)) return null;
	const fileStat = fs.lstatSync(configPath);
	if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
		throw new Error("Traefik config must be a regular file");
	}
	const parent = fs.realpathSync(path.dirname(configPath));
	const target = fs.realpathSync(configPath);
	if (!isPathInside(parent, target)) {
		throw new Error("Traefik config path escapes its managed directory");
	}
	return fs.readFileSync(target, "utf8");
}

function writeLocalConfigAtomic(configPath: string, contents: string) {
	const directory = path.dirname(configPath);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const realDirectory = fs.realpathSync(directory);
	const targetPath = path.join(realDirectory, path.basename(configPath));
	const temporaryPath = path.join(
		realDirectory,
		`.nearzero-config.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		fs.writeFileSync(temporaryPath, contents, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		fs.renameSync(temporaryPath, targetPath);
		fs.chmodSync(targetPath, 0o600);
	} finally {
		fs.rmSync(temporaryPath, { force: true });
	}
}

function remoteConfigReadCommand(configPath: string, managedRoot: string) {
	return `set -eu
config=${shellQuote(configPath)}
if [ ! -e "$config" ]; then
	if [ -L "$config" ]; then
		echo 'Traefik config cannot be a symbolic link' >&2
		exit 65
	fi
	printf '%s' ${shellQuote(REMOTE_CONFIG_MISSING_MARKER)}
	exit 0
fi
if [ ! -f "$config" ] || [ -L "$config" ]; then
	echo 'Traefik config must be a regular file' >&2
	exit 65
fi
target=$(readlink -f -- "$config")
case "$target" in
	${shellQuote(`${managedRoot}/`)}*) ;;
	*) echo 'Traefik config path escapes the managed directory' >&2; exit 65 ;;
esac
cat -- "$target"`;
}

const wait = (milliseconds: number) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Serialize Traefik read/modify/write mutations across requests and processes. */
export async function withTraefikMutationLock<T>(
	serverId: string | null | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	const token = randomUUID();
	const { MAIN_TRAEFIK_PATH } = paths(Boolean(serverId));
	const lockPath = path.join(MAIN_TRAEFIK_PATH, ".nearzero-mutation.lock");
	const ownerPath = path.join(lockPath, "owner");

	if (serverId) {
		await execAsyncRemote(
			serverId,
			`set -eu
mkdir -p -- ${shellQuote(MAIN_TRAEFIK_PATH)}
acquired=false
for attempt in $(seq 1 150); do
	if mkdir -- ${shellQuote(lockPath)} 2>/dev/null; then
		acquired=true
		break
	fi
	if [ -d ${shellQuote(lockPath)} ]; then
		now=$(date +%s)
		modified=$(stat -c %Y -- ${shellQuote(lockPath)} 2>/dev/null || echo "$now")
		if [ $((now - modified)) -gt ${Math.floor(TRAEFIK_LOCK_STALE_MS / 1000)} ]; then
			rm -rf -- ${shellQuote(lockPath)}
			continue
		fi
	fi
	sleep 0.2
done
if [ "$acquired" != true ]; then
	echo 'Timed out waiting for the Traefik configuration lock' >&2
	exit 75
fi
printf '%s' ${shellQuote(token)} > ${shellQuote(ownerPath)}
chmod 700 ${shellQuote(lockPath)}
chmod 600 ${shellQuote(ownerPath)}`,
		);
		try {
			return await operation();
		} finally {
			await execAsyncRemote(
				serverId,
				`set -eu
if [ -f ${shellQuote(ownerPath)} ] && [ "$(cat -- ${shellQuote(ownerPath)})" = ${shellQuote(token)} ]; then
	rm -rf -- ${shellQuote(lockPath)}
fi`,
			).catch(() => undefined);
		}
	}

	fs.mkdirSync(MAIN_TRAEFIK_PATH, { recursive: true, mode: 0o700 });
	const deadline = Date.now() + TRAEFIK_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			fs.writeFileSync(ownerPath, token, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (
					Date.now() - fs.statSync(lockPath).mtimeMs >
					TRAEFIK_LOCK_STALE_MS
				) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
					throw statError;
				}
			}
			if (Date.now() >= deadline) {
				throw new Error("Timed out waiting for the Traefik configuration lock");
			}
			await wait(200);
		}
	}

	try {
		return await operation();
	} finally {
		try {
			if (fs.readFileSync(ownerPath, "utf8") === token) {
				fs.rmSync(lockPath, { recursive: true, force: true });
			}
		} catch {
			// A stale-lock recovery may already have removed it.
		}
	}
}

/**
 * Resolve a user-selected Traefik YAML path beneath the managed Traefik root.
 * This is the authoritative boundary for both local and remote file APIs.
 */
export function resolveTraefikConfigPath(pathFile: string, remote = false) {
	const input = pathFile.trim();
	if (!input || input.length > 4096 || !SAFE_TRAEFIK_PATH.test(input)) {
		throw new Error("Traefik config path contains unsupported characters");
	}
	const basePath = path.resolve(paths(remote).MAIN_TRAEFIK_PATH);
	const candidatePath = path.isAbsolute(input)
		? path.resolve(input)
		: path.resolve(basePath, input);
	if (
		candidatePath === basePath ||
		!isPathInside(basePath, candidatePath) ||
		!TRAEFIK_CONFIG_EXTENSIONS.has(path.extname(candidatePath).toLowerCase())
	) {
		throw new Error(
			"Traefik config path must be a .yml or .yaml file inside the managed Traefik directory",
		);
	}
	return { basePath, candidatePath };
}

export const createTraefikConfig = (appName: string) => {
	safeTraefikObjectName(appName);
	const defaultPort = 3000;
	const serviceURLDefault = `http://${appName}:${defaultPort}`;
	const domainDefault = `Host(\`${appName}.docker.localhost\`)`;
	const config: FileConfig = {
		http: {
			routers: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${appName}-router-1`]: {
								rule: domainDefault,
								service: `${appName}-service-1`,
								entryPoints: ["web"],
							},
						}),
			},

			services: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${appName}-service-1`]: {
								loadBalancer: {
									servers: [{ url: serviceURLDefault }],
									passHostHeader: true,
								},
							},
						}),
			},
		},
	};
	const yamlStr = stringify(config);
	writeLocalConfigAtomic(localDynamicConfigPath(appName), yamlStr);
};

export const removeTraefikConfig = async (
	appName: string,
	serverId?: string | null,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
		const configPath = path.join(
			DYNAMIC_TRAEFIK_PATH,
			`${safeTraefikObjectName(appName)}.yml`,
		);
		if (serverId) {
			await execAsyncRemote(serverId, `rm -f -- ${shellQuote(configPath)}`);
		} else {
			fs.rmSync(configPath, { force: true });
		}
	} catch (error) {
		console.error(`Error removing traefik config for ${appName}:`, error);
		throw error;
	}
};

export const removeTraefikConfigRemote = async (
	appName: string,
	serverId: string,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(
			DYNAMIC_TRAEFIK_PATH,
			`${safeTraefikObjectName(appName)}.yml`,
		);
		await execAsyncRemote(serverId, `rm -f -- ${shellQuote(configPath)}`);
	} catch (error) {
		console.error(
			`Error removing remote traefik config for ${appName}:`,
			error,
		);
		throw error;
	}
};

export const loadOrCreateConfig = (appName: string): FileConfig => {
	const yamlStr = readLocalConfigFile(localDynamicConfigPath(appName));
	if (yamlStr !== null) {
		const parsedConfig = (parse(yamlStr) as FileConfig) || {
			http: { routers: {}, services: {} },
		};
		return parsedConfig;
	}
	return { http: { routers: {}, services: {} } };
};

export const loadOrCreateConfigRemote = async (
	serverId: string,
	appName: string,
) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths(true);
	const fileConfig: FileConfig = { http: { routers: {}, services: {} } };
	const configPath = path.join(
		DYNAMIC_TRAEFIK_PATH,
		`${safeTraefikObjectName(appName)}.yml`,
	);
	const { stdout } = await execAsyncRemote(
		serverId,
		remoteConfigReadCommand(configPath, DYNAMIC_TRAEFIK_PATH),
	);
	if (stdout === REMOTE_CONFIG_MISSING_MARKER) return fileConfig;

	const parsedConfig = (parse(stdout) as FileConfig) || {
		http: { routers: {}, services: {} },
	};
	return parsedConfig;
};

export const readConfig = (appName: string) => {
	return readLocalConfigFile(localDynamicConfigPath(appName));
};

export const readRemoteConfig = async (serverId: string, appName: string) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths(true);
	const configPath = path.join(
		DYNAMIC_TRAEFIK_PATH,
		`${safeTraefikObjectName(appName)}.yml`,
	);
	const { stdout } = await execAsyncRemote(
		serverId,
		remoteConfigReadCommand(configPath, DYNAMIC_TRAEFIK_PATH),
	);
	if (stdout === REMOTE_CONFIG_MISSING_MARKER) return null;
	return stdout;
};

export const readMonitoringConfig = async (readAll = false) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, "access.log");
	if (fs.existsSync(configPath)) {
		if (!readAll) {
			// Read first 500 lines using streams
			let content = "";
			let validCount = 0;

			const fileStream = createReadStream(configPath, { encoding: "utf8" });
			const readline = createInterface({
				input: fileStream,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			for await (const line of readline) {
				try {
					const trimmed = line.trim();
					if (
						trimmed !== "" &&
						trimmed.startsWith("{") &&
						trimmed.endsWith("}")
					) {
						const log = JSON.parse(trimmed);
						// Exclude Nearzero service app and Dashboard requests
						if (log.ServiceName !== "nearzero-service-app@file") {
							content += `${line}\n`;
							validCount++;
							if (validCount >= 500) {
								break;
							}
						}
					}
				} catch {
					// Ignore invalid JSON
				}
			}
			return content;
		}
		return fs.readFileSync(configPath, "utf8");
	}
	return null;
};

export const readConfigInPath = async (pathFile: string, serverId?: string) => {
	const { basePath, candidatePath } = resolveTraefikConfigPath(
		pathFile,
		Boolean(serverId),
	);

	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`set -eu
target=$(readlink -f -- ${shellQuote(candidatePath)})
case "$target" in
	${shellQuote(`${basePath}/`)}*.yml|${shellQuote(`${basePath}/`)}*.yaml) ;;
	*) echo 'Traefik config path escapes the managed directory' >&2; exit 65 ;;
esac
cat -- "$target"`,
		);
		if (!stdout) return null;
		return stdout;
	}
	if (fs.existsSync(candidatePath)) {
		const candidateStat = fs.lstatSync(candidatePath);
		if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
			throw new Error("Traefik config must be a regular file");
		}
		const realPath = fs.realpathSync(candidatePath);
		if (!isPathInside(fs.realpathSync(basePath), realPath)) {
			throw new Error("Traefik config path escapes the managed directory");
		}
		const yamlStr = fs.readFileSync(realPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeConfig = (appName: string, traefikConfig: string) => {
	try {
		writeLocalConfigAtomic(localDynamicConfigPath(appName), traefikConfig);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
		throw e;
	}
};

export const writeConfigRemote = async (
	serverId: string,
	appName: string,
	traefikConfig: string,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(
			DYNAMIC_TRAEFIK_PATH,
			`${safeTraefikObjectName(appName)}.yml`,
		);
		const encoded = encodeBase64(traefikConfig);
		await execAsyncRemote(
			serverId,
			`set -eu
mkdir -p -- ${shellQuote(DYNAMIC_TRAEFIK_PATH)}
parent=$(readlink -f -- ${shellQuote(DYNAMIC_TRAEFIK_PATH)})
if [ "$parent" != ${shellQuote(DYNAMIC_TRAEFIK_PATH)} ] || [ -L ${shellQuote(DYNAMIC_TRAEFIK_PATH)} ]; then
	echo 'Traefik config directory cannot be a symbolic link' >&2
	exit 65
fi
tmp=$(mktemp ${shellQuote(`${DYNAMIC_TRAEFIK_PATH}/.nearzero-config.XXXXXX`)})
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
printf '%s' ${shellQuote(encoded)} | base64 -d > "$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" ${shellQuote(configPath)}
tmp=
trap - EXIT HUP INT TERM`,
		);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
		throw e;
	}
};

export const writeTraefikConfigInPath = async (
	pathFile: string,
	traefikConfig: string,
	serverId?: string,
) => {
	try {
		const { basePath, candidatePath } = resolveTraefikConfigPath(
			pathFile,
			Boolean(serverId),
		);
		const dirPath = path.dirname(candidatePath);
		const fileName = path.basename(candidatePath);
		if (serverId) {
			const encoded = encodeBase64(traefikConfig);
			await execAsyncRemote(
				serverId,
				`set -eu
parent=$(readlink -f -- ${shellQuote(dirPath)})
case "$parent" in
	${shellQuote(basePath)}|${shellQuote(`${basePath}/`)}*) ;;
	*) echo 'Traefik config path escapes the managed directory' >&2; exit 65 ;;
esac
tmp=$(mktemp "$parent/.nearzero-config.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
printf '%s' ${shellQuote(encoded)} | base64 -d > "$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" "$parent"/${shellQuote(fileName)}
tmp=
trap - EXIT HUP INT TERM`,
			);
		} else {
			const realBase = fs.realpathSync(basePath);
			const realParent = fs.realpathSync(dirPath);
			if (!isPathInside(realBase, realParent)) {
				throw new Error("Traefik config path escapes the managed directory");
			}
			writeLocalConfigAtomic(path.join(realParent, fileName), traefikConfig);
		}
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
		throw e;
	}
};

export const writeTraefikConfig = (
	traefikConfig: FileConfig,
	appName: string,
) => {
	try {
		const yamlStr = stringify(traefikConfig);
		writeLocalConfigAtomic(localDynamicConfigPath(appName), yamlStr);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
		throw e;
	}
};

export const writeTraefikConfigRemote = async (
	traefikConfig: FileConfig,
	appName: string,
	serverId: string,
) => {
	try {
		const yamlStr = stringify(traefikConfig);
		await writeConfigRemote(serverId, appName, yamlStr);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
		throw e;
	}
};

export const createServiceConfig = (
	appName: string,
	domain: Domain,
): {
	loadBalancer: HttpLoadBalancerService;
} => ({
	loadBalancer: {
		servers: [{ url: `http://${appName}:${domain.port || 80}` }],
		passHostHeader: true,
	},
});
