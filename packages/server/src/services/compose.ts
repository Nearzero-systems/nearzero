import { createHash } from "node:crypto";
import fs from "node:fs";
import path, { join } from "node:path";
import { paths } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import {
	type apiCreateCompose,
	buildAppName,
	cleanAppName,
	compose,
	domains as domainRows,
} from "@nearzero/server/db/schema";
import { loginOrganizationRegistries } from "@nearzero/server/services/registry";
import {
	composeStackEnvironmentLoaderSource,
	getBuildComposeCommand,
	getComposeEnvFilePath,
	getEnsureComposeEnvFileCommand,
	getStackComposeExecutionCommand,
} from "@nearzero/server/utils/builders/compose";
import { randomizeSpecificationFile } from "@nearzero/server/utils/docker/compose";
import {
	cloneCompose,
	getComposePath,
	getComposeProjectPath,
	loadDockerCompose,
	loadDockerComposeRemote,
	reconcileDomainsInComposeSpecification,
} from "@nearzero/server/utils/docker/domain";
import type { ComposeSpecification } from "@nearzero/server/utils/docker/types";
import { dockerComposeEnvPrefix } from "@nearzero/server/utils/docker/utils";
import { sendBuildErrorNotifications } from "@nearzero/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@nearzero/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
	execFileAsync,
	executePreparedShellCommand,
} from "@nearzero/server/utils/process/execAsync";
import { getGitCommitInfo } from "@nearzero/server/utils/providers/git";
import { getCreateComposeFileCommand } from "@nearzero/server/utils/providers/raw";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getConsoleUrl } from "./admin";
import {
	createDeploymentCompose,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import type { Domain } from "./domain";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
			server: true,
			backups: {
				with: {
					destination: true,
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	if (type === "fetch") {
		const prepared = await cloneCompose(compose);
		await executePreparedShellCommand(prepared, compose.serverId);
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

const COMPOSE_ROUTING_LOCK_STALE_SECONDS = 30 * 60;
const COMPOSE_ROUTING_RETRY_LIMIT = 3;

function isPathInside(basePath: string, candidatePath: string) {
	return (
		candidatePath === basePath ||
		candidatePath.startsWith(`${basePath}${path.sep}`)
	);
}

function assertComposeRoutingCommandInput(input: {
	appName: string;
	projectPath: string;
	composePath: string;
	envFilePath: string;
	expectedSha256: string;
}) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(input.appName)) {
		throw new Error("Compose application name is not safe");
	}
	if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
		throw new Error("Compose configuration checksum is invalid");
	}
	const projectPath = path.resolve(input.projectPath);
	const composePath = path.resolve(input.composePath);
	const envFilePath = path.resolve(input.envFilePath);
	if (composePath === projectPath || !isPathInside(projectPath, composePath)) {
		throw new Error("Compose file path escapes its project directory");
	}
	if (isPathInside(projectPath, envFilePath)) {
		throw new Error(
			"Generated Compose environment file must be outside the project directory",
		);
	}
}

export function buildComposeDomainRoutingReconcileCommand(input: {
	appName: string;
	projectPath: string;
	composePath: string;
	envFilePath: string;
	composeType: "docker-compose" | "stack";
	expectedSha256: string;
}) {
	assertComposeRoutingCommandInput(input);
	const appNameArg = quote([input.appName]);
	const projectPathArg = quote([path.resolve(input.projectPath)]);
	const composePathArg = quote([path.resolve(input.composePath)]);
	const envFilePathArg = quote([path.resolve(input.envFilePath)]);
	const expectedSha256Arg = quote([input.expectedSha256]);
	const stackRunnerArg = quote([
		[
			composeStackEnvironmentLoaderSource,
			"const mode = process.env.NEARZERO_STACK_MODE;",
			'const file = process.env.NEARZERO_STACK_FILE || "";',
			'const app = process.env.NEARZERO_STACK_APP || "";',
			'const args = mode === "config"',
			'  ? ["docker", "stack", "config", "-c", file]',
			'  : ["docker", "stack", "deploy", "-c", file, app, "--prune", "--with-registry-auth"];',
			"delete stackEnvironment.NEARZERO_COMPOSE_ENV_FILE;",
			"delete stackEnvironment.NEARZERO_STACK_MODE;",
			"delete stackEnvironment.NEARZERO_STACK_FILE;",
			"delete stackEnvironment.NEARZERO_STACK_APP;",
			'const result = Bun.spawnSync(args, { env: stackEnvironment, stdin: "inherit", stdout: "inherit", stderr: "inherit" });',
			"process.exit(result.exitCode);",
		].join("\n"),
	]);
	const validateCommand =
		input.composeType === "stack"
			? `run_stack config "$1" >/dev/null`
			: `${dockerComposeEnvPrefix} docker compose --env-file "$runtime_env_file" -p ${appNameArg} -f "$1" config --quiet`;
	const applyCommand =
		input.composeType === "stack"
			? `run_stack deploy "$1"`
			: `${dockerComposeEnvPrefix} docker compose --env-file "$runtime_env_file" -p ${appNameArg} -f "$1" up -d --no-build --remove-orphans`;

	return `set -eu
project_root=${projectPathArg}
compose_file=${composePathArg}
runtime_env_file=${envFilePathArg}
expected_hash=${expectedSha256Arg}

if [ ! -d "$project_root" ] || [ -L "$project_root" ]; then
	echo 'Compose project directory is missing or unsafe' >&2
	exit 66
fi
if [ ! -f "$compose_file" ] || [ -L "$compose_file" ]; then
	echo 'Compose configuration is missing or unsafe' >&2
	exit 66
fi
real_root=$(readlink -f -- "$project_root")
real_compose=$(readlink -f -- "$compose_file")
case "$real_compose" in
	"$real_root"/*) ;;
	*) echo 'Compose configuration escapes its managed project directory' >&2; exit 66 ;;
esac
env_directory=$(dirname -- "$runtime_env_file")
if [ -L "$env_directory" ] || [ -L "$runtime_env_file" ] || [ ! -f "$runtime_env_file" ]; then
	echo 'The last successful Compose environment snapshot is missing or unsafe' >&2
	exit 66
fi
chmod 700 "$env_directory"
chmod 600 "$runtime_env_file"
real_env_directory=$(readlink -f -- "$env_directory")
case "$real_env_directory" in
	"$real_root"|"$real_root"/*)
		echo 'Generated Compose environment storage enters the build context' >&2
		exit 66
		;;
esac
runtime_env_file="$real_env_directory/$(basename -- "$runtime_env_file")"
if ! command -v sha256sum >/dev/null 2>&1; then
	echo 'sha256sum is required to reconcile Compose routing safely' >&2
	exit 69
fi

lock_path="$real_root/.nearzero-domain-routing.lock"
owner_path="$lock_path/owner"
lock_token="$$-$(date +%s)"
acquired=false
for attempt in $(seq 1 300); do
	if mkdir -- "$lock_path" 2>/dev/null; then
		acquired=true
		break
	fi
	if [ -d "$lock_path" ]; then
		now=$(date +%s)
		modified=$(stat -c %Y -- "$lock_path" 2>/dev/null || echo "$now")
		if [ $((now - modified)) -gt ${COMPOSE_ROUTING_LOCK_STALE_SECONDS} ]; then
			rm -rf -- "$lock_path"
			continue
		fi
	fi
	sleep 0.2
done
if [ "$acquired" != true ]; then
	echo 'Timed out waiting for the Compose routing lock' >&2
	exit 75
fi
printf '%s' "$lock_token" > "$owner_path"
chmod 700 "$lock_path"
chmod 600 "$owner_path"

candidate=''
backup=''
cleanup() {
	[ -z "$candidate" ] || rm -f -- "$candidate"
	[ -z "$backup" ] || rm -f -- "$backup"
	if [ -f "$owner_path" ] && [ "$(cat -- "$owner_path")" = "$lock_token" ]; then
		rm -rf -- "$lock_path"
	fi
}
trap cleanup EXIT

actual_hash=$(sha256sum -- "$compose_file" | awk '{print $1}')
if [ "$actual_hash" != "$expected_hash" ]; then
	echo 'Compose configuration changed during routing reconciliation' >&2
	exit 75
fi

compose_directory=$(dirname -- "$compose_file")
candidate=$(mktemp "$compose_directory/.nearzero-routing-candidate.XXXXXX")
backup=$(mktemp "$compose_directory/.nearzero-routing-backup.XXXXXX")
cat > "$candidate"
chmod 600 "$candidate"

run_stack() (
	stack_mode=$1
	stack_file=$2
	clean_path=$PATH
	clean_home=$HOME
	clean_docker_config=\${DOCKER_CONFIG:-$HOME/.docker}
	env -i PATH="$clean_path" HOME="$clean_home" DOCKER_CONFIG="$clean_docker_config" NEARZERO_COMPOSE_ENV_FILE="$runtime_env_file" NEARZERO_STACK_MODE="$stack_mode" NEARZERO_STACK_FILE="$stack_file" NEARZERO_STACK_APP=${appNameArg} bun -e ${stackRunnerArg}
)

validate_file() {
	${validateCommand}
}
apply_file() {
	${applyCommand}
}

if ! validate_file "$candidate"; then
	echo 'Candidate Compose routing configuration is invalid' >&2
	exit 65
fi

cp -- "$compose_file" "$backup"
chmod 600 "$backup"
mv -f -- "$candidate" "$compose_file"
candidate=''
chmod 600 "$compose_file"

if apply_file "$compose_file"; then
	rm -f -- "$backup"
	backup=''
	printf '%s\n' 'Compose domain routing reconciled'
	exit 0
else
	apply_status=$?
	mv -f -- "$backup" "$compose_file"
	backup=''
	chmod 600 "$compose_file"
	if apply_file "$compose_file"; then
		echo 'Compose routing update failed; previous configuration was restored and reapplied' >&2
		exit "$apply_status"
	fi
	echo 'Compose routing update and automatic rollback both failed' >&2
	exit 78
fi`;
}

function readLocalComposeFileStrict(projectPath: string, composePath: string) {
	if (!fs.existsSync(projectPath) || !fs.existsSync(composePath)) {
		throw new Error("Deployed Compose configuration was not found");
	}
	if (
		fs.lstatSync(projectPath).isSymbolicLink() ||
		!fs.lstatSync(projectPath).isDirectory() ||
		fs.lstatSync(composePath).isSymbolicLink() ||
		!fs.lstatSync(composePath).isFile()
	) {
		throw new Error("Deployed Compose configuration path is unsafe");
	}
	const realProjectPath = fs.realpathSync(projectPath);
	const realComposePath = fs.realpathSync(composePath);
	if (
		realComposePath === realProjectPath ||
		!isPathInside(realProjectPath, realComposePath)
	) {
		throw new Error("Compose configuration escapes its project directory");
	}
	return fs.readFileSync(realComposePath, "utf8");
}

async function readComposeFileStrict(composeEntity: Compose) {
	const composePath = getComposePath(composeEntity);
	const projectPath = getComposeProjectPath(composeEntity);
	if (!composeEntity.serverId) {
		return readLocalComposeFileStrict(projectPath, composePath);
	}
	const projectPathArg = quote([projectPath]);
	const composePathArg = quote([composePath]);
	const { stdout } = await execAsyncRemote(
		composeEntity.serverId,
		`set -eu
project_root=${projectPathArg}
compose_file=${composePathArg}
if [ ! -d "$project_root" ] || [ -L "$project_root" ] || [ ! -f "$compose_file" ] || [ -L "$compose_file" ]; then
	echo 'Deployed Compose configuration is missing or unsafe' >&2
	exit 66
fi
real_root=$(readlink -f -- "$project_root")
real_compose=$(readlink -f -- "$compose_file")
case "$real_compose" in
	"$real_root"/*) cat -- "$real_compose" ;;
	*) echo 'Compose configuration escapes its managed project directory' >&2; exit 66 ;;
esac`,
	);
	return stdout;
}

function isConcurrentComposeMutation(error: unknown) {
	if (error instanceof ExecError) {
		return (
			error.exitCode === 75 &&
			/Compose configuration changed during routing reconciliation/.test(
				error.stderr ?? "",
			)
		);
	}
	return (
		error instanceof Error &&
		/code 75\b/.test(error.message) &&
		/Compose configuration changed during routing reconciliation/.test(
			error.message,
		)
	);
}

export async function reconcileComposeDomainRoutes(
	composeId: string,
	desiredDomains?: Domain[],
) {
	for (let attempt = 1; attempt <= COMPOSE_ROUTING_RETRY_LIMIT; attempt += 1) {
		const composeEntity = await findComposeById(composeId);
		if (composeEntity.composeStatus === "running") {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Wait for the active Compose deployment to finish before changing domains",
			});
		}
		if (composeEntity.composeStatus === "error") {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Redeploy or stop the failed Compose service before changing domains; its previous runtime state cannot be reconciled safely",
			});
		}
		if (composeEntity.composeStatus !== "done") {
			return { applied: false as const, reason: "not-deployed" as const };
		}

		const original = await readComposeFileStrict(composeEntity);
		let specification: ComposeSpecification;
		try {
			specification = parse(original, {
				maxAliasCount: 10000,
			}) as ComposeSpecification;
		} catch (error) {
			throw new Error("Deployed Compose configuration is not valid YAML", {
				cause: error,
			});
		}
		const reconciled = reconcileDomainsInComposeSpecification(
			composeEntity,
			desiredDomains ?? composeEntity.domains,
			specification,
			{ applyDeploymentTransforms: false },
		);
		const candidate = stringify(reconciled, { lineWidth: 1000 });
		const expectedSha256 = createHash("sha256").update(original).digest("hex");
		const projectPath = getComposeProjectPath(composeEntity);
		const composePath = getComposePath(composeEntity);
		const envFilePath = getComposeEnvFilePath(composeEntity);
		await executePreparedShellCommand(
			getEnsureComposeEnvFileCommand(composeEntity),
			composeEntity.serverId,
		);
		const command = buildComposeDomainRoutingReconcileCommand({
			appName: composeEntity.appName,
			projectPath,
			composePath,
			envFilePath,
			composeType: composeEntity.composeType,
			expectedSha256,
		});
		const payload = candidate;

		await loginOrganizationRegistries(
			composeEntity.environment.project.organizationId,
			composeEntity.serverId,
		);
		try {
			if (composeEntity.serverId) {
				await execAsyncRemote(composeEntity.serverId, command, undefined, {
					input: payload,
				});
			} else {
				await execFileAsync("/bin/sh", ["-c", command], {
					input: payload,
				});
			}
			return { applied: true as const, reason: "applied" as const };
		} catch (error) {
			if (
				attempt < COMPOSE_ROUTING_RETRY_LIMIT &&
				isConcurrentComposeMutation(error)
			) {
				continue;
			}
			throw error;
		}
	}
	throw new Error("Compose routing reconciliation retry limit exceeded");
}

