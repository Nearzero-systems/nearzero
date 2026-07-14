import { quote } from "shell-quote";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";
import { getBuildRuntimePreamble, resolveImmutableBuilderImage } from "./utils";

export const getHerokuCommand = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const { appName, cleanCache } = application;
	const buildAppDirectory = getBuildAppDirectory(application, buildServerId);
	const builderImage = resolveImmutableBuilderImage(
		"NEARZERO_HEROKU_BUILDER_IMAGE",
		`heroku/builder:${application.herokuVersion || "24"}`,
	);

	return `${getBuildRuntimePreamble()}
echo "Starting Heroku build..." ;
nz_load_runtime_environment
NZ_PACK_ARGS=(
	build ${quote([appName])}
	--path ${quote([buildAppDirectory])}
	--builder ${quote([builderImage])}
)
${cleanCache ? "NZ_PACK_ARGS+=(--clear-cache)" : ""}
if [ -s "$NZ_BUILD_ENV_KEYS_FILE" ]; then
	# A key-only env file makes pack read values from the protected process
	# environment without copying those values into argv. Clear any prior build
	# cache before a secret-bearing build so stale secret-derived output is not
	# reused; buildpack code remains inside the trusted build boundary.
	${cleanCache ? "" : "NZ_PACK_ARGS+=(--clear-cache)"}
	NZ_PACK_ARGS+=(--env-file "$NZ_BUILD_ENV_KEYS_FILE")
fi
pack "\${NZ_PACK_ARGS[@]}" || {
	echo "❌ Heroku build failed" ;
	exit 1;
}
echo "✅ Heroku build completed." ;
`;
};
