import { dirname, join } from "node:path";
import { paths } from "@nearzero/server/constants";
import { loginOrganizationRegistries } from "@nearzero/server/services/registry";
import type { InferResultType } from "@nearzero/server/types/with";
import type { PreparedShellCommand } from "@nearzero/server/utils/process/execAsync";
import boxen from "boxen";
import { quote } from "shell-quote";
import { writeDomainsToCompose } from "../docker/domain";
import {
	dockerComposeEnvPrefix,
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
} from "../docker/utils";

export type ComposeNested = InferResultType<
	"compose",
	{ environment: { with: { project: true } }; mounts: true; domains: true }
>;

export const getBuildComposeCommand = async (
	compose: ComposeNested,
): Promise<PreparedShellCommand> => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { sourceType, appName, mounts, composeType, domains } = compose;

	await loginOrganizationRegistries(
		compose.environment.project.organizationId,
		compose.serverId,
	);

	const command = createCommand(compose);
	const environmentMaterial = getCreateEnvFileCommand(compose);
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	const composeExecutionCommand =
		compose.composeType === "stack"
			? getStackComposeExecutionCommand(command, getComposeEnvFilePath(compose))
			: `${dockerComposeEnvPrefix} docker ${command}`;

	const newCompose = await writeDomainsToCompose(compose, domains);
	const logContent = `
App Name: ${appName}
Build Compose 🐳
Detected: ${mounts.length} mounts 📂
Command: docker ${command}
Source Type: docker ${sourceType} ✅
Compose Type: ${composeType} ✅`;

	const logBox = boxen(logContent, {
		padding: {
			left: 1,
			right: 1,
			bottom: 1,
		},
		width: 80,
		borderStyle: "double",
	});

	const bashCommand = `
	set -e
	{
		echo "${logBox}";

		${newCompose}

		${environmentMaterial.command}

		cd "${projectPath}";

		${compose.isolatedDeployment ? `docker network inspect ${compose.appName} >/dev/null 2>&1 || docker network create ${compose.composeType === "stack" ? "--driver overlay" : ""} --attachable ${compose.appName}` : ""}
		${composeExecutionCommand} 2>&1 || { echo "Error: ❌ Docker command failed"; exit 1; }
		commit_compose_env
		${compose.isolatedDeployment ? `traefik_container=$(docker ps --filter "name=nearzero-traefik" -q | head -n 1); [ -n "$traefik_container" ] || { echo "Error: ❌ Traefik container not found"; exit 1; }; docker network inspect ${compose.appName} --format '{{json .Containers}}' | grep -Fq "$traefik_container" || docker network connect ${compose.appName} "$traefik_container"` : ""}

		echo "Docker Compose Deployed: ✅";
	} || {
		echo "Error: ❌ Script execution failed";
		exit 1
	}
	`;

	return { command: bashCommand, input: environmentMaterial.input };
};

const sanitizeCommand = (command: string) => {
	const sanitizedCommand = command.trim();

	const parts = sanitizedCommand.split(/\s+/);

	const restCommand = parts.map((arg) => arg.replace(/^"(.*)"$/, "$1"));

	return restCommand.join(" ");
};

export const createCommand = (compose: ComposeNested) => {
	const { composeType, appName, sourceType } = compose;
	const envFileArg = quote([getComposeEnvFilePath(compose)]);
	if (compose.command) {
		const command = sanitizeCommand(compose.command);
		return composeType === "docker-compose" && /^compose(?:\s|$)/.test(command)
			? command.replace(/^compose(?=\s|$)/, `compose --env-file ${envFileArg}`)
			: command;
	}

	const path =
		sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	let command = "";

	if (composeType === "docker-compose") {
		command = `compose --env-file ${envFileArg} -p ${quote([
			appName,
		])} -f ${quote([path])} up -d --build --remove-orphans`;
	} else if (composeType === "stack") {
		command = `stack deploy -c ${quote([path])} ${quote([
			appName,
		])} --prune --with-registry-auth`;
	}

	return command;
};