async function withComposeAdvisoryLocks<T>(
	composeIds: Array<string | null | undefined>,
	operation: () => Promise<T>,
) {
	const uniqueIds = [...new Set(composeIds.filter(Boolean) as string[])].sort();
	if (uniqueIds.length === 0) return operation();
	return db.transaction(async (tx) => {
		for (const composeId of uniqueIds) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${`compose-routing:${composeId}`}, 0))`,
			);
		}
		return operation();
	});
}

export function withComposeRoutingMutationLock<T>(
	composeId: string,
	operation: () => Promise<T>,
) {
	return withComposeAdvisoryLocks([composeId], operation);
}

export function withDomainRoutingMutationLock<T>(
	domainId: string,
	targetComposeId: string | null | undefined,
	operation: () => Promise<T>,
) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`domain-routing:${domainId}`}, 0))`,
		);
		const current = await tx.query.domains.findFirst({
			where: eq(domainRows.domainId, domainId),
			columns: { composeId: true },
		});
		const composeIds = [current?.composeId, targetComposeId]
			.filter(Boolean)
			.sort() as string[];
		for (const composeId of new Set(composeIds)) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${`compose-routing:${composeId}`}, 0))`,
			);
		}
		return operation();
	});
}

async function ensureComposeDefaultDomainNonFatal(input: {
	composeId: string;
	serverId?: string | null;
	deferComposeRouteReconciliation?: boolean;
	composeRoutingLockHeld?: boolean;
}) {
	try {
		const { ensureDefaultServiceDomain } = await import(
			"./managed-domain-provision"
		);
		return await ensureDefaultServiceDomain({
			serviceType: "compose",
			serviceId: input.composeId,
			serverId: input.serverId,
			deferComposeRouteReconciliation: input.deferComposeRouteReconciliation,
			composeRoutingLockHeld: input.composeRoutingLockHeld,
		});
	} catch (error) {
		const reason =
			error instanceof Error ? error.message.split("\n")[0] : String(error);
		console.warn(
			`Compose ${input.composeId} deployed without updating its public domain: ${reason}`,
		);
		return null;
	}
}

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	return withComposeRoutingMutationLock(composeId, async () => {
		let compose = await findComposeById(composeId);
		let hasRoutableDomain = compose.domains.length > 0;
		if (!hasRoutableDomain) {
			hasRoutableDomain = Boolean(
				await ensureComposeDefaultDomainNonFatal({
					composeId,
					serverId: compose.serverId,
					deferComposeRouteReconciliation: true,
					composeRoutingLockHeld: true,
				}),
			);
			if (hasRoutableDomain) compose = await findComposeById(composeId);
		}

		const buildLink = `${await getConsoleUrl()}/dashboard/project/${
			compose.environment.projectId
		}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
		const deployment = await createDeploymentCompose({
			composeId: composeId,
			title: titleLog,
			description: descriptionLog,
		});

		try {
			const entity = {
				...compose,
				type: "compose" as const,
			};
			const source = await cloneCompose(compose);
			let commandWithLog = `(${source.command}) >> ${deployment.logPath} 2>&1`;
			await executePreparedShellCommand(
				{ command: commandWithLog, input: source.input },
				compose.serverId,
			);
			let command = "";
			if (compose.sourceType !== "raw") {
				command = "set -e;";
				command += await generateApplyPatchesCommand({
					id: compose.composeId,
					type: "compose",
					serverId: compose.serverId,
				});
				commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
				if (compose.serverId) {
					await execAsyncRemote(compose.serverId, commandWithLog);
				} else {
					await execAsync(commandWithLog);
				}
			}

			const build = await getBuildComposeCommand(entity);
			commandWithLog = `(set -e;${build.command}) >> ${deployment.logPath} 2>&1`;
			await executePreparedShellCommand(
				{ command: commandWithLog, input: build.input },
				compose.serverId,
			);
			await updateDeploymentStatus(deployment.deploymentId, "done");
			await updateCompose(composeId, {
				composeStatus: "done",
			});
			// The source file now exists and the deployment is no longer marked as
			// running, so a first-deploy Compose domain can resolve its service name
			// and be applied live. Always retry: the early best-effort attempt is
			// expected to defer for new Git-backed services.
			await ensureComposeDefaultDomainNonFatal({
				composeId,
				serverId: compose.serverId,
				composeRoutingLockHeld: true,
			});
			compose = await findComposeById(composeId);

			await sendBuildSuccessNotifications({
				projectName: compose.environment.project.name,
				applicationName: compose.name,
				applicationType: "compose",
				buildLink,
				organizationId: compose.environment.project.organizationId,
				domains: compose.domains,
				environmentName: compose.environment.name,
			});
		} catch (error) {
			let command = "";

			// Only log details for non-ExecError errors
			if (!(error instanceof ExecError)) {
				const message = error instanceof Error ? error.message : String(error);
				const encodedMessage = encodeBase64(message);
				command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
			}

			command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
			await updateDeploymentStatus(deployment.deploymentId, "error");
			await updateCompose(composeId, {
				composeStatus: "error",
			});
			await sendBuildErrorNotifications({
				projectName: compose.environment.project.name,
				applicationName: compose.name,
				applicationType: "compose",
				// @ts-ignore
				errorMessage: error?.message || "Error building",
				buildLink,
				organizationId: compose.environment.project.organizationId,
			});
			throw error;
		} finally {
			if (compose.sourceType !== "raw") {
				const commitInfo = await getGitCommitInfo({
					...compose,
					type: "compose",
				});
				if (commitInfo) {
					await updateDeployment(deployment.deploymentId, {
						title: commitInfo.message,
						description: `Commit: ${commitInfo.hash}`,
					});
				}
			}
		}
	});
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	return withComposeRoutingMutationLock(composeId, async () => {
		let compose = await findComposeById(composeId);
		let hasRoutableDomain = compose.domains.length > 0;
		if (!hasRoutableDomain) {
			hasRoutableDomain = Boolean(
				await ensureComposeDefaultDomainNonFatal({
					composeId,
					serverId: compose.serverId,
				}),
			);
			if (hasRoutableDomain) compose = await findComposeById(composeId);
		}

		const deployment = await createDeploymentCompose({
			composeId: composeId,
			title: titleLog,
			description: descriptionLog,
		});

		try {
			let command = "set -e;";
			if (compose.sourceType === "raw") {
				command += getCreateComposeFileCommand(compose);
			}

			let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}

			if (compose.sourceType !== "raw") {
				command = "set -e;";
				command += await generateApplyPatchesCommand({
					id: compose.composeId,
					type: "compose",
					serverId: compose.serverId,
				});
				commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
				if (compose.serverId) {
					await execAsyncRemote(compose.serverId, commandWithLog);
				} else {
					await execAsync(commandWithLog);
				}
			}

			const build = await getBuildComposeCommand(compose);
			commandWithLog = `(set -e;${build.command}) >> ${deployment.logPath} 2>&1`;
			await executePreparedShellCommand(
				{ command: commandWithLog, input: build.input },
				compose.serverId,
			);
			if (hasRoutableDomain) {
				await ensureComposeDefaultDomainNonFatal({
					composeId,
					serverId: compose.serverId,
				});
			}

			await updateDeploymentStatus(deployment.deploymentId, "done");
			await updateCompose(composeId, {
				composeStatus: "done",
			});
		} catch (error) {
			let command = "";

			// Only log details for non-ExecError errors
			if (!(error instanceof ExecError)) {
				const message = error instanceof Error ? error.message : String(error);
				const encodedMessage = encodeBase64(message);
				command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
			}

			command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
			await updateDeploymentStatus(deployment.deploymentId, "error");
			await updateCompose(composeId, {
				composeStatus: "error",
			});
			throw error;
		}

		return true;
	});
};

