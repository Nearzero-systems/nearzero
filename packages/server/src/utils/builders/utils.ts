import {
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
} from "../docker/utils";
import type { ApplicationNested } from ".";

const BUILD_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMMUTABLE_IMAGE_REFERENCE_PATTERN =
	/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;

export const NEARZERO_BUILD_ENV_SECRET_ID = "nearzero-build-env";

export const PROTECTED_BUILD_CONTEXT_PATHS = [
	".env",
	".env.*",
	"**/.env",
	"**/.env.*",
	".npmrc",
	"**/.npmrc",
	".netrc",
	"**/.netrc",
	".pypirc",
	"**/.pypirc",
	".ssh",
	"**/.ssh",
	".aws",
	"**/.aws",
	"*.pem",
	"**/*.pem",
	"*.key",
	"**/*.key",
	"*.p12",
	"**/*.p12",
	"*.pfx",
	"**/*.pfx",
	"id_rsa*",
	"**/id_rsa*",
	"id_ed25519*",
	"**/id_ed25519*",
] as const;

export function resolveImmutableBuilderImage(
	environmentVariable: string,
	fallback: string,
) {
	const configured = process.env[environmentVariable]?.trim();
	if (!configured) return fallback;
	if (!IMMUTABLE_IMAGE_REFERENCE_PATTERN.test(configured)) {
		throw new Error(
			`${environmentVariable} must be a complete OCI image reference pinned by sha256 digest`,
		);
	}
	return configured;
}

type BuildInputKind = "runtime" | "secret" | "argument";

export interface PreparedBuildInput {
	input: string;
	sensitiveValues: string[];
}

function resolvePairs(
	value: string | null | undefined,
	application: ApplicationNested,
) {
	return prepareEnvironmentVariables(
		value ?? null,
		application.environment.project.env,
		application.environment.env,
	).map((pair) => {
		const [key, resolvedValue] = parseEnvironmentKeyValuePair(pair);
		if (!BUILD_ENV_KEY_PATTERN.test(key)) {
			throw new Error(`Invalid build environment variable name: ${key}`);
		}
		if (resolvedValue.includes("\0")) {
			throw new Error(`Build environment variable ${key} contains a NUL byte`);
		}
		return [key, resolvedValue] as const;
	});
}

function encodeField(value: string) {
	// The leading marker makes an empty base64 value distinguishable from a
	// missing protocol field when bash reads the line.
	return `b${Buffer.from(value, "utf8").toString("base64")}`;
}

function encodeRecord(kind: BuildInputKind, key: string, value: string) {
	return ["v1", kind, encodeField(key), encodeField(value)].join("|");
}

/**
 * Build material is deliberately returned separately from the generated shell
 * script. The deployment runner sends this payload over stdin and never writes
 * it into phase scripts, SSH command strings, or the application checkout.
 */
export function prepareBuildInput(
	application: ApplicationNested,
): PreparedBuildInput {
	const runtime = resolvePairs(application.env, application);
	const secrets = resolvePairs(application.buildSecrets, application);
	const arguments_ = resolvePairs(application.buildArgs, application);
	const records = [
		...runtime.map(([key, value]) => encodeRecord("runtime", key, value)),
		...secrets.map(([key, value]) => encodeRecord("secret", key, value)),
		...arguments_.map(([key, value]) => encodeRecord("argument", key, value)),
	];

	return {
		input: records.length > 0 ? `${records.join("\n")}\n` : "",
		sensitiveValues: [...runtime, ...secrets]
			.map(([, value]) => value)
			.filter(Boolean),
	};
}

/**
 * Materialize the stdin protocol into a private, retry-scoped directory. Value
 * files are mode 0600 and the directory is removed by an EXIT trap. Scripts
 * only ever contain this fixed bootstrap plus non-secret variable names.
 */
