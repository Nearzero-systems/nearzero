import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { resolveApplicationBuildExecutionServerId } from "@nearzero/server/services/build-execution";
import { COREPACK_VERSION } from "@nearzero/server/setup/builder-versions";
import { getStaticCommand } from "@nearzero/server/utils/builders/static";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import { prepareEnvironmentVariablesForShell } from "../docker/utils";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";

// Modern nixpkgs archive used only when the Nixpacks default archive cannot
// satisfy the resolved build plan (for example Node 24 or newer Node patches).
// Package-manager attributes are normalized out of the plan separately because
// aliases emitted by Nixpacks are not stable across nixpkgs revisions.
const MODERN_NIXPKGS_ARCHIVE = "331800de5053fcebacf6813adb5db9c9dca22a0c";

export const NIXPACKS_VERSIONED_PACKAGE_MANAGER_NIX_PATTERN =
	"^(npm|yarn|pnpm)([-_].*)?$";

export const NIXPACKS_PLAN_NORMALIZATION_FILTER = `
.providers = []
| .phases = (
	(.phases // {})
	| with_entries(
		.value |= (
			if ((.nixPkgs // null) | type) == "array" then
				.nixPkgs |= map(
					select(
						(
							(tostring | test($packageManagerPattern))
							or ($removeBun and . == "bun")
						)
						| not
					)
				)
			else
				.
			end
		)
	)
)
| if $replaceCorepack then
	.phases |= with_entries(
		.value |= (
			if type == "object" and ((.cmds // null) | type) == "array" then
				.cmds |= map(select(test("corepack") | not))
			else
				.
			end
		)
	)
else
	.
end
| if $bootstrap == "" then
	.
else
	.phases.install = (
		(.phases.install // {"dependsOn": ["setup"]})
		| .cmds = (
			[$bootstrap]
			+ (
				(.cmds // [])
				| if $replaceCorepack then
					map(select(test("corepack") | not))
				else
					.
				end
			)
		)
	)
end
`;