export const getComposeEnvFilePath = (
	compose: Pick<ComposeNested, "appName" | "serverId">,
) => {
	const { COMPOSE_ENV_PATH } = paths(!!compose.serverId);
	return join(COMPOSE_ENV_PATH, `${compose.appName}.env`);
};

export const getLegacyComposeEnvFilePath = (
	compose: Pick<
		ComposeNested,
		"appName" | "composePath" | "serverId" | "sourceType"
	>,
) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const relativeComposePath =
		compose.sourceType === "raw"
			? "docker-compose.yml"
			: compose.composePath || "docker-compose.yml";
	return join(
		dirname(join(COMPOSE_PATH, compose.appName, "code", relativeComposePath)),
		".env",
	);
};

const serializeComposeEnvironmentValue = (value: string) => {
	if (value.includes("\0")) {
		throw new Error("Compose environment values cannot contain null bytes");
	}
	// Compose treats single-quoted env-file values literally: `$` is not
	// interpolated and multiline values remain multiline. Only an embedded
	// apostrophe needs the Compose-supported backslash escape.
	return `'${value.replaceAll("'", "\\'")}'`;
};

export const COMPOSE_STACK_ENV_MARKER = "# nearzero-stack-env-v1:";

export const composeStackEnvironmentLoaderSource = [
	'const envFile = process.env.NEARZERO_COMPOSE_ENV_FILE || "";',
	"const envText = await Bun.file(envFile).text();",
	`const marker = envText.match(/^${COMPOSE_STACK_ENV_MARKER.replaceAll("/", "\\/")}([A-Za-z0-9+/=]+)$/m);`,
	'if (!marker?.[1]) throw new Error("Stack environment snapshot requires a redeploy");',
	'const decoded = JSON.parse(Buffer.from(marker[1], "base64").toString("utf8"));',
	'if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Stack environment snapshot is invalid");',
	"const stackEnvironment = Object.assign(Object.create(null), process.env);",
	"for (const [key, value] of Object.entries(decoded)) {",
	'  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") throw new Error("Stack environment snapshot is invalid");',
	"  stackEnvironment[key] = value;",
	"}",
].join("\n");

export const getComposeEnvironmentFileContent = (compose: ComposeNested) => {
	const { env, appName } = compose;
	let envContent = `APP_NAME=${appName}\n`;
	envContent += `COMPOSE_PROJECT_NAME=${appName}\n`;
	envContent += env || "";
	if (!envContent.includes("DOCKER_CONFIG")) {
		envContent += "\nDOCKER_CONFIG=/root/.docker";
	}

	if (compose.randomize) {
		envContent += `\nCOMPOSE_PREFIX=${compose.suffix}`;
	}

	const entries = prepareEnvironmentVariables(
		envContent,
		compose.environment.project.env,
		compose.environment.env,
	).map((pair): [string, string] => {
		const [key, value] = parseEnvironmentKeyValuePair(pair);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error("Compose environment contains an invalid variable name");
		}
		return [key, value];
	});
	const stackEnvironment = Object.fromEntries(entries);
	const encodedStackEnvironment = Buffer.from(
		JSON.stringify(stackEnvironment),
		"utf8",
	).toString("base64");
	return [
		`${COMPOSE_STACK_ENV_MARKER}${encodedStackEnvironment}`,
		...entries.map(
			([key, value]) => `${key}=${serializeComposeEnvironmentValue(value)}`,
		),
	].join("\n");
};

