import { quote } from "shell-quote";
import { RAILPACK_VERSION } from "../../setup/builder-versions";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";
import {
	getBuildRuntimePreamble,
	PROTECTED_BUILD_CONTEXT_PATHS,
	resolveImmutableBuilderImage,
} from "./utils";

export type RailpackPackageManager = "npm" | "pnpm" | "yarn" | "bun";

const getRailpackArtifactPaths = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const buildAppDirectory = getBuildAppDirectory(application, buildServerId);
	const planPath = `${buildAppDirectory}/railpack-plan.json`;
	return {
		buildAppDirectory,
		planPath,
		infoPath: `${buildAppDirectory}/railpack-info.json`,
		dockerignorePath: `${planPath}.dockerignore`,
		sourceDockerignorePath: `${buildAppDirectory}/.dockerignore`,
	};
};

const railpackContextExceptions = (
	packageManager?: RailpackPackageManager | null,
) => {
	const files = ["package.json", "package.json5", "**/package.json"];
	switch (packageManager) {
		case "bun":
			files.push("bun.lock", "bun.lockb");
			break;
		case "pnpm":
			files.push("pnpm-lock.yaml", "pnpm-workspace.yaml");
			break;
		case "yarn":
			files.push("yarn.lock", ".yarnrc.yml", ".yarnrc.yaml");
			break;
		case "npm":
			files.push("package-lock.json", "npm-shrinkwrap.json");
			break;
		default:
			files.push(
				"bun.lock",
				"bun.lockb",
				"pnpm-lock.yaml",
				"pnpm-workspace.yaml",
				"yarn.lock",
				".yarnrc.yml",
				".yarnrc.yaml",
				"package-lock.json",
				"npm-shrinkwrap.json",
			);
	}
	return files.map((file) => `!${file}`).join("\\n");
};