export const getNixpacksCommand = (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const { env, appName, publishDirectory, cleanCache } = application;
	const customInstallCommand = application.customInstallCommand?.trim() || "";
	const customBuildCommand = application.customBuildCommand?.trim() || "";
	const customStartCommand = application.customStartCommand?.trim() || "";

	const serverId =
		buildServerId === undefined
			? resolveApplicationBuildExecutionServerId(application)
			: buildServerId;
	const buildAppDirectory = getBuildAppDirectory(application, serverId);
	const sourceDirectory = path.join(
		paths(!!serverId).APPLICATIONS_PATH,
		appName,
		"code",
	);
	const buildRelativePath = path.relative(
		sourceDirectory,
		buildAppDirectory,
	);
	if (
		path.isAbsolute(buildRelativePath) ||
		buildRelativePath === ".." ||
		buildRelativePath.startsWith(`..${path.sep}`)
	) {
		throw new Error(
			`Nixpacks build path must stay inside the application source directory: ${buildAppDirectory}`,
		);
	}
	const buildContainerId = `${appName}-${nanoid(10)}`;
	const envVariables = prepareEnvironmentVariablesForShell(
		env,
		application.environment.project.env,
		application.environment.env,
	);

	const envArgs = envVariables.map((env) => `--env ${env}`).join(" ");
	const cleanCacheArg = cleanCache ? "--no-cache" : "";
	const staticArg = publishDirectory ? "--no-error-without-start" : "";
	const planCommandParts = [
		"nixpacks",
		"plan",
		'"$NZ_NIXPACKS_BUILD_DIR"',
		"--format json",
		// Provide the C++ runtime that supplies libstdc++.so.6 on the build
		// image's LD_LIBRARY_PATH. Nixpacks installs gcc's lib into the nix store
		// (it is part of the Node closure) but does not put it on LD_LIBRARY_PATH,
		// so prebuilt native binaries such as `sharp` fail to dlopen
		// libstdc++.so.6. `--libs gcc-unwrapped` adds it to LD_LIBRARY_PATH on
		// every archive path. See https://nixpacks.com/docs/guides/configuring-builds.
		"--libs gcc-unwrapped",
		envArgs,
		// Pin the Node.js major version Nixpacks uses. The value is resolved at
		// runtime into $NZ_NODE_VERSION (see below). Nixpacks only reads
		// NIXPACKS_NODE_VERSION when it is passed via --env (an ambient shell
		// export is NOT consumed by Nixpacks' provider planning), so we must
		// forward it explicitly here.
		'--env NIXPACKS_NODE_VERSION="$NZ_NODE_VERSION"',
		// Configure package managers to skip peer dependency validation like
		// Vercel and other platforms do, preventing builds from failing due to
		// mismatched peer deps (e.g., next-auth@4 + next@16).
		"--env NPM_CONFIG_LEGACY_PEER_DEPS=true",
		"--env YARN_IGNORE_ENGINES=true",
		customInstallCommand ? `--install-cmd ${quote([customInstallCommand])}` : "",
		customBuildCommand ? `--build-cmd ${quote([customBuildCommand])}` : "",
		customStartCommand ? `--start-cmd ${quote([customStartCommand])}` : "",
	].filter(Boolean);
	const planCommand = planCommandParts.join(" ");
	const workspacePlanCommand = [
		...planCommandParts,
		customInstallCommand ? "" : '--install-cmd "$NZ_WORKSPACE_INSTALL_CMD"',
		customBuildCommand ? "" : '--build-cmd "$NZ_WORKSPACE_BUILD_CMD"',
		customStartCommand ? "" : '--start-cmd "$NZ_WORKSPACE_START_CMD"',
	].join(" ");
	const command = [
		'cd "$NZ_NIXPACKS_BUILD_DIR"',
		"&&",
		"nixpacks",
		"build",
		".",
		"--name",
		quote([appName]),
		'--config ".nearzero-nixpacks-plan.json"',
		cleanCacheArg,
		staticArg,
	]
		.filter(Boolean)
		.join(" ");
	let bashCommand = `
		NZ_NIXPACKS_ORIGINAL_SOURCE_DIR=${quote([sourceDirectory])}
		NZ_NIXPACKS_RELATIVE_BUILD_PATH=${quote([buildRelativePath || "."])}
		NZ_NIXPACKS_STAGE_PARENT="$(dirname "$NZ_NIXPACKS_ORIGINAL_SOURCE_DIR")"
		NZ_NIXPACKS_SOURCE_DIR="$(mktemp -d "$NZ_NIXPACKS_STAGE_PARENT/.nearzero-nixpacks-stage.XXXXXX")"
		nz_cleanup_nixpacks_stage() {
			rm -rf "$NZ_NIXPACKS_SOURCE_DIR" 2>/dev/null || true
		}
		trap nz_cleanup_nixpacks_stage EXIT
		cp -a "$NZ_NIXPACKS_ORIGINAL_SOURCE_DIR/." "$NZ_NIXPACKS_SOURCE_DIR/"
		if [ "$NZ_NIXPACKS_RELATIVE_BUILD_PATH" = "." ]; then
			NZ_NIXPACKS_REQUESTED_DIR="$NZ_NIXPACKS_SOURCE_DIR"
		else
			NZ_NIXPACKS_REQUESTED_DIR="$NZ_NIXPACKS_SOURCE_DIR/$NZ_NIXPACKS_RELATIVE_BUILD_PATH"
		fi
		NZ_NIXPACKS_BUILD_DIR="$NZ_NIXPACKS_REQUESTED_DIR"
		NZ_WORKSPACE_INSTALL_CMD=""
		NZ_WORKSPACE_BUILD_CMD=""
		NZ_WORKSPACE_START_CMD=""

		if [ "$NZ_NIXPACKS_REQUESTED_DIR" != "$NZ_NIXPACKS_SOURCE_DIR" ] && [ -f "$NZ_NIXPACKS_REQUESTED_DIR/package.json" ] && grep -q '"workspace:' "$NZ_NIXPACKS_REQUESTED_DIR/package.json"; then
			echo "Detected workspace dependencies in selected build path."
			NZ_WORKSPACE_PACKAGE="$(jq -r '.name // empty' "$NZ_NIXPACKS_REQUESTED_DIR/package.json" 2>/dev/null || true)"
			if [ -z "$NZ_WORKSPACE_PACKAGE" ]; then
				echo "❌ Workspace dependencies were found, but package.json has no package name. Set the build path to the repository root or add a package name."
				exit 1
			fi

			# Relative path of the requested package within the repo root, e.g. "apps/web".
			# We build from the repo root (so workspace deps install) but run the
			# package's own scripts via "cd <rel> && <pm> run <script>". This is
			# package-manager-version independent and avoids fragile name-based
			# --filter matching, which can report "No packages matched the filter".
			NZ_WORKSPACE_REL_DIR="\${NZ_NIXPACKS_REQUESTED_DIR#"$NZ_NIXPACKS_SOURCE_DIR"/}"

			if [ -f "$NZ_NIXPACKS_SOURCE_DIR/nixpacks.toml" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/nixpacks.json" ]; then
				NZ_WORKSPACE_PM="custom Nixpacks config"
			else
				NZ_WORKSPACE_PM=""
				if [ -f "$NZ_NIXPACKS_SOURCE_DIR/pnpm-lock.yaml" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/pnpm-workspace.yaml" ]; then
					NZ_WORKSPACE_PM="pnpm"
					NZ_WORKSPACE_INSTALL_CMD="pnpm install --frozen-lockfile"
					NZ_WORKSPACE_BUILD_CMD="cd $NZ_WORKSPACE_REL_DIR && pnpm run build"
					NZ_WORKSPACE_START_CMD="cd $NZ_WORKSPACE_REL_DIR && pnpm run start"
				elif [ -f "$NZ_NIXPACKS_SOURCE_DIR/bun.lockb" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/bun.lock" ]; then
					NZ_WORKSPACE_PM="bun"
					NZ_WORKSPACE_INSTALL_CMD="bun install --frozen-lockfile"
					NZ_WORKSPACE_BUILD_CMD="cd $NZ_WORKSPACE_REL_DIR && bun run build"
					NZ_WORKSPACE_START_CMD="cd $NZ_WORKSPACE_REL_DIR && bun run start"
				elif [ -f "$NZ_NIXPACKS_SOURCE_DIR/yarn.lock" ]; then
					NZ_WORKSPACE_PM="yarn"
					NZ_WORKSPACE_INSTALL_CMD="yarn install --frozen-lockfile"
					NZ_WORKSPACE_BUILD_CMD="cd $NZ_WORKSPACE_REL_DIR && yarn run build"
					NZ_WORKSPACE_START_CMD="cd $NZ_WORKSPACE_REL_DIR && yarn run start"
				elif jq -e '.workspaces' "$NZ_NIXPACKS_SOURCE_DIR/package.json" >/dev/null 2>&1; then
					NZ_WORKSPACE_PM="npm"
					NZ_WORKSPACE_INSTALL_CMD="npm install"
					NZ_WORKSPACE_BUILD_CMD="cd $NZ_WORKSPACE_REL_DIR && npm run build"
					NZ_WORKSPACE_START_CMD="cd $NZ_WORKSPACE_REL_DIR && npm run start"
				fi

				if [ -n "$NZ_WORKSPACE_PM" ] && [ -n "$NZ_WORKSPACE_BUILD_CMD" ] &&
					[ -f "$NZ_NIXPACKS_SOURCE_DIR/package.json" ] &&
					( [ -f "$NZ_NIXPACKS_SOURCE_DIR/turbo.json" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/turbo.jsonc" ] ) &&
					jq -e '((.dependencies // {}) + (.devDependencies // {})) | has("turbo")' "$NZ_NIXPACKS_SOURCE_DIR/package.json" >/dev/null 2>&1; then
					if printf '%s' "$NZ_WORKSPACE_PACKAGE" | grep -Eq '^(@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+$'; then
						case "$NZ_WORKSPACE_PM" in
							bun) NZ_WORKSPACE_BUILD_CMD="bunx turbo run build --filter=$NZ_WORKSPACE_PACKAGE..." ;;
							pnpm) NZ_WORKSPACE_BUILD_CMD="pnpm exec turbo run build --filter=$NZ_WORKSPACE_PACKAGE..." ;;
							yarn) NZ_WORKSPACE_BUILD_CMD="yarn turbo run build --filter=$NZ_WORKSPACE_PACKAGE..." ;;
							npm) NZ_WORKSPACE_BUILD_CMD="npx --no-install turbo run build --filter=$NZ_WORKSPACE_PACKAGE..." ;;
						esac
						echo "Detected Turbo workspace pipeline; building $NZ_WORKSPACE_PACKAGE with dependency graph."
					else
						echo "Workspace package name contains unsupported characters; using package-local build command."
					fi
				fi
			fi

			if [ -z "$NZ_WORKSPACE_PM" ]; then
				echo "❌ Workspace dependencies were found, but no supported workspace lockfile was found at the repository root."
				echo "   Add pnpm-lock.yaml, bun.lock, yarn.lock, or a root package.json workspaces config, or deploy with a Dockerfile."
				exit 1
			fi

			NZ_NIXPACKS_BUILD_DIR="$NZ_NIXPACKS_SOURCE_DIR"
			echo "Building workspace package $NZ_WORKSPACE_PACKAGE ($NZ_WORKSPACE_REL_DIR) from repository root with $NZ_WORKSPACE_PM."
		fi

		# Resolve the Node.js major version Nixpacks should use and expose it as
		# $NZ_NODE_VERSION, which is forwarded to nixpacks via
		# "--env NIXPACKS_NODE_VERSION=...". Nixpacks defaults to Node 18 (now EOL)
		# and only honors NIXPACKS_NODE_VERSION when passed through --env, so an
		# ambient export is not enough. Resolution order (Nixpacks supports majors):
		#   1. An explicit NIXPACKS_NODE_VERSION already in the environment.
		#   2. engines.node in the selected build path's package.json.
		#   3. engines.node in the repository root package.json.
		#   4. .nvmrc / .node-version (selected dir, then repo root).
		#   5. Fallback to the current LTS so EOL Node 18 is never used by default.
		#
		# Note: Nixpacks only controls the MAJOR version; the patch version comes
		# from the selected nixpkgs archive. We start with the default archive for
		# provider compatibility and switch to the modern archive only when the
		# build requires it. Default to Node 22 LTS.
		NZ_DEFAULT_NODE_MAJOR="22"
		NZ_NODE_VERSION="\${NIXPACKS_NODE_VERSION:-}"
		if [ -z "$NZ_NODE_VERSION" ]; then
			NZ_NODE_SPEC=""
			NZ_NODE_SOURCE=""

			# engines.node (selected package, then repo root)
			if [ -f "$NZ_NIXPACKS_REQUESTED_DIR/package.json" ]; then
				NZ_NODE_SPEC="$(jq -r '.engines.node // empty' "$NZ_NIXPACKS_REQUESTED_DIR/package.json" 2>/dev/null || true)"
				[ -n "$NZ_NODE_SPEC" ] && NZ_NODE_SOURCE="package.json engines.node"
			fi
			if [ -z "$NZ_NODE_SPEC" ] && [ -f "$NZ_NIXPACKS_SOURCE_DIR/package.json" ]; then
				NZ_NODE_SPEC="$(jq -r '.engines.node // empty' "$NZ_NIXPACKS_SOURCE_DIR/package.json" 2>/dev/null || true)"
				[ -n "$NZ_NODE_SPEC" ] && NZ_NODE_SOURCE="root package.json engines.node"
			fi

			# .nvmrc / .node-version (selected dir, then repo root)
			if [ -z "$NZ_NODE_SPEC" ]; then
				for NZ_NODE_FILE in \
					"$NZ_NIXPACKS_REQUESTED_DIR/.nvmrc" \
					"$NZ_NIXPACKS_REQUESTED_DIR/.node-version" \
					"$NZ_NIXPACKS_SOURCE_DIR/.nvmrc" \
					"$NZ_NIXPACKS_SOURCE_DIR/.node-version"; do
					if [ -f "$NZ_NODE_FILE" ]; then
						NZ_NODE_SPEC="$(cat "$NZ_NODE_FILE" 2>/dev/null || true)"
						if [ -n "$NZ_NODE_SPEC" ]; then
							NZ_NODE_SOURCE="$(basename "$NZ_NODE_FILE")"
							break
						fi
					fi
				done
			fi

			NZ_NODE_MAJOR="$(printf '%s' "$NZ_NODE_SPEC" | grep -oE '[0-9]+' | sort -rn | head -n 1 || true)"
			if [ -n "$NZ_NODE_MAJOR" ]; then
				# For open-ended lower-bound ranges (">=18", ">20") the highest
				# mentioned major may still be old/EOL while the app is happy on
				# anything newer. In that case prefer the current LTS default so we
				# don't land on an EOL or too-old patch.
				case "$NZ_NODE_SPEC" in
					*">="*|*">"*)
						if [ "$NZ_NODE_MAJOR" -lt "$NZ_DEFAULT_NODE_MAJOR" ]; then
							echo "Node range '$NZ_NODE_SPEC' ($NZ_NODE_SOURCE) allows newer; using current LTS v$NZ_DEFAULT_NODE_MAJOR."
							NZ_NODE_MAJOR="$NZ_DEFAULT_NODE_MAJOR"
						fi
						;;
				esac
				NZ_NODE_VERSION="$NZ_NODE_MAJOR"
				echo "Using Node.js v$NZ_NODE_MAJOR (from $NZ_NODE_SOURCE: $NZ_NODE_SPEC)."
			else
				NZ_NODE_VERSION="$NZ_DEFAULT_NODE_MAJOR"
				echo "No Node.js version declared; defaulting to Node.js v$NZ_DEFAULT_NODE_MAJOR (LTS). Set engines.node or .nvmrc to pin a version."
			fi
		else
			echo "Using Node.js v$NZ_NODE_VERSION (from NIXPACKS_NODE_VERSION)."
		fi

		# Choose the nixpkgs archive together with the resolved toolchain. The
		# modern archive is needed for newer Node packages, while package managers
		# are bootstrapped independently of nixpkgs. We prepare this per-attempt so
		# other undefined Nix package errors can still self-heal.
		NZ_MODERN_NIXPKGS_ARCHIVE="\${NIXPACKS_NIXPKGS_ARCHIVE:-${MODERN_NIXPKGS_ARCHIVE}}"
		NZ_NIXPACKS_TOML="$NZ_NIXPACKS_BUILD_DIR/nixpacks.toml"
		NZ_NIXPACKS_JSON="$NZ_NIXPACKS_BUILD_DIR/nixpacks.json"
		nz_is_nearzero_generated_nixpacks_toml() {
			[ -f "$NZ_NIXPACKS_TOML" ] || return 1
			if grep -q "Generated by Nearzero" "$NZ_NIXPACKS_TOML"; then
				return 0
			fi
			NZ_TOML_CONTENT_LINES="$(grep -vE '^[[:space:]]*(#.*)?$' "$NZ_NIXPACKS_TOML" 2>/dev/null | wc -l | awk '{print $1}')"
			if [ "$NZ_TOML_CONTENT_LINES" -le 2 ] &&
				grep -q '^[[:space:]]*\\[phases.setup\\]' "$NZ_NIXPACKS_TOML" &&
				grep -q '^[[:space:]]*nixpkgsArchive[[:space:]]*=' "$NZ_NIXPACKS_TOML" &&
				grep -q "$NZ_MODERN_NIXPKGS_ARCHIVE" "$NZ_NIXPACKS_TOML"; then
				return 0
			fi
			return 1
		}
		nz_project_has_nixpacks_config() {
			[ -f "$NZ_NIXPACKS_JSON" ] && return 0
			[ -f "$NZ_NIXPACKS_TOML" ] && ! nz_is_nearzero_generated_nixpacks_toml && return 0
			return 1
		}
		nz_remove_generated_nixpacks_toml() {
			if nz_is_nearzero_generated_nixpacks_toml; then
				rm -f "$NZ_NIXPACKS_TOML" 2>/dev/null || true
			fi
		}
		nz_prepare_nixpacks_archive() {
			NZ_ARCHIVE_MODE="$1"
			if nz_project_has_nixpacks_config; then
				echo "Nixpacks archive strategy: project config (leaving nixpacks.toml/json untouched)."
				return 0
			fi

			if [ "$NZ_ARCHIVE_MODE" = "modern" ]; then
				printf '# Generated by Nearzero. Safe to rewrite.\\n[phases.setup]\\nnixpkgsArchive = "%s"\\n' "$NZ_MODERN_NIXPKGS_ARCHIVE" > "$NZ_NIXPACKS_TOML"
				echo "Nixpacks archive strategy: modern archive $NZ_MODERN_NIXPKGS_ARCHIVE."
			else
				nz_remove_generated_nixpacks_toml
				echo "Nixpacks archive strategy: default Nixpacks archive."
			fi
		}

		# Resolve the complete package-manager toolchain before Nixpacks plans the
		# image. Nearzero bootstraps package managers through the Node toolchain
		# instead of asking nixpkgs for unstable aliases such as npm-9_x,
		# yarn-1_x, or pnpm-10_x. This supports declared packageManager versions,
		# lockfile-only projects, and scripts that invoke a secondary manager.
		NZ_PRIMARY_PM=""
		NZ_PRIMARY_PM_SPEC=""
		NZ_NPM_SPEC=""
		NZ_YARN_SPEC=""
		NZ_PNPM_SPEC=""
		NZ_BUN_SPEC=""
		NZ_NEEDS_COREPACK=0
		NZ_NEEDS_YARN=0
		NZ_NEEDS_PNPM=0
		NZ_NEEDS_BUN=0
		NZ_PM_BOOTSTRAP_COMMAND=""
		NZ_REPLACE_COREPACK_COMMANDS=false

		nz_is_safe_package_manager_spec() {
			printf '%s' "$1" | grep -Eq '^(npm|yarn|pnpm|bun)@[0-9A-Za-z][0-9A-Za-z._+-]*$'
		}
		nz_set_primary_pm() {
			if [ -z "$NZ_PRIMARY_PM" ] && [ -n "$1" ]; then
				NZ_PRIMARY_PM="$1"
				NZ_PRIMARY_PM_SPEC="$2"
			fi
		}
		nz_require_package_manager() {
			NZ_MANAGER="$1"
			NZ_MANAGER_SPEC="$2"
			NZ_REASON="$3"
			case "$NZ_MANAGER" in
				npm)
					if [ -n "$NZ_MANAGER_SPEC" ] && [ -z "$NZ_NPM_SPEC" ]; then
						NZ_NPM_SPEC="$NZ_MANAGER_SPEC"
					fi
					;;
				yarn)
					NZ_NEEDS_COREPACK=1
					NZ_NEEDS_YARN=1
					if [ -n "$NZ_MANAGER_SPEC" ] && [ -z "$NZ_YARN_SPEC" ]; then
						NZ_YARN_SPEC="$NZ_MANAGER_SPEC"
					fi
					;;
				pnpm)
					NZ_NEEDS_COREPACK=1
					NZ_NEEDS_PNPM=1
					if [ -n "$NZ_MANAGER_SPEC" ] && [ -z "$NZ_PNPM_SPEC" ]; then
						NZ_PNPM_SPEC="$NZ_MANAGER_SPEC"
					fi
					;;
				bun)
					NZ_NEEDS_BUN=1
					if [ -n "$NZ_MANAGER_SPEC" ] && [ -z "$NZ_BUN_SPEC" ]; then
						NZ_BUN_SPEC="$NZ_MANAGER_SPEC"
					fi
					;;
				*) return 0 ;;
			esac
			echo "Build tool resolution: $NZ_REASON; requiring $NZ_MANAGER."
		}
		nz_scan_package_json() {
			NZ_PACKAGE_JSON="$1"
			NZ_PACKAGE_REL="\${NZ_PACKAGE_JSON#"$NZ_NIXPACKS_SOURCE_DIR"/}"
			NZ_PACKAGE_MANAGER_SPEC="$(jq -r '.packageManager // empty' "$NZ_PACKAGE_JSON" 2>/dev/null || true)"
			if [ -n "$NZ_PACKAGE_MANAGER_SPEC" ] && ! nz_is_safe_package_manager_spec "$NZ_PACKAGE_MANAGER_SPEC"; then
				echo "Ignoring unsupported packageManager declaration in $NZ_PACKAGE_REL."
				NZ_PACKAGE_MANAGER_SPEC=""
			fi
			NZ_PACKAGE_MANAGER="$(printf '%s' "$NZ_PACKAGE_MANAGER_SPEC" | sed -E 's/@.*$//' || true)"
			case "$NZ_PACKAGE_MANAGER" in
				bun|pnpm|yarn|npm)
					nz_set_primary_pm "$NZ_PACKAGE_MANAGER" "$NZ_PACKAGE_MANAGER_SPEC"
					nz_require_package_manager "$NZ_PACKAGE_MANAGER" "$NZ_PACKAGE_MANAGER_SPEC" "packageManager declares $NZ_PACKAGE_MANAGER in $NZ_PACKAGE_REL"
					;;
			esac

			NZ_SCRIPT_VALUES="$(jq -r '.scripts // {} | .[]?' "$NZ_PACKAGE_JSON" 2>/dev/null || true)"
			if printf '%s\n' "$NZ_SCRIPT_VALUES" | grep -Eq '(^|[;&|()[:space:]])bunx?([[:space:]]|$)'; then
				nz_require_package_manager "bun" "" "package script invokes bun/bunx in $NZ_PACKAGE_REL"
			fi
			if printf '%s\n' "$NZ_SCRIPT_VALUES" | grep -Eq '(^|[;&|()[:space:]])pnpx?([[:space:]]|$)'; then
				nz_require_package_manager "pnpm" "" "package script invokes pnpm/pnpx in $NZ_PACKAGE_REL"
			fi
			if printf '%s\n' "$NZ_SCRIPT_VALUES" | grep -Eq '(^|[;&|()[:space:]])yarn([[:space:]]|$)'; then
				nz_require_package_manager "yarn" "" "package script invokes yarn in $NZ_PACKAGE_REL"
			fi
		}

		if [ -f "$NZ_NIXPACKS_BUILD_DIR/package.json" ]; then
			nz_scan_package_json "$NZ_NIXPACKS_BUILD_DIR/package.json"
		fi
		if [ "$NZ_NIXPACKS_BUILD_DIR" != "$NZ_NIXPACKS_SOURCE_DIR" ] && [ -f "$NZ_NIXPACKS_SOURCE_DIR/package.json" ]; then
			nz_scan_package_json "$NZ_NIXPACKS_SOURCE_DIR/package.json"
		fi
		NZ_PACKAGE_JSON_LIST_FILE="$(mktemp 2>/dev/null || echo /tmp/nz-package-json-list-$$)"
		find "$NZ_NIXPACKS_SOURCE_DIR" -maxdepth 5 \
			\\( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/.next/*" -o -path "*/dist/*" -o -path "*/build/*" \\) -prune \
			-o -name package.json -type f -print > "$NZ_PACKAGE_JSON_LIST_FILE" 2>/dev/null || true
		while IFS= read -r NZ_PACKAGE_JSON; do
			[ -n "$NZ_PACKAGE_JSON" ] || continue
			case "$NZ_PACKAGE_JSON" in
				"$NZ_NIXPACKS_BUILD_DIR/package.json"|"$NZ_NIXPACKS_SOURCE_DIR/package.json") continue ;;
			esac
			nz_scan_package_json "$NZ_PACKAGE_JSON"
		done < "$NZ_PACKAGE_JSON_LIST_FILE"
		rm -f "$NZ_PACKAGE_JSON_LIST_FILE" 2>/dev/null || true

		if [ -f "$NZ_NIXPACKS_BUILD_DIR/bun.lockb" ] || [ -f "$NZ_NIXPACKS_BUILD_DIR/bun.lock" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/bun.lockb" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/bun.lock" ]; then
			nz_set_primary_pm "bun" ""
			nz_require_package_manager "bun" "" "bun lockfile detected"
		fi
		if [ -f "$NZ_NIXPACKS_BUILD_DIR/pnpm-lock.yaml" ] || [ -f "$NZ_NIXPACKS_BUILD_DIR/pnpm-workspace.yaml" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/pnpm-lock.yaml" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/pnpm-workspace.yaml" ]; then
			nz_set_primary_pm "pnpm" ""
			nz_require_package_manager "pnpm" "" "pnpm lockfile detected"
		fi
		if [ -f "$NZ_NIXPACKS_BUILD_DIR/yarn.lock" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/yarn.lock" ]; then
			nz_set_primary_pm "yarn" ""
			nz_require_package_manager "yarn" "" "yarn lockfile detected"
		fi
		if [ -f "$NZ_NIXPACKS_BUILD_DIR/package-lock.json" ] || [ -f "$NZ_NIXPACKS_SOURCE_DIR/package-lock.json" ]; then
			nz_set_primary_pm "npm" ""
		fi
		echo "Build tool resolution: primary package manager \${NZ_PRIMARY_PM:-auto}."

		# Remove conflicting lockfiles according to the resolved package manager,
		# rather than blindly keeping package-lock.json first.
		echo "Cleaning up conflicting lockfiles..."
		cd "$NZ_NIXPACKS_BUILD_DIR"
		NZ_LOCKFILES_FOUND=""
		for NZ_LOCK in package-lock.json yarn.lock pnpm-lock.yaml bun.lockb bun.lock; do
			if [ -f "$NZ_LOCK" ]; then
				NZ_LOCKFILES_FOUND="$NZ_LOCKFILES_FOUND $NZ_LOCK"
			fi
		done
		if [ -n "$NZ_LOCKFILES_FOUND" ]; then
			echo "Found lockfiles:$NZ_LOCKFILES_FOUND"
			echo "Keeping lockfile for \${NZ_PRIMARY_PM:-auto} and removing conflicting package-manager lockfiles..."
			NZ_KEEP_LOCK=""
			case "$NZ_PRIMARY_PM" in
				bun)
					[ -f "bun.lockb" ] && NZ_KEEP_LOCK="bun.lockb"
					[ -z "$NZ_KEEP_LOCK" ] && [ -f "bun.lock" ] && NZ_KEEP_LOCK="bun.lock"
					;;
				pnpm) [ -f "pnpm-lock.yaml" ] && NZ_KEEP_LOCK="pnpm-lock.yaml" ;;
				yarn) [ -f "yarn.lock" ] && NZ_KEEP_LOCK="yarn.lock" ;;
				npm) [ -f "package-lock.json" ] && NZ_KEEP_LOCK="package-lock.json" ;;
			esac
			if [ -z "$NZ_KEEP_LOCK" ]; then
				for NZ_LOCK in bun.lockb bun.lock pnpm-lock.yaml yarn.lock package-lock.json; do
					if [ -f "$NZ_LOCK" ]; then
						NZ_KEEP_LOCK="$NZ_LOCK"
						break
					fi
				done
			fi
			for NZ_LOCK in $NZ_LOCKFILES_FOUND; do
				if [ "$NZ_LOCK" = "$NZ_KEEP_LOCK" ]; then
					echo "Keeping: $NZ_LOCK"
				else
					echo "Removing: $NZ_LOCK"
					rm -f "$NZ_LOCK" 2>/dev/null || true
				fi
			done
		else
			echo "No lockfiles found, Nixpacks will auto-detect package manager from package.json"
		fi

		# Build a safe, version-aware bootstrap command. The declared
		# packageManager value is validated before it can reach a shell command.
		# npm is installed directly; Yarn and pnpm are supplied by a pinned
		# Corepack; Bun is installed from its npm-distributed binary package.
		nz_append_pm_bootstrap() {
			if [ -z "$NZ_PM_BOOTSTRAP_COMMAND" ]; then
				NZ_PM_BOOTSTRAP_COMMAND="$1"
			else
				NZ_PM_BOOTSTRAP_COMMAND="$NZ_PM_BOOTSTRAP_COMMAND && $1"
			fi
		}
		nz_refresh_pm_bootstrap() {
			NZ_PM_BOOTSTRAP_COMMAND=""
			NZ_REPLACE_COREPACK_COMMANDS=false
			NZ_NPM_INSTALL_SPEC="$(printf '%s' "$NZ_NPM_SPEC" | sed -E 's/\\+sha[0-9]+\\..*$//')"
			NZ_YARN_INSTALL_SPEC="$(printf '%s' "$NZ_YARN_SPEC" | sed -E 's/\\+sha[0-9]+\\..*$//')"
			NZ_PNPM_INSTALL_SPEC="$(printf '%s' "$NZ_PNPM_SPEC" | sed -E 's/\\+sha[0-9]+\\..*$//')"
			NZ_BUN_INSTALL_SPEC="$(printf '%s' "$NZ_BUN_SPEC" | sed -E 's/\\+sha[0-9]+\\..*$//')"

			if [ -n "$NZ_NPM_INSTALL_SPEC" ]; then
				nz_append_pm_bootstrap "npm install --global $NZ_NPM_INSTALL_SPEC"
			fi

			if [ "$NZ_NEEDS_COREPACK" = "1" ]; then
				NZ_REPLACE_COREPACK_COMMANDS=true
				nz_append_pm_bootstrap "npm install --global --force corepack@${COREPACK_VERSION}"
				nz_append_pm_bootstrap "corepack enable"

				if [ "$NZ_NEEDS_YARN" = "1" ]; then
					NZ_YARN_INSTALL_SPEC="\${NZ_YARN_INSTALL_SPEC:-yarn@stable}"
					if [ -z "$NZ_YARN_SPEC" ]; then
						NZ_YARN_LOCK=""
						[ -f "$NZ_NIXPACKS_BUILD_DIR/yarn.lock" ] && NZ_YARN_LOCK="$NZ_NIXPACKS_BUILD_DIR/yarn.lock"
						[ -z "$NZ_YARN_LOCK" ] && [ -f "$NZ_NIXPACKS_SOURCE_DIR/yarn.lock" ] && NZ_YARN_LOCK="$NZ_NIXPACKS_SOURCE_DIR/yarn.lock"
						if [ -n "$NZ_YARN_LOCK" ] && grep -q '^# yarn lockfile v1' "$NZ_YARN_LOCK"; then
							NZ_YARN_INSTALL_SPEC="yarn@1.22.22"
						fi
					fi
					nz_append_pm_bootstrap "corepack prepare $NZ_YARN_INSTALL_SPEC --activate"
				fi

				if [ "$NZ_NEEDS_PNPM" = "1" ]; then
					NZ_PNPM_INSTALL_SPEC="\${NZ_PNPM_INSTALL_SPEC:-pnpm@latest}"
					if [ -z "$NZ_PNPM_SPEC" ]; then
						NZ_PNPM_LOCK=""
						[ -f "$NZ_NIXPACKS_BUILD_DIR/pnpm-lock.yaml" ] && NZ_PNPM_LOCK="$NZ_NIXPACKS_BUILD_DIR/pnpm-lock.yaml"
						[ -z "$NZ_PNPM_LOCK" ] && [ -f "$NZ_NIXPACKS_SOURCE_DIR/pnpm-lock.yaml" ] && NZ_PNPM_LOCK="$NZ_NIXPACKS_SOURCE_DIR/pnpm-lock.yaml"
						if [ -n "$NZ_PNPM_LOCK" ]; then
							NZ_PNPM_LOCK_VERSION="$(grep -m 1 '^lockfileVersion:' "$NZ_PNPM_LOCK" | cut -d: -f2- | tr -d '[:space:]"' | sed "s/'//g" || true)"
							case "$NZ_PNPM_LOCK_VERSION" in
								5.0*|5.1*|5.2*|5.3*) NZ_PNPM_INSTALL_SPEC="pnpm@6" ;;
								5.4*) NZ_PNPM_INSTALL_SPEC="pnpm@7" ;;
								6*) NZ_PNPM_INSTALL_SPEC="pnpm@8" ;;
								9*) NZ_PNPM_INSTALL_SPEC="pnpm@10" ;;
							esac
						fi
					fi
					nz_append_pm_bootstrap "corepack prepare $NZ_PNPM_INSTALL_SPEC --activate"
				fi
			fi

			if [ "$NZ_NEEDS_BUN" = "1" ]; then
				NZ_BUN_INSTALL_SPEC="\${NZ_BUN_INSTALL_SPEC:-bun@latest}"
				nz_append_pm_bootstrap "npm install --global --prefix /usr/local $NZ_BUN_INSTALL_SPEC && ln -sf /usr/local/bin/bun /usr/bin/bun && if [ -x /usr/local/bin/bunx ]; then ln -sf /usr/local/bin/bunx /usr/bin/bunx; fi && hash -r && bun --version"
			fi
		}
		nz_refresh_pm_bootstrap

		# Generate one complete Nixpacks plan per attempt, normalize it once, and
		# replay exactly that frozen plan. Removing providers prevents Nixpacks
		# from regenerating the bad package-manager attributes during build.
		NZ_RAW_PLAN="$NZ_NIXPACKS_BUILD_DIR/.nearzero-nixpacks-plan.raw.json"
		NZ_FROZEN_PLAN="$NZ_NIXPACKS_BUILD_DIR/.nearzero-nixpacks-plan.json"
		nz_resolve_plan_package_managers() {
			if jq -e '[.phases[]?.nixPkgs[]? | tostring | select(test("^yarn([-_].*)?$"))] | length > 0' "$NZ_RAW_PLAN" >/dev/null ||
				jq -e '[.. | strings | select(test("(^|[^[:alnum:]_-])yarn([^[:alnum:]_-]|$)"))] | length > 0' "$NZ_RAW_PLAN" >/dev/null; then
				nz_require_package_manager "yarn" "$NZ_YARN_SPEC" "generated Nixpacks plan requires yarn"
			fi
			if jq -e '[.phases[]?.nixPkgs[]? | tostring | select(test("^pnpm([-_].*)?$"))] | length > 0' "$NZ_RAW_PLAN" >/dev/null ||
				jq -e '[.. | strings | select(test("(^|[^[:alnum:]_-])pnpm([^[:alnum:]_-]|$)"))] | length > 0' "$NZ_RAW_PLAN" >/dev/null; then
				nz_require_package_manager "pnpm" "$NZ_PNPM_SPEC" "generated Nixpacks plan requires pnpm"
			fi
			if jq -e '[.phases[]?.nixPkgs[]? | tostring | select(. == "bun")] | length > 0' "$NZ_RAW_PLAN" >/dev/null ||
				jq -e '[.. | strings | select(test("(^|[^[:alnum:]_-])bun(x)?([^[:alnum:]_-]|$)"))] | length > 0' "$NZ_RAW_PLAN" >/dev/null; then
				nz_require_package_manager "bun" "$NZ_BUN_SPEC" "generated Nixpacks plan requires bun"
			fi
			nz_refresh_pm_bootstrap
		}
		nz_generate_frozen_nixpacks_plan() {
			rm -f "$NZ_RAW_PLAN" "$NZ_FROZEN_PLAN" 2>/dev/null || true
			if [ -n "$NZ_WORKSPACE_BUILD_CMD" ] && [ -n "$NZ_WORKSPACE_START_CMD" ]; then
				${workspacePlanCommand} > "$NZ_RAW_PLAN"
			else
				${planCommand} > "$NZ_RAW_PLAN"
			fi

			nz_resolve_plan_package_managers
			NZ_REMOVE_BUN_JSON=false
			if [ "$NZ_NEEDS_BUN" = "1" ]; then
				NZ_REMOVE_BUN_JSON=true
			fi
			jq \
				--arg packageManagerPattern ${quote([NIXPACKS_VERSIONED_PACKAGE_MANAGER_NIX_PATTERN])} \
				--arg bootstrap "$NZ_PM_BOOTSTRAP_COMMAND" \
				--argjson removeBun "$NZ_REMOVE_BUN_JSON" \
				--argjson replaceCorepack "$NZ_REPLACE_COREPACK_COMMANDS" \
				${quote([NIXPACKS_PLAN_NORMALIZATION_FILTER])} \
				"$NZ_RAW_PLAN" > "$NZ_FROZEN_PLAN"
			chmod 600 "$NZ_RAW_PLAN" "$NZ_FROZEN_PLAN"

			if jq -e \
				--arg packageManagerPattern ${quote([NIXPACKS_VERSIONED_PACKAGE_MANAGER_NIX_PATTERN])} \
				'[.phases[]?.nixPkgs[]? | select(tostring | test($packageManagerPattern))] | length == 0' \
				"$NZ_FROZEN_PLAN" >/dev/null; then
				echo "Nixpacks plan normalized for \${NZ_PRIMARY_PM:-auto} package-manager compatibility."
			else
				echo "❌ Nearzero could not normalize the generated Nixpacks package-manager plan."
				return 1
			fi
		}

		# Build with a self-healing retry: if Nixpacks/yarn/npm reports that the
		# installed Node.js is incompatible with a package's "engines" constraint,
		# parse the REQUIRED version from the error, bump NZ_NODE_VERSION to a major
		# that satisfies it, and retry. This recovers automatically when our initial
		# Node major guess is wrong (e.g. a dependency transitively needs >=24).
		NZ_BUILD_LOG="$(mktemp 2>/dev/null || echo /tmp/nz-build-$$.log)"
		NZ_BUILD_RC_FILE="$(mktemp 2>/dev/null || echo /tmp/nz-rc-$$)"
		NZ_MAX_ATTEMPTS=3
		NZ_ATTEMPT=1
		NZ_BUILD_OK=0
		NZ_ARCHIVE_MODE="default"
		NZ_DEFAULT_ARCHIVE_TRIED=0
		NZ_MODERN_ARCHIVE_TRIED=0
		nz_node_requires_modern_archive() {
			NZ_NODE_MAJOR_CHECK="$(printf '%s' "$NZ_NODE_VERSION" | grep -oE '^[0-9]+' || true)"
			[ -n "$NZ_NODE_MAJOR_CHECK" ] && [ "$NZ_NODE_MAJOR_CHECK" -ge 24 ]
		}
			if [ -n "\${NIXPACKS_NIXPKGS_ARCHIVE:-}" ] || nz_node_requires_modern_archive; then
				NZ_ARCHIVE_MODE="modern"
			fi
			while [ "$NZ_ATTEMPT" -le "$NZ_MAX_ATTEMPTS" ]; do
			if [ "$NZ_ARCHIVE_MODE" = "modern" ]; then
				NZ_MODERN_ARCHIVE_TRIED=1
			else
				NZ_DEFAULT_ARCHIVE_TRIED=1
			fi
			nz_prepare_nixpacks_archive "$NZ_ARCHIVE_MODE"
			echo "Starting nixpacks build (attempt $NZ_ATTEMPT/$NZ_MAX_ATTEMPTS, Node.js v$NZ_NODE_VERSION, archive: $NZ_ARCHIVE_MODE)..." ;
			# Disable errexit around the attempt so a build failure doesn't abort the
			# whole deploy; capture the real exit code portably (no bash PIPESTATUS,
			# since the remote shell may be dash) by writing $? inside the pipe's
				# first stage to a file while still streaming output through tee.
				set +e
				{
					nz_generate_frozen_nixpacks_plan
					NZ_ATTEMPT_RC="$?"
					if [ "$NZ_ATTEMPT_RC" = "0" ]; then
						${command}
						NZ_ATTEMPT_RC="$?"
					fi
					echo "$NZ_ATTEMPT_RC" > "$NZ_BUILD_RC_FILE"
				} 2>&1 | tee "$NZ_BUILD_LOG"
			set -e
			NZ_BUILD_RC="$(cat "$NZ_BUILD_RC_FILE" 2>/dev/null || echo 1)"

			if [ "$NZ_BUILD_RC" = "0" ]; then
				NZ_BUILD_OK=1
				break
			fi

			# Look for an engine-incompatibility error and extract the REQUIRED range.
			NZ_EXPECTED="$(grep -oiE 'Expected version "[^"]*"' "$NZ_BUILD_LOG" | head -n 1 | sed -E 's/.*"([^"]*)".*/\\1/' || true)"

			if [ -n "$NZ_EXPECTED" ]; then
				# Take the highest MAJOR mentioned in the required range (e.g.
				# "^20.19.0 || ^22.13.0 || >=24" -> 24) so we satisfy the newest
				# allowed line, which also covers ">=" lower bounds.
				NZ_NEW_MAJOR="$(printf '%s' "$NZ_EXPECTED" | grep -oE '[0-9]+' | sort -rn | head -n 1 || true)"
				if [ -n "$NZ_NEW_MAJOR" ] && [ "$NZ_NEW_MAJOR" != "$NZ_NODE_VERSION" ]; then
					echo "Detected required Node.js range '$NZ_EXPECTED'; retrying with Node.js v$NZ_NEW_MAJOR." ;
					NZ_NODE_VERSION="$NZ_NEW_MAJOR"
					if nz_node_requires_modern_archive; then
						NZ_ARCHIVE_MODE="modern"
					fi
					NZ_ATTEMPT=$((NZ_ATTEMPT + 1))
					continue
				fi
				echo "Build failed due to a Node.js engine requirement ('$NZ_EXPECTED') that the selected version v$NZ_NODE_VERSION does not satisfy, and no higher major could be derived." ;
			fi

			NZ_MISSING_BINARY=""
			for NZ_TOOL_CANDIDATE in bun bunx pnpm pnpx yarn; do
				if grep -qiE "(^|[^[:alnum:]_-])$NZ_TOOL_CANDIDATE([^[:alnum:]_-]|$).*not found|not found.*(^|[^[:alnum:]_-])$NZ_TOOL_CANDIDATE([^[:alnum:]_-]|$)" "$NZ_BUILD_LOG"; then
					NZ_MISSING_BINARY="$NZ_TOOL_CANDIDATE"
					break
				fi
			done
			NZ_MISSING_TOOL=""
				case "$NZ_MISSING_BINARY" in
					bun|bunx) NZ_MISSING_TOOL="bun" ;;
					pnpm|pnpx) NZ_MISSING_TOOL="pnpm" ;;
					yarn) NZ_MISSING_TOOL="yarn" ;;
				esac
				if [ -n "$NZ_MISSING_TOOL" ]; then
					NZ_MISSING_TOOL_ALREADY_REQUIRED=0
					case "$NZ_MISSING_TOOL" in
						bun)
							[ "$NZ_NEEDS_BUN" = "1" ] && NZ_MISSING_TOOL_ALREADY_REQUIRED=1
							NZ_NEEDS_BUN=1
							;;
						pnpm)
							[ "$NZ_NEEDS_PNPM" = "1" ] && NZ_MISSING_TOOL_ALREADY_REQUIRED=1
							NZ_NEEDS_COREPACK=1
							NZ_NEEDS_PNPM=1
							;;
						yarn)
							[ "$NZ_NEEDS_YARN" = "1" ] && NZ_MISSING_TOOL_ALREADY_REQUIRED=1
							NZ_NEEDS_COREPACK=1
							NZ_NEEDS_YARN=1
							;;
					esac
					if [ "$NZ_MISSING_TOOL_ALREADY_REQUIRED" = "1" ]; then
						echo "Build still reports missing build tool '$NZ_MISSING_BINARY' after Nearzero bootstrapped $NZ_MISSING_TOOL." ;
					else
						echo "Detected missing build tool '$NZ_MISSING_BINARY'; regenerating the frozen plan with a $NZ_MISSING_TOOL bootstrap." ;
						nz_refresh_pm_bootstrap
						NZ_ATTEMPT=$((NZ_ATTEMPT + 1))
						continue
					fi
			fi

			# Nixpacks provider names and nixpkgs package attributes drift over time.
			# Package-manager aliases should have been normalized already. For other
			# generated setup packages, retry with the alternate archive.
			#
			# Only react to real Nix evaluation errors. BuildKit also emits a
			# Dockerfile lint warning ("UndefinedVar: Usage of undefined variable
			# '$NIXPACKS_PATH'") on every build; that is NOT a missing nix package,
			# and matching it caused a pointless second-archive retry on every
			# unrelated build failure. Drop those warning lines, and since nix
			# attribute names are never '$'-prefixed, ignore any $-prefixed capture.
			NZ_UNDEFINED_NIXPKGS="$(grep -iE "undefined variable '[^']+'" "$NZ_BUILD_LOG" | grep -v 'UndefinedVar' | grep -oiE "undefined variable '[^']+'" | head -n 1 | sed -E "s/.*'([^']+)'.*/\\1/" || true)"
			case "$NZ_UNDEFINED_NIXPKGS" in
				'$'*) NZ_UNDEFINED_NIXPKGS="" ;;
			esac
				if [ -n "$NZ_UNDEFINED_NIXPKGS" ]; then
					if printf '%s' "$NZ_UNDEFINED_NIXPKGS" | grep -Eq ${quote([NIXPACKS_VERSIONED_PACKAGE_MANAGER_NIX_PATTERN])}; then
						echo "Nearzero generated an invalid package-manager Nix attribute '$NZ_UNDEFINED_NIXPKGS' after plan normalization. This is a platform build-plan error." ;
					elif [ "$NZ_ARCHIVE_MODE" = "modern" ] && [ "$NZ_DEFAULT_ARCHIVE_TRIED" != "1" ]; then
					echo "Nix package '$NZ_UNDEFINED_NIXPKGS' is unavailable in the modern archive; retrying with Nixpacks default archive." ;
					NZ_ARCHIVE_MODE="default"
					NZ_ATTEMPT=$((NZ_ATTEMPT + 1))
					continue
				elif [ "$NZ_ARCHIVE_MODE" = "default" ] && [ "$NZ_MODERN_ARCHIVE_TRIED" != "1" ]; then
					echo "Nix package '$NZ_UNDEFINED_NIXPKGS' is unavailable in the default archive; retrying with modern nixpkgs archive." ;
					NZ_ARCHIVE_MODE="modern"
					NZ_ATTEMPT=$((NZ_ATTEMPT + 1))
					continue
				else
					echo "No compatible nixpkgs archive was found for generated package '$NZ_UNDEFINED_NIXPKGS'." ;
				fi
			fi

			# Not an engine mismatch we can recover from — stop and report.
			break
		done

		rm -f "$NZ_BUILD_RC_FILE" "$NZ_BUILD_LOG" 2>/dev/null || true
		if [ "$NZ_BUILD_OK" != "1" ]; then
			echo "❌ Nixpacks build failed" ;
			exit 1;
		fi
		echo "✅ Nixpacks build completed." ;
		`;

	/*
		Run the container with the image created by nixpacks,
		and copy the artifacts on the host filesystem.
		Then, remove the container and create a static build.
	 */
	if (publishDirectory) {
		const localPath = path.join(buildAppDirectory, publishDirectory);
		const isDirectory =
			publishDirectory.endsWith("/") || !path.extname(publishDirectory);

		bashCommand += `
	docker create --name ${buildContainerId} ${appName}
	mkdir -p ${localPath}
	docker cp ${buildContainerId}:/app/${publishDirectory}${isDirectory ? "/." : ""} ${path.join(buildAppDirectory, publishDirectory)} || {
		docker rm ${buildContainerId}
		echo "❌ Copying ${publishDirectory} to ${path.join(buildAppDirectory, publishDirectory)} failed" ;
		exit 1;
	}
	docker rm ${buildContainerId}
	${getStaticCommand(application)}
				`;
	}

	return bashCommand;
};
