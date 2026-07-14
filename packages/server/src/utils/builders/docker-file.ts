import { quote } from "shell-quote";
import {
	getBuildAppDirectory,
	getDockerContextPath,
} from "../filesystem/directory";
import type { ApplicationNested } from ".";
import { getBuildRuntimePreamble, NEARZERO_BUILD_ENV_SECRET_ID } from "./utils";

export const getDockerCommand = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const {
		appName,
		publishDirectory,
		dockerBuildStage,
		cleanCache,
		createEnvFile,
	} = application;
	const dockerFilePath = getBuildAppDirectory(application, buildServerId);
	const defaultContextPath =
		dockerFilePath.substring(0, dockerFilePath.lastIndexOf("/") + 1) || ".";
	const dockerContextPath =
		getDockerContextPath(application, buildServerId) || defaultContextPath;

	return `${getBuildRuntimePreamble()}
echo "Building ${appName}" ;
cd ${quote([dockerContextPath])} || {
	echo "❌ The configured Docker build context does not exist" ;
	exit 1;
}

NZ_DOCKER_BUILD_ARGS=(
	buildx build
	--load
	-t ${quote([appName])}
	-f ${quote([dockerFilePath])}
)
${dockerBuildStage ? `NZ_DOCKER_BUILD_ARGS+=(--target ${quote([dockerBuildStage])})` : ""}
${cleanCache ? "NZ_DOCKER_BUILD_ARGS+=(--no-cache)" : ""}
${
	cleanCache
		? ""
		: `if [ -s "$NZ_BUILD_SECRET_KEYS_FILE" ]${!publishDirectory && createEnvFile ? ' || [ -s "$NZ_BUILD_ENV_KEYS_FILE" ]' : ""}; then
	NZ_DOCKER_BUILD_ARGS+=(--no-cache)
fi`
}

# Build args are an explicitly non-secret channel. Values are inherited from
# the protected environment so they do not enter this script or child argv,
# but Docker may retain them in image history/provenance.
nz_load_argument_environment
while IFS= read -r NZ_BUILD_KEY; do
	[ -n "$NZ_BUILD_KEY" ] || continue
	NZ_DOCKER_BUILD_ARGS+=(--build-arg "$NZ_BUILD_KEY")
done < "$NZ_BUILD_ARGUMENT_KEYS_FILE"

# Dockerfile build secrets remain files from end to end. The value is never an
# argv element and BuildKit does not copy the mount into an image layer.
while IFS= read -r NZ_BUILD_KEY; do
	[ -n "$NZ_BUILD_KEY" ] || continue
	NZ_DOCKER_BUILD_ARGS+=(--secret "type=file,id=$NZ_BUILD_KEY,src=$NZ_BUILD_SECRET_DIR/$NZ_BUILD_KEY")
done < "$NZ_BUILD_SECRET_KEYS_FILE"

${
	!publishDirectory && createEnvFile
		? `# Legacy createEnvFile is intentionally implemented as BuildKit secrets.
# Writing .env into the checkout lets COPY instructions bake credentials into
# images. Dockerfiles can instead mount id=${NEARZERO_BUILD_ENV_SECRET_ID}
# (a shell export file), or mount an individual variable name.
if [ -s "$NZ_BUILD_ENV_KEYS_FILE" ]; then
	NZ_DOCKER_BUILD_ARGS+=(--secret "type=file,id=${NEARZERO_BUILD_ENV_SECRET_ID},src=$NZ_BUILD_ENV_EXPORT_FILE")
	while IFS= read -r NZ_BUILD_KEY; do
		[ -n "$NZ_BUILD_KEY" ] || continue
		if ! grep -Fxq "$NZ_BUILD_KEY" "$NZ_BUILD_SECRET_KEYS_FILE"; then
			NZ_DOCKER_BUILD_ARGS+=(--secret "type=file,id=$NZ_BUILD_KEY,src=$NZ_BUILD_ENV_DIR/$NZ_BUILD_KEY")
		fi
	done < "$NZ_BUILD_ENV_KEYS_FILE"
fi`
		: ""
}

NZ_DOCKER_BUILD_ARGS+=(.)
docker "\${NZ_DOCKER_BUILD_ARGS[@]}" || {
	echo "❌ Docker build failed" ;
	exit 1;
}
echo "✅ Docker build completed." ;
`;
};