const removeComposeUnlocked = async (
	compose: Compose,
	deleteVolumes: boolean,
) => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);
		const appNameArg = quote([compose.appName]);
		const projectPathArg = quote([projectPath]);
		const envFilePathArg = quote([getComposeEnvFilePath(compose)]);

		if (compose.composeType === "stack") {
			const command = `
STACK_SERVICES=$(docker service ls --filter label=com.docker.stack.namespace=${appNameArg} --format '{{.Name}}' 2>/dev/null || true)
STACK_IMAGES=""
STACK_VOLUMES=""
if [ "${deleteVolumes ? "1" : "0"}" = "1" ]; then
	for service_name in $STACK_SERVICES; do
		STACK_IMAGES="$STACK_IMAGES
$(docker service inspect "$service_name" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null | sed 's/@sha256:.*//' || true)"
		STACK_VOLUMES="$STACK_VOLUMES
$(docker service inspect "$service_name" --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{if eq .Type "volume"}}{{.Source}}{{"\\n"}}{{end}}{{end}}' 2>/dev/null || true)"
	done
fi

docker network disconnect ${appNameArg} nearzero-traefik >/dev/null 2>&1 || true
docker stack rm ${appNameArg} >/dev/null 2>&1 || true

for attempt in 1 2 3 4 5; do
	if docker service ls --filter label=com.docker.stack.namespace=${appNameArg} --format '{{.Name}}' | grep -q .; then
		sleep 1
	else
		break
	fi
done

if docker service ls --filter label=com.docker.stack.namespace=${appNameArg} --format '{{.Name}}' | grep -q .; then
	printf 'Docker stack %s still has running services after removal timeout\n' ${appNameArg} >&2
	exit 1
fi

if [ "${deleteVolumes ? "1" : "0"}" = "1" ]; then
	printf '%s\n' "$STACK_VOLUMES" | while IFS= read -r volume_name; do
		if [ -n "$volume_name" ]; then
			docker volume rm -f "$volume_name" >/dev/null 2>&1 || true
		fi
	done
	printf '%s\n' "$STACK_IMAGES" | while IFS= read -r image_name; do
		if [ -n "$image_name" ]; then
			docker image rm -f "$image_name" >/dev/null 2>&1 || true
		fi
	done
fi

rm -rf ${projectPathArg}
rm -f -- ${envFilePathArg}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		} else {
			const command = `
set -eu

PROJECT_CONTAINERS=$(docker ps -aq --filter label=com.docker.compose.project=${appNameArg})
if [ -n "$PROJECT_CONTAINERS" ]; then
	docker rm -f $PROJECT_CONTAINERS >/dev/null
fi

for attempt in 1 2 3 4 5; do
	if docker ps -aq --filter label=com.docker.compose.project=${appNameArg} | grep -q .; then
		sleep 1
	else
		break
	fi
done

if docker ps -aq --filter label=com.docker.compose.project=${appNameArg} | grep -q .; then
	printf 'Docker Compose project %s still has containers after removal timeout\n' ${appNameArg} >&2
	exit 1
fi

PROJECT_NETWORKS=$(docker network ls -q --filter label=com.docker.compose.project=${appNameArg})
if [ -n "$PROJECT_NETWORKS" ]; then
	for network_id in $PROJECT_NETWORKS; do
		docker network rm "$network_id" >/dev/null
	done
fi

if docker network ls -q --filter label=com.docker.compose.project=${appNameArg} | grep -q .; then
	printf 'Docker Compose project %s still has managed networks after removal\n' ${appNameArg} >&2
	exit 1
fi

if [ "${deleteVolumes ? "1" : "0"}" = "1" ]; then
	PROJECT_VOLUMES=$(docker volume ls -q --filter label=com.docker.compose.project=${appNameArg})
	if [ -n "$PROJECT_VOLUMES" ]; then
		for volume_name in $PROJECT_VOLUMES; do
			docker volume rm "$volume_name" >/dev/null
		done
	fi
	if docker volume ls -q --filter label=com.docker.compose.project=${appNameArg} | grep -q .; then
		printf 'Docker Compose project %s still has managed volumes after removal\n' ${appNameArg} >&2
		exit 1
	fi
fi

rm -rf ${projectPathArg}
rm -f -- ${envFilePathArg}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		throw error;
	}

	return true;
};