export const getCreateEnvFileCommand = (
	compose: ComposeNested,
): PreparedShellCommand => {
	const { COMPOSE_ENV_PATH, COMPOSE_PATH } = paths(!!compose.serverId);
	const { appName } = compose;

	const envFilePath = getComposeEnvFilePath(compose);
	const legacyEnvFilePath = getLegacyComposeEnvFilePath(compose);
	const projectPath = join(COMPOSE_PATH, appName, "code");
	const envFileContent = getComposeEnvironmentFileContent(compose);

	const projectPathArg = quote([projectPath]);
	const legacyEnvDirectoryArg = quote([dirname(legacyEnvFilePath)]);
	const legacyEnvFilePathArg = quote([legacyEnvFilePath]);
	const envDirectoryArg = quote([COMPOSE_ENV_PATH]);
	const envFilePathArg = quote([envFilePath]);
	const tempPatternArg = quote([
		join(COMPOSE_ENV_PATH, ".nearzero-env.XXXXXX"),
	]);
	return {
		command: `
	project_root=${projectPathArg}
	app_name=${quote([appName])}
	legacy_env_directory=${legacyEnvDirectoryArg}
	legacy_env_file=${legacyEnvFilePathArg}
	env_directory=${envDirectoryArg}
	env_file=${envFilePathArg}
	if [ ! -d "$project_root" ] || [ -L "$project_root" ] || [ ! -d "$legacy_env_directory" ] || [ -L "$legacy_env_directory" ]; then
		echo "Compose project environment location is missing or unsafe" >&2
		exit 66
	fi
	real_project_root=$(readlink -f -- "$project_root")
	real_legacy_env_directory=$(readlink -f -- "$legacy_env_directory")
	case "$real_legacy_env_directory" in
		"$real_project_root") legacy_env_relative='.env' ;;
		"$real_project_root"/*) legacy_env_relative="\${real_legacy_env_directory#"$real_project_root"/}/.env" ;;
		*) echo "Legacy Compose environment location escapes its managed project" >&2; exit 66 ;;
	esac
	legacy_env_tracked=false
	if git -C "$real_project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 && git -C "$real_project_root" ls-files --error-unmatch -- "$legacy_env_relative" >/dev/null 2>&1; then
		legacy_env_tracked=true
	fi
	legacy_env_managed=false
	if [ -f "$legacy_env_file" ] && [ ! -L "$legacy_env_file" ] && grep -Fqx -- "APP_NAME=$app_name" "$legacy_env_file" && grep -Fqx -- "COMPOSE_PROJECT_NAME=$app_name" "$legacy_env_file"; then
		legacy_env_managed=true
	fi
	legacy_env_preserved=false
	if [ "$legacy_env_tracked" = true ] || { [ -f "$legacy_env_file" ] && [ "$legacy_env_managed" != true ]; }; then
		legacy_env_preserved=true
	fi
	umask 077
	if [ -L "$env_directory" ]; then
		echo "Nearzero Compose secret storage cannot be a symbolic link" >&2
		exit 66
	fi
	install -d -m 0700 "$env_directory"
	chmod 700 "$env_directory"
	if [ -L "$env_file" ] || [ -d "$env_file" ]; then
		echo "Nearzero Compose environment file is unsafe" >&2
		exit 66
	fi
	nearzero_env_candidate=''
	nearzero_env_backup=''
	nearzero_env_had_original=false
	nearzero_env_promoted=false
	nearzero_legacy_backup=''
	nearzero_legacy_kind='none'
	nearzero_legacy_link_target=''
	nearzero_legacy_replaced=false
	nearzero_env_pending=true
	rollback_compose_env() {
		[ "$nearzero_env_pending" = true ] || return 0
		if [ "$nearzero_env_promoted" = true ]; then
			if [ "$nearzero_env_had_original" = true ] && [ -n "$nearzero_env_backup" ] && [ -f "$nearzero_env_backup" ]; then
				mv -f -- "$nearzero_env_backup" "$env_file"
				nearzero_env_backup=''
			else
				rm -f -- "$env_file"
			fi
		fi
		if [ "$nearzero_legacy_replaced" = true ]; then
			rm -f -- "$legacy_env_file"
			case "$nearzero_legacy_kind" in
				file)
					mv -f -- "$nearzero_legacy_backup" "$legacy_env_file"
					nearzero_legacy_backup=''
					;;
				link) ln -s -- "$nearzero_legacy_link_target" "$legacy_env_file" ;;
			esac
		fi
		[ -z "$nearzero_env_candidate" ] || rm -f -- "$nearzero_env_candidate"
		[ -z "$nearzero_env_backup" ] || rm -f -- "$nearzero_env_backup"
		[ -z "$nearzero_legacy_backup" ] || rm -f -- "$nearzero_legacy_backup"
		nearzero_env_pending=false
	}
	commit_compose_env() {
		nearzero_env_pending=false
		[ -z "$nearzero_env_backup" ] || rm -f -- "$nearzero_env_backup"
		[ -z "$nearzero_legacy_backup" ] || rm -f -- "$nearzero_legacy_backup"
		nearzero_env_backup=''
		nearzero_legacy_backup=''
		trap - EXIT
	}
	trap rollback_compose_env EXIT
	if [ -f "$env_file" ]; then
		nearzero_env_backup=$(mktemp ${tempPatternArg})
		cp -p -- "$env_file" "$nearzero_env_backup"
		nearzero_env_had_original=true
	fi
	if [ "$legacy_env_preserved" = true ]; then
		nearzero_legacy_kind='preserved'
	elif [ -L "$legacy_env_file" ]; then
		nearzero_legacy_kind='link'
		nearzero_legacy_link_target=$(readlink -- "$legacy_env_file")
	elif [ -f "$legacy_env_file" ]; then
		nearzero_legacy_kind='file'
		nearzero_legacy_backup=$(mktemp ${tempPatternArg})
		cp -p -- "$legacy_env_file" "$nearzero_legacy_backup"
	elif [ -d "$legacy_env_file" ]; then
		echo "Legacy Compose .env path is a directory and cannot be migrated safely" >&2
		exit 66
	fi
	nearzero_env_candidate=$(mktemp ${tempPatternArg})
	cat > "$nearzero_env_candidate"
	chmod 600 "$nearzero_env_candidate"
	mv -f -- "$nearzero_env_candidate" "$env_file"
	nearzero_env_candidate=''
	nearzero_env_promoted=true
	chmod 600 "$env_file"
	if [ "$legacy_env_preserved" != true ]; then
		nearzero_legacy_replaced=true
		rm -f -- "$legacy_env_file"
		ln -s -- "$env_file" "$legacy_env_file"
	fi
		`,
		input: envFileContent,
	};
};

