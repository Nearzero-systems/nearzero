import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import { RAILPACK_VERSION } from "../../setup/builder-versions";
import {
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
	prepareEnvironmentVariablesForShell,
} from "../docker/utils";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";

const calculateSecretsHash = (envVariables: string[]): string => {
	const hash = createHash("sha256");
	for (const env of envVariables.sort()) {
		hash.update(env);
	}
	return hash.digest("hex");
};

const getRailpackCommands = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const { env, appName, cleanCache } = application;
	const buildAppDirectory = getBuildAppDirectory(application, buildServerId);
	const envVariables = prepareEnvironmentVariablesForShell(
		env,
		application.environment.project.env,
		application.environment.env,
	);

	// Prepare command
	const prepareArgs = [
		"prepare",
		buildAppDirectory,
		"--plan-out",
		`${buildAppDirectory}/railpack-plan.json`,
		"--info-out",
		`${buildAppDirectory}/railpack-info.json`,
	];

	for (const env of envVariables) {
		prepareArgs.push("--env", env);
	}

	// Calculate secrets hash for layer invalidation
	const secretsHash = calculateSecretsHash(envVariables);

	const cacheKey = cleanCache ? nanoid(10) : undefined;
	// Build command
	const buildArgs = [
		"buildx",
		"build",
		...(cacheKey
			? [
					"--build-arg",
					`secrets-hash=${secretsHash}`,
					"--build-arg",
					`cache-key=${cacheKey}`,
				]
			: []),
		"--build-arg",
		`BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}`,
		"-f",
		`${buildAppDirectory}/railpack-plan.json`,
		"--output",
		`type=docker,name=${appName}`,
	];

	// Add secrets properly formatted
	// Use prepareEnvironmentVariables (without ForShell) to get raw values for parsing
	const rawEnvVariables = prepareEnvironmentVariables(
		env,
		application.environment.project.env,
		application.environment.env,
	);
	const exportEnvs = [];
	for (const pair of rawEnvVariables) {
		const [key, value] = parseEnvironmentKeyValuePair(pair);
		if (key && value) {
			buildArgs.push("--secret", `id=${key},env=${key}`);
			exportEnvs.push(`export ${key}=${quote([value])}`);
		}
	}

	buildArgs.push(buildAppDirectory);

	const prepareCommand = `
# Railpack is installed and pinned by Nearzero server setup. Builds never
# download executable tooling at runtime.
command -v railpack >/dev/null 2>&1 || {
	echo "Railpack is not installed on the build server."
	echo "Code: builder_missing"
	exit 1
}
docker buildx inspect nearzero-builder >/dev/null 2>&1 ||
	docker buildx create --name nearzero-builder --driver docker-container
docker buildx use nearzero-builder

echo "Preparing Railpack build plan..." ;
railpack ${prepareArgs.join(" ")} || { 
	echo "❌ Railpack prepare failed" ;
	exit 1;
}
echo "✅ Railpack prepare completed." ;
`;

	const buildCommand = `
echo "Building with Railpack frontend..." ;
# Export environment variables for secrets
${exportEnvs.join("\n")}
docker ${buildArgs.join(" ")} || { 
	echo "❌ Railpack build failed" ;
	exit 1;
}
echo "✅ Railpack build completed." ;
`;

	return { prepareCommand, buildCommand };
};

export const getRailpackPrepareCommand = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => getRailpackCommands(application, buildServerId).prepareCommand;

export const getRailpackBuildCommand = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => getRailpackCommands(application, buildServerId).buildCommand;

export const getRailpackCommand = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const commands = getRailpackCommands(application, buildServerId);
	return `${commands.prepareCommand}\n${commands.buildCommand}`;
};
