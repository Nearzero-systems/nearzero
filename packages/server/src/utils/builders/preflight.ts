import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { resolveApplicationBuildExecutionServerId } from "@nearzero/server/services/build-execution";
import { quote } from "shell-quote";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";

export const getBuildPathPreflightCommand = (
	application: ApplicationNested,
	buildServerId = resolveApplicationBuildExecutionServerId(application),
	buildTypeOverride = application.buildType,
) => {
	const sourceDirectory = path.join(
		paths(!!buildServerId).APPLICATIONS_PATH,
		application.appName,
		"code",
	);
	const buildTarget = getBuildAppDirectory(
		application,
		buildServerId,
		buildTypeOverride,
	);
	const isDockerfileBuild = buildTypeOverride === "dockerfile";
	const requestedBuildPath =
		application.sourceType === "github"
			? application.buildPath
			: application.sourceType === "gitlab"
				? application.gitlabBuildPath
				: application.sourceType === "bitbucket"
					? application.bitbucketBuildPath
					: application.sourceType === "gitea"
						? application.giteaBuildPath
						: application.sourceType === "git"
							? application.customGitBuildPath
							: "";

	return `
		NZ_SOURCE_DIR=${quote([sourceDirectory])}
		NZ_BUILD_TARGET=${quote([buildTarget])}
		NZ_REQUESTED_BUILD_PATH=${quote([requestedBuildPath || "/"])}

		echo "Validating source and build path..."
		if [ ! -d "$NZ_SOURCE_DIR" ]; then
			echo "Source directory was not created by the clone phase."
			echo "Code: source_fetch_failed"
			exit 1
		fi

		if ${
			isDockerfileBuild
				? '[ ! -f "$NZ_BUILD_TARGET" ]'
				: '[ ! -d "$NZ_BUILD_TARGET" ]'
		}; then
			echo "Build path not found: $NZ_REQUESTED_BUILD_PATH"
			echo "Code: build_path_missing"
			echo "Detected candidate paths:"
			find "$NZ_SOURCE_DIR" -maxdepth 4 \\
				\\( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/.next/*" -o -path "*/dist/*" -o -path "*/build/*" \\) -prune \\
				-o \\( -name package.json -o -name Dockerfile -o -name nixpacks.toml -o -name railpack.json \\) -type f -print 2>/dev/null \\
				| sed "s#^$NZ_SOURCE_DIR/##" \\
				| sed 's#/[^/]*$##' \\
				| sort -u \\
				| head -n 20
			exit 1
		fi

		echo "Build target ready: $NZ_REQUESTED_BUILD_PATH"
	`;
};