/**
 * Resolves the last successfully deployed Compose environment without reading
 * current database edits. Legacy repository-local env files are migrated to
 * protected storage and replaced with an out-of-context symlink so service
 * `env_file: .env` references continue to work.
 */
export const getEnsureComposeEnvFileCommand = (
	compose: ComposeNested,
): PreparedShellCommand => {
	const { COMPOSE_ENV_PATH, COMPOSE_PATH } = paths(!!compose.serverId);
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	const envFilePath = getComposeEnvFilePath(compose);
	const legacyEnvFilePath = getLegacyComposeEnvFilePath(compose);
	const tempPattern = join(COMPOSE_ENV_PATH, ".nearzero-env.XXXXXX");
	return {
		command: `set -eu
project_root=${quote([projectPath])}
app_name=${quote([compose.appName])}
legacy_env_file=${quote([legacyEnvFilePath])}
env_directory=${quote([COMPOSE_ENV_PATH])}
env_file=${quote([envFilePath])}
if [ ! -d "$project_root" ] || [ -L "$project_root" ]; then
	echo 'Compose project directory is missing or unsafe' >&2
	exit 66
fi
legacy_env_directory=$(dirname -- "$legacy_env_file")
if [ ! -d "$legacy_env_directory" ] || [ -L "$legacy_env_directory" ]; then
	echo 'Legacy Compose environment directory is missing or unsafe' >&2
	exit 66
fi
real_project_root=$(readlink -f -- "$project_root")
real_legacy_env_directory=$(readlink -f -- "$legacy_env_directory")
case "$real_legacy_env_directory" in
	"$real_project_root") legacy_env_relative='.env' ;;
	"$real_project_root"/*) legacy_env_relative="\${real_legacy_env_directory#"$real_project_root"/}/.env" ;;
	*) echo 'Legacy Compose environment escapes its project' >&2; exit 66 ;;
esac
legacy_env_tracked=false
if git -C "$real_project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 && git -C "$real_project_root" ls-files --error-unmatch -- "$legacy_env_relative" >/dev/null 2>&1; then
	legacy_env_tracked=true
fi
legacy_env_managed=false
if [ -f "$legacy_env_file" ] && [ ! -L "$legacy_env_file" ] && grep -Fqx -- "APP_NAME=$app_name" "$legacy_env_file" && grep -Fqx -- "COMPOSE_PROJECT_NAME=$app_name" "$legacy_env_file"; then
	legacy_env_managed=true
fi
legacy_env_preserved=false
if [ "$legacy_env_tracked" = true ] || { [ -f "$legacy_env_file" ] && [ "$legacy_env_managed" != true ]; }; then
	legacy_env_preserved=true
fi
if [ -L "$env_directory" ] || [ -L "$env_file" ] || [ -d "$env_file" ]; then
	echo 'Nearzero Compose environment storage is unsafe' >&2
	exit 66
fi
umask 077
install -d -m 0700 "$env_directory"
chmod 700 "$env_directory"
if [ ! -f "$env_file" ]; then
	if [ -L "$legacy_env_file" ]; then
		echo 'Legacy Compose environment is an unexpected symbolic link; redeploy the service' >&2
		exit 66
	fi
	if [ ! -f "$legacy_env_file" ]; then
		echo 'No successfully deployed Compose environment snapshot exists; redeploy the service' >&2
		exit 66
	fi
	env_candidate=$(mktemp ${quote([tempPattern])})
	trap 'rm -f -- "$env_candidate"' EXIT
	cat -- "$legacy_env_file" > "$env_candidate"
	chmod 600 "$env_candidate"
	mv -f -- "$env_candidate" "$env_file"
	env_candidate=''
	if [ "$legacy_env_preserved" != true ]; then
		rm -f -- "$legacy_env_file"
		ln -s -- "$env_file" "$legacy_env_file"
	fi
	trap - EXIT
fi
chmod 600 "$env_file"
if [ "$legacy_env_preserved" = true ]; then
	exit 0
fi
if [ -d "$legacy_env_file" ] && [ ! -L "$legacy_env_file" ]; then
	echo 'Legacy Compose environment path is a directory' >&2
	exit 66
fi
if [ -L "$legacy_env_file" ]; then
	legacy_env_target=$(readlink -- "$legacy_env_file")
	if [ "$legacy_env_target" = "$env_file" ]; then
		exit 0
	fi
fi
rm -f -- "$legacy_env_file"
ln -s -- "$env_file" "$legacy_env_file"`,
	};
};

export const getStackComposeExecutionCommand = (
	command: string,
	envFilePath: string,
) => {
	const runner = [
		composeStackEnvironmentLoaderSource,
		"const command = process.argv[process.argv.length - 1];",
		"delete stackEnvironment.NEARZERO_COMPOSE_ENV_FILE;",
		'const result = Bun.spawnSync(["/bin/sh", "-c", command], {',
		"  env: stackEnvironment,",
		'  stdin: "inherit",',
		'  stdout: "inherit",',
		'  stderr: "inherit",',
		"});",
		"process.exit(result.exitCode);",
	].join("\n");
	return `${dockerComposeEnvPrefix} NEARZERO_COMPOSE_ENV_FILE=${quote([
		envFilePath,
	])} bun -e ${quote([runner])} ${quote([`docker ${command}`])}`;
};
