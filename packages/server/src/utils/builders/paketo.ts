import { quote } from "shell-quote";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";
import { getBuildRuntimePreamble, resolveImmutableBuilderImage } from "./utils";

export const getPaketoCommand = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const { appName, cleanCache } = application;
	const buildAppDirectory = getBuildAppDirectory(application, buildServerId);
	const builderImage = resolveImmutableBuilderImage(
		"NEARZERO_PAKETO_BUILDER_IMAGE",
		"paketobuildpacks/builder-jammy-full",
	);

	return `${getBuildRuntimePreamble()}
echo "Starting Paketo build..." ;
nz_load_runtime_environment
NZ_PACK_ARGS=(
	build ${quote([appName])}
	--path ${quote([buildAppDirectory])}
	--builder ${quote([builderImage])}
)
${cleanCache ? "NZ_PACK_ARGS+=(--clear-cache)" : ""}
if [ -s "$NZ_BUILD_ENV_KEYS_FILE" ]; then
	# Do not reuse a prior cache for a build that receives protected values.
	${cleanCache ? "" : "NZ_PACK_ARGS+=(--clear-cache)"}
	NZ_PACK_ARGS+=(--env-file "$NZ_BUILD_ENV_KEYS_FILE")
fi
pack "\${NZ_PACK_ARGS[@]}" || {
	echo "❌ Paketo build failed" ;
	exit 1;
}
echo "✅ Paketo build completed." ;
`;
};