const getRailpackCommands = (
	application: ApplicationNested,
	buildServerId?: string | null,
	packageManager?: RailpackPackageManager | null,
) => {
	const { appName, cleanCache } = application;
	const {
		buildAppDirectory,
		planPath,
		infoPath,
		dockerignorePath,
		sourceDockerignorePath,
	} = getRailpackArtifactPaths(application, buildServerId);
	const frontendImage = resolveImmutableBuilderImage(
		"NEARZERO_RAILPACK_FRONTEND_IMAGE",
		`ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}`,
	);
	// Environment values are supplied later through protected phase stdin. Only
	// stable, non-sensitive paths and names are allowed in these command strings.
	const prepareArgs = [
		"prepare",
		quote([buildAppDirectory]),
		"--plan-out",
		quote([planPath]),
		"--info-out",
		quote([infoPath]),
	];

	const prepareCommand = `
${getBuildRuntimePreamble()}
NZ_RAILPACK_PREPARE_COMPLETE=0
nz_cleanup_failed_railpack_prepare() {
	if [ "$NZ_RAILPACK_PREPARE_COMPLETE" != "1" ]; then
		rm -f ${quote([planPath])} ${quote([infoPath])} ${quote([dockerignorePath])} 2>/dev/null || true
	fi
}
trap nz_cleanup_failed_railpack_prepare EXIT
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
# Railpack's production frontend expects secret names in the plan, but never
# values. Add names after planning so values do not enter railpack argv or its
# generated JSON. Runtime values remain BuildKit secrets only.
if [ -s "$NZ_BUILD_ENV_KEYS_FILE" ]; then
	NZ_RAILPACK_SECRET_KEYS_JSON="$(jq -Rsc 'split("\n") | map(select(length > 0))' "$NZ_BUILD_ENV_KEYS_FILE")"
	NZ_RAILPACK_PLAN_TMP="$NZ_BUILD_MATERIAL_DIR/railpack-plan.json"
	jq --argjson nearzeroSecrets "$NZ_RAILPACK_SECRET_KEYS_JSON" \
		'.secrets = (((.secrets // []) + $nearzeroSecrets) | unique)' \
		${quote([planPath])} > "$NZ_RAILPACK_PLAN_TMP"
	chmod 600 "$NZ_RAILPACK_PLAN_TMP"
	mv -f "$NZ_RAILPACK_PLAN_TMP" ${quote([planPath])}
fi
for NZ_RAILPACK_ARTIFACT in ${quote([planPath])} ${quote([infoPath])}; do
	while IFS= read -r NZ_BUILD_KEY; do
		[ -n "$NZ_BUILD_KEY" ] || continue
		if ! jq -e --rawfile nearzeroSecret "$NZ_BUILD_ENV_DIR/$NZ_BUILD_KEY" \
			'[recurse | strings | select(($nearzeroSecret | length) > 0 and contains($nearzeroSecret))] | length == 0' \
			"$NZ_RAILPACK_ARTIFACT" >/dev/null; then
			echo "Railpack generated an artifact containing protected build material" >&2
			exit 66
		fi
	done < "$NZ_BUILD_ENV_KEYS_FILE"
done
# A repository .dockerignore is commonly authored for its Dockerfile and may
# exclude the lockfile selected by a managed build. Docker gives a
# <Dockerfile>.dockerignore file precedence, so preserve every user exclusion
# while re-including only the package manifests required by this Railpack plan.
NZ_RAILPACK_PLAN_IGNORE=${quote([dockerignorePath])}
NZ_RAILPACK_SOURCE_IGNORE=${quote([sourceDockerignorePath])}
if [ -f "$NZ_RAILPACK_SOURCE_IGNORE" ]; then
	cp -- "$NZ_RAILPACK_SOURCE_IGNORE" "$NZ_RAILPACK_PLAN_IGNORE"
else
	: > "$NZ_RAILPACK_PLAN_IGNORE"
fi
printf '\\n# Nearzero managed-build context requirements.\\nrailpack-plan.json\\nrailpack-info.json\\nrailpack-plan.json.dockerignore\\n${railpackContextExceptions(packageManager)}\\n' >> "$NZ_RAILPACK_PLAN_IGNORE"
printf '\\n# Nearzero protected-material exclusions.\\n${PROTECTED_BUILD_CONTEXT_PATHS.join("\\n")}\\n' >> "$NZ_RAILPACK_PLAN_IGNORE"
chmod 600 ${quote([planPath])} ${quote([infoPath])} "$NZ_RAILPACK_PLAN_IGNORE"
NZ_RAILPACK_PREPARE_COMPLETE=1
echo "✅ Railpack prepare completed." ;
`;

	const buildCommand = `
${getBuildRuntimePreamble()}
NZ_RAILPACK_PLAN=${quote([planPath])}
NZ_RAILPACK_INFO=${quote([infoPath])}
NZ_RAILPACK_PLAN_IGNORE=${quote([dockerignorePath])}
nz_cleanup_railpack_context() {
	rm -f "$NZ_RAILPACK_PLAN" "$NZ_RAILPACK_INFO" "$NZ_RAILPACK_PLAN_IGNORE" 2>/dev/null || true
}
trap nz_cleanup_railpack_context EXIT
echo "Building with Railpack frontend..." ;
for NZ_RAILPACK_ARTIFACT in ${quote([planPath])} ${quote([infoPath])}; do
	while IFS= read -r NZ_BUILD_KEY; do
		[ -n "$NZ_BUILD_KEY" ] || continue
		if ! jq -e --rawfile nearzeroSecret "$NZ_BUILD_ENV_DIR/$NZ_BUILD_KEY" \
			'[recurse | strings | select(($nearzeroSecret | length) > 0 and contains($nearzeroSecret))] | length == 0' \
			"$NZ_RAILPACK_ARTIFACT" >/dev/null; then
			echo "Railpack artifact failed the protected-material check" >&2
			exit 66
		fi
	done < "$NZ_BUILD_ENV_KEYS_FILE"
done
NZ_RAILPACK_BUILD_ARGS=(
	buildx build
	--build-arg ${quote([`BUILDKIT_SYNTAX=${frontendImage}`])}
	-f ${quote([planPath])}
	--output ${quote([`type=docker,name=${appName}`])}
)
${cleanCache ? "NZ_RAILPACK_BUILD_ARGS+=(--no-cache)" : ""}
if [ -s "$NZ_BUILD_ENV_KEYS_FILE" ]; then
	# Disabling cache prevents outputs derived from a changed secret from being
	# reused without putting a reversible secret hash in build metadata.
	NZ_RAILPACK_BUILD_ARGS+=(--no-cache)
	while IFS= read -r NZ_BUILD_KEY; do
		[ -n "$NZ_BUILD_KEY" ] || continue
		NZ_RAILPACK_BUILD_ARGS+=(--secret "type=file,id=$NZ_BUILD_KEY,src=$NZ_BUILD_ENV_DIR/$NZ_BUILD_KEY")
	done < "$NZ_BUILD_ENV_KEYS_FILE"
fi
NZ_RAILPACK_BUILD_ARGS+=(${quote([buildAppDirectory])})
docker "\${NZ_RAILPACK_BUILD_ARGS[@]}" || {
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
	packageManager?: RailpackPackageManager | null,
) =>
	getRailpackCommands(application, buildServerId, packageManager)
		.prepareCommand;

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

export const getRailpackPackageManagerValidationCommand = (
	application: ApplicationNested,
	buildServerId: string | null | undefined,
	packageManager: RailpackPackageManager,
	requiresNode = false,
) => {
	const { planPath, infoPath, dockerignorePath } = getRailpackArtifactPaths(
		application,
		buildServerId,
	);
	const installPattern: Record<RailpackPackageManager, string> = {
		npm: "(^|[^[:alnum:]_])npm[[:space:]]+(ci|install|i)([^[:alnum:]_]|$)",
		pnpm: "(^|[^[:alnum:]_])pnpm[[:space:]]+(install|i|fetch)([^[:alnum:]_]|$)",
		yarn: "(^|[^[:alnum:]_])yarn[[:space:]]+(install|--immutable)([^[:alnum:]_]|$)",
		bun: "(^|[^[:alnum:]_])bun[[:space:]]+(install|i)([^[:alnum:]_]|$)",
	};

	return `
NZ_RAILPACK_PLAN=${quote([planPath])}
NZ_RAILPACK_INFO=${quote([infoPath])}
NZ_RAILPACK_PLAN_IGNORE=${quote([dockerignorePath])}
nz_cleanup_invalid_railpack_contract() {
	rm -f "$NZ_RAILPACK_PLAN" "$NZ_RAILPACK_INFO" "$NZ_RAILPACK_PLAN_IGNORE" 2>/dev/null || true
}
test -s "$NZ_RAILPACK_PLAN" || {
	echo "Railpack did not produce a readable build plan."
	nz_cleanup_invalid_railpack_contract
	exit 1
}
NZ_RAILPACK_PLAN_STRINGS="$(jq -r '.. | strings' "$NZ_RAILPACK_PLAN" 2>/dev/null || true)"
printf '%s\\n' "$NZ_RAILPACK_PLAN_STRINGS" | tr '\\n' ' ' | grep -Eiq ${quote([
		installPattern[packageManager],
	])} || {
	echo "Railpack plan does not use the package manager resolved by Nearzero (${packageManager})."
	echo "Falling back before compilation so the build contract cannot drift."
	nz_cleanup_invalid_railpack_contract
	exit 1
}
echo "Railpack package-manager contract verified: ${packageManager}."
${
	requiresNode
		? `jq -e '[.. | objects | .packages? // empty | select(type == "object" and has("node"))] | length > 0' "$NZ_RAILPACK_PLAN" >/dev/null 2>&1 || {
	echo "Railpack plan does not include Node.js, but a selected package script invokes node."
	echo "Falling back before compilation so the build toolchain cannot drift."
	nz_cleanup_invalid_railpack_contract
	exit 1
}
echo "Railpack Node.js toolchain contract verified."`
		: ""
}
`;
};