export function getBuildInputBootstrap() {
	return String.raw`
set +x
umask 077
NZ_BUILD_MATERIAL_DIR="$(mktemp -d "${"${"}TMPDIR:-/tmp}/nearzero-build-material.XXXXXX")"
chmod 700 "$NZ_BUILD_MATERIAL_DIR"
NZ_BUILD_ENV_DIR="$NZ_BUILD_MATERIAL_DIR/runtime"
NZ_BUILD_SECRET_DIR="$NZ_BUILD_MATERIAL_DIR/secrets"
NZ_BUILD_ARGUMENT_DIR="$NZ_BUILD_MATERIAL_DIR/arguments"
NZ_BUILD_ENV_KEYS_FILE="$NZ_BUILD_MATERIAL_DIR/runtime.keys"
NZ_BUILD_SECRET_KEYS_FILE="$NZ_BUILD_MATERIAL_DIR/secrets.keys"
NZ_BUILD_ARGUMENT_KEYS_FILE="$NZ_BUILD_MATERIAL_DIR/arguments.keys"
NZ_BUILD_ENV_EXPORT_FILE="$NZ_BUILD_MATERIAL_DIR/runtime.exports"
mkdir -m 700 "$NZ_BUILD_ENV_DIR" "$NZ_BUILD_SECRET_DIR" "$NZ_BUILD_ARGUMENT_DIR"
: > "$NZ_BUILD_ENV_KEYS_FILE"
: > "$NZ_BUILD_SECRET_KEYS_FILE"
: > "$NZ_BUILD_ARGUMENT_KEYS_FILE"
: > "$NZ_BUILD_ENV_EXPORT_FILE"
chmod 600 "$NZ_BUILD_ENV_KEYS_FILE" "$NZ_BUILD_SECRET_KEYS_FILE" "$NZ_BUILD_ARGUMENT_KEYS_FILE" "$NZ_BUILD_ENV_EXPORT_FILE"

nz_cleanup_build_material() {
	rm -rf -- "$NZ_BUILD_MATERIAL_DIR" 2>/dev/null || true
}
trap nz_cleanup_build_material EXIT

nz_decode_build_field() {
	case "$1" in
		b*) printf '%s' "${"${"}1#b}" | base64 -d ;;
		*) return 1 ;;
	esac
}

while IFS='|' read -r NZ_BUILD_VERSION NZ_BUILD_KIND NZ_BUILD_KEY_FIELD NZ_BUILD_VALUE_FIELD NZ_BUILD_EXTRA; do
	[ -n "$NZ_BUILD_VERSION" ] || continue
	[ "$NZ_BUILD_VERSION" = "v1" ] && [ -z "$NZ_BUILD_EXTRA" ] || {
		echo "Invalid Nearzero build input payload" >&2
		exit 65
	}
	NZ_BUILD_KEY="$(nz_decode_build_field "$NZ_BUILD_KEY_FIELD")" || exit 65
	printf '%s' "$NZ_BUILD_KEY" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$' || {
		echo "Invalid Nearzero build input key" >&2
		exit 65
	}
	case "$NZ_BUILD_KIND" in
		runtime)
			NZ_BUILD_VALUE_PATH="$NZ_BUILD_ENV_DIR/$NZ_BUILD_KEY"
			NZ_BUILD_KEYS_PATH="$NZ_BUILD_ENV_KEYS_FILE"
			;;
		secret)
			NZ_BUILD_VALUE_PATH="$NZ_BUILD_SECRET_DIR/$NZ_BUILD_KEY"
			NZ_BUILD_KEYS_PATH="$NZ_BUILD_SECRET_KEYS_FILE"
			;;
		argument)
			NZ_BUILD_VALUE_PATH="$NZ_BUILD_ARGUMENT_DIR/$NZ_BUILD_KEY"
			NZ_BUILD_KEYS_PATH="$NZ_BUILD_ARGUMENT_KEYS_FILE"
			;;
		*)
			echo "Invalid Nearzero build input kind" >&2
			exit 65
			;;
	esac
	nz_decode_build_field "$NZ_BUILD_VALUE_FIELD" > "$NZ_BUILD_VALUE_PATH" || exit 65
	chmod 600 "$NZ_BUILD_VALUE_PATH"
	printf '%s\n' "$NZ_BUILD_KEY" >> "$NZ_BUILD_KEYS_PATH"
done

nz_read_build_value() {
	# Appending a sentinel before command substitution preserves every trailing
	# newline. NUL is rejected before this payload is created because shell
	# variables cannot represent it.
	NZ_BUILD_VALUE="$(cat "$1"; printf '.')"
	NZ_BUILD_VALUE="${"${"}NZ_BUILD_VALUE%.}"
}

while IFS= read -r NZ_BUILD_KEY; do
	[ -n "$NZ_BUILD_KEY" ] || continue
	nz_read_build_value "$NZ_BUILD_ENV_DIR/$NZ_BUILD_KEY"
	# The bootstrap itself runs in Bash, but this file is sourced by Docker RUN
	# instructions whose default shell is POSIX /bin/sh. Single-quote the value
	# and replace each embedded quote with the portable: '"'"'.
	NZ_BUILD_QUOTED_VALUE=${"${"}NZ_BUILD_VALUE//\'/\'\"\'\"\'}
	printf "export %s='%s'\n" "$NZ_BUILD_KEY" "$NZ_BUILD_QUOTED_VALUE" >> "$NZ_BUILD_ENV_EXPORT_FILE"
	unset NZ_BUILD_VALUE NZ_BUILD_QUOTED_VALUE
done < "$NZ_BUILD_ENV_KEYS_FILE"

nz_load_build_kind() {
	NZ_BUILD_LOAD_KIND="$1"
	case "$NZ_BUILD_LOAD_KIND" in
		runtime) NZ_BUILD_LOAD_DIR="$NZ_BUILD_ENV_DIR"; NZ_BUILD_LOAD_KEYS="$NZ_BUILD_ENV_KEYS_FILE" ;;
		secret) NZ_BUILD_LOAD_DIR="$NZ_BUILD_SECRET_DIR"; NZ_BUILD_LOAD_KEYS="$NZ_BUILD_SECRET_KEYS_FILE" ;;
		argument) NZ_BUILD_LOAD_DIR="$NZ_BUILD_ARGUMENT_DIR"; NZ_BUILD_LOAD_KEYS="$NZ_BUILD_ARGUMENT_KEYS_FILE" ;;
		*) return 65 ;;
	esac
	while IFS= read -r NZ_BUILD_KEY; do
		[ -n "$NZ_BUILD_KEY" ] || continue
		nz_read_build_value "$NZ_BUILD_LOAD_DIR/$NZ_BUILD_KEY"
		export "$NZ_BUILD_KEY=$NZ_BUILD_VALUE"
		unset NZ_BUILD_VALUE
	done < "$NZ_BUILD_LOAD_KEYS"
}

nz_load_runtime_environment() { nz_load_build_kind runtime; }
nz_load_secret_environment() { nz_load_build_kind secret; }
nz_load_argument_environment() { nz_load_build_kind argument; }
`;
}

/** Empty-input compatibility for direct command tests and legacy callers. */
export function getBuildRuntimePreamble() {
	return `
if ! declare -F nz_load_runtime_environment >/dev/null 2>&1; then
	NZ_BUILD_MATERIAL_DIR=""
	NZ_BUILD_ENV_DIR=""
	NZ_BUILD_SECRET_DIR=""
	NZ_BUILD_ARGUMENT_DIR=""
	NZ_BUILD_ENV_KEYS_FILE=/dev/null
	NZ_BUILD_SECRET_KEYS_FILE=/dev/null
	NZ_BUILD_ARGUMENT_KEYS_FILE=/dev/null
	NZ_BUILD_ENV_EXPORT_FILE=/dev/null
	nz_load_runtime_environment() { :; }
	nz_load_secret_environment() { :; }
	nz_load_argument_environment() { :; }
fi
`;
}

export function wrapBuildCommand(script: string) {
	return `${getBuildInputBootstrap()}\n(\n${script}\n)`;
}