export const removeCompose = (compose: Compose, deleteVolumes: boolean) =>
	withComposeRoutingMutationLock(compose.composeId, () =>
		removeComposeUnlocked(compose, deleteVolumes),
	);

const startComposeUnlocked = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		await loginOrganizationRegistries(
			compose.environment.project.organizationId,
			compose.serverId,
		);
		await executePreparedShellCommand(
			getEnsureComposeEnvFileCommand(compose),
			compose.serverId,
		);
		const projectPath = getComposeProjectPath(compose);
		const composePath = getComposePath(compose);
		const envFilePath = getComposeEnvFilePath(compose);

		if (compose.composeType === "docker-compose") {
			const baseCommand = `${dockerComposeEnvPrefix} docker compose --env-file ${quote(
				[envFilePath],
			)} -p ${quote([compose.appName])} -f ${quote([composePath])} start`;
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd -- ${quote([projectPath])} && ${baseCommand}`,
				);
			} else {
				await execAsync(baseCommand, {
					cwd: projectPath,
				});
			}
		} else if (compose.composeType === "stack") {
			const stackCommand = getStackComposeExecutionCommand(
				`stack deploy -c ${quote([composePath])} ${quote([
					compose.appName,
				])} --prune --with-registry-auth`,
				envFilePath,
			);
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd -- ${quote([projectPath])} && ${stackCommand}`,
				);
			} else {
				await execAsync(stackCommand, { cwd: projectPath });
			}
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const startCompose = (composeId: string) =>
	withComposeRoutingMutationLock(composeId, () =>
		startComposeUnlocked(composeId),
	);

const stopComposeUnlocked = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		if (compose.composeType === "docker-compose") {
			const appNameArg = quote([compose.appName]);
			const baseCommand = `set -eu
compose_containers=$(docker ps -q --filter label=com.docker.compose.project=${appNameArg})
if [ -n "$compose_containers" ]; then
	docker stop $compose_containers >/dev/null
fi`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, baseCommand);
			} else {
				await execAsync(baseCommand);
			}
		}

		if (compose.composeType === "stack") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`docker stack rm ${compose.appName}`,
				);
			} else {
				await execAsync(`docker stack rm ${compose.appName}`);
			}
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const stopCompose = (composeId: string) =>
	withComposeRoutingMutationLock(composeId, () =>
		stopComposeUnlocked(composeId),
	);
