#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nearzero-install-test.XXXXXX")"
INSTALL_DIR="$TEST_ROOT/install"

cleanup() {
	rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
	printf 'verify-oss-install: %s\n' "$*" >&2
	exit 1
}

env_value() {
	local key="$1"
	local env_file="${2:-$INSTALL_DIR/.env}"
	awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$env_file"
}

file_mode() {
	if stat -f '%Lp' "$1" >/dev/null 2>&1; then
		stat -f '%Lp' "$1"
	else
		stat -c '%a' "$1"
	fi
}

require_exact_line() {
	local file="$1"
	local expected="$2"
	grep -Fxq -- "$expected" "$file" || fail "$file is missing required line: $expected"
}

installer_default_image() {
	local key="$1"
	awk -v key="$key" '
		index($0, key "=\"${" key ":-") == 1 {
			prefix = key "=\"${" key ":-"
			value = substr($0, length(prefix) + 1)
			sub(/}\"$/, "", value)
			print value
			exit
		}
	' "$ROOT_DIR/scripts/install.sh"
}

bash -n "$ROOT_DIR/scripts/install.sh" || fail "scripts/install.sh is not valid Bash"
sh -n "$ROOT_DIR/scripts/install-verified-build-tools.sh" || fail "verified build-tool installer is not valid POSIX shell"

for supply_chain_file in \
	"$ROOT_DIR/Dockerfile" \
	"$ROOT_DIR/packages/server/src/setup/builder-versions.ts" \
	"$ROOT_DIR/scripts/install.sh" \
	"$ROOT_DIR/.github/workflows/pull-request.yml"; do
	if grep -Eq '(curl|wget).*\|.*(bash|sh)([[:space:]]|$)' "$supply_chain_file"; then
		fail "$supply_chain_file streams a network response into a shell"
	fi
done

if grep -En 'get\.docker\.com|rclone\.org/install\.sh|nixpacks\.com/install\.sh|railpack\.com/install\.sh' \
	"$ROOT_DIR/Dockerfile" \
	"$ROOT_DIR/packages/server/src/setup/builder-versions.ts" \
	"$ROOT_DIR/scripts/install.sh" \
	"$ROOT_DIR/.github/workflows/pull-request.yml" >/dev/null; then
	fail "an executable OSS build/install path still references a network installer script"
fi

grep -Fq 'docker:28.5.2-cli@sha256:' "$ROOT_DIR/Dockerfile" || fail "Docker CLI image is not digest-pinned"
grep -Fq 'oven/bun:1.3.10@sha256:' "$ROOT_DIR/Dockerfile" || fail "root Bun image is not digest-pinned"
grep -Fq 'oven/bun:1.3.10@sha256:' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule Bun image is not digest-pinned"
grep -Fq 'node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule Node runtime image is not supported and digest-pinned"
grep -Fq 'COPY --from=node-runtime /usr/local /usr/local' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule native addons are not built with the production Node toolchain"
grep -Fq 'npm_config_nodedir=/usr/local' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule native addons are not compiled against the production Node headers"
grep -Fq 'golang:1.26-alpine3.24@sha256:' "$ROOT_DIR/Dockerfile.monitoring" || fail "monitoring Go image is not supported and digest-pinned"
grep -Fq 'alpine:3.24@sha256:' "$ROOT_DIR/Dockerfile.monitoring" || fail "monitoring runtime image is not supported and digest-pinned"
grep -Fq 'sha256sum -c -' "$ROOT_DIR/scripts/install-verified-build-tools.sh" || fail "build-tool installer does not verify SHA-256"
grep -Fq 'x86_64-unknown-linux-musl' "$ROOT_DIR/scripts/install-verified-build-tools.sh" || fail "amd64 build-tool artifact is missing"
grep -Fq 'aarch64-unknown-linux-musl' "$ROOT_DIR/scripts/install-verified-build-tools.sh" || fail "arm64 build-tool artifact is missing"
grep -Fq 'install-verified-build-tools.sh nixpacks railpack buildpacks rclone' "$ROOT_DIR/Dockerfile" || fail "production image does not install every supported managed builder"
grep -Fq 'test -s "$dir/lib/binding/napi-v3/bcrypt_lib.node"' "$ROOT_DIR/Dockerfile" || fail "production image build does not fail closed when bcrypt is missing"
grep -Fq 'COPY --from=build /usr/src/app/apps/schedules/node_modules ./apps/schedules/node_modules' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule runtime dependencies are not copied from the workspace build"
grep -Fq 'COPY --from=build /usr/src/app/packages/server ./packages/server' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule runtime is missing the built server workspace dependency"
grep -Fq 'node-pre-gyp install --build-from-source' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule runtime bcrypt native addon is not built from locked source"
grep -Fq 'test -s "$dir/lib/binding/napi-v3/bcrypt_lib.node"' "$ROOT_DIR/Dockerfile.schedule" || fail "schedule image build does not fail closed when bcrypt is missing"
grep -Fq 'node --input-type=module' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not exercise the schedule image with its Node runtime"
[[ "$(grep -c 'node --input-type=module' "$ROOT_DIR/.github/workflows/docker-images.yml")" -ge 2 ]] || fail "release workflow does not exercise both Node runtime images with Node"
if grep -Fq 'bun -e' "$ROOT_DIR/.github/workflows/docker-images.yml"; then
	fail "release workflow must not load Node native addons through Bun"
fi
grep -Fq 'const hash = await bcrypt.hash("smoke", 4)' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not exercise the schedule native runtime dependency"
grep -Fq 'typeof server.sanitizePublicErrorMessage !== "function"' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not exercise the schedule server workspace dependency"
for image_file in Dockerfile Dockerfile.monitoring Dockerfile.schedule; do
	grep -Fq 'org.opencontainers.image.source="https://github.com/Nearzero-systems/nearzero"' "$ROOT_DIR/$image_file" || fail "$image_file does not link its GHCR package to the source repository"
done
grep -Fq 'install.sh.sha256' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not publish installer checksums"
grep -Fq 'workingDirectory: workers/install-script' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not deploy the installer delivery worker"
grep -Fq 'Verify the published versioned installer and checksum' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not verify the public installer checksum path"
grep -Fq 'sha256sum --check install.sh.sha256' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not validate the published installer checksum"
grep -Fq 'needs: [verify, promote]' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "installer publication does not wait for verified image promotion"
grep -Fq 'tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAMESPACE }}/${{ matrix.image }}:sha-${{ needs.verify.outputs.short_sha }}' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "image builds must publish only commit-addressed staging tags"
grep -Fq 'Promote the complete staged set to the release version' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not gate semantic-tag promotion on the complete staged set"
grep -Fq 'Smoke-test staged runtime images' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not smoke-test staged runtime images"
grep -Fq 'Verify public multi-architecture companion images' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release workflow does not verify public companion manifests"
grep -Fq 'REQUESTED_RELEASE_VERSION: ${{ github.event.inputs.release_version' "$ROOT_DIR/.github/workflows/docker-images.yml" || fail "release input is not passed through the step environment"
if grep -Fq 'release_version="${{ github.event.inputs.release_version' "$ROOT_DIR/.github/workflows/docker-images.yml"; then
	fail "release input is interpolated directly into a shell script"
fi
if grep -Eq '^[[:space:]]*uses:[[:space:]]+(actions/checkout|docker/(setup-buildx-action|login-action|build-push-action)|cloudflare/wrangler-action)@v[0-9]' "$ROOT_DIR/.github/workflows/docker-images.yml"; then
	fail "release workflow actions must be pinned to full commit SHAs"
fi
unpinned_actions="$({
	grep -REn '^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]+' \
		"$ROOT_DIR/.github/workflows" || true
} | grep -Ev '@[0-9a-f]{40}([[:space:]]*(#.*)?)$' || true)"
if [[ -n "$unpinned_actions" ]]; then
	printf '%s\n' "$unpinned_actions" >&2
	fail "every third-party workflow action must be pinned to a full commit SHA"
fi

installer_release_version=""
for image_spec in \
	"NEARZERO_IMAGE:nearzero" \
	"NEARZERO_MONITORING_IMAGE:monitoring" \
	"NEARZERO_SCHEDULE_IMAGE:schedule"; do
	image_key="${image_spec%%:*}"
	image_name="${image_spec#*:}"
	image_ref="$(installer_default_image "$image_key")"
	expected_prefix="ghcr.io/nearzero-systems/${image_name}:"
	[[ "$image_ref" == "$expected_prefix"* ]] || fail "$image_key has an unexpected installer default: $image_ref"
	image_version="${image_ref#"$expected_prefix"}"
	[[ -n "$image_version" && "$image_version" != "$image_ref" ]] || fail "$image_key is missing a release tag"
	if [[ -z "$installer_release_version" ]]; then
		installer_release_version="$image_version"
	elif [[ "$image_version" != "$installer_release_version" ]]; then
		fail "Nearzero installer companion image tags are not release-aligned"
	fi
	grep -Fq "${image_key}=${image_ref}" "$ROOT_DIR/.env.example" || fail ".env.example does not match the $image_key installer default"
done

for immutable_builder_key in \
	NEARZERO_HEROKU_BUILDER_IMAGE \
	NEARZERO_PAKETO_BUILDER_IMAGE \
	NEARZERO_RAILPACK_FRONTEND_IMAGE \
	NEARZERO_STATIC_NGINX_IMAGE; do
	grep -Fq "# ${immutable_builder_key}=" "$ROOT_DIR/.env.example" ||
		fail ".env.example does not document $immutable_builder_key"
done

if [[ -n "${EXPECTED_RELEASE_VERSION:-}" && "$installer_release_version" != "$EXPECTED_RELEASE_VERSION" ]]; then
	fail "installer image version $installer_release_version does not match release $EXPECTED_RELEASE_VERSION"
fi

for dockerignore_line in \
	'**/node_modules' \
	'**/dist' \
	'.env' \
	'.env.*' \
	'**/.env' \
	'**/.env.*' \
	'**/.npmrc' \
	'**/.netrc' \
	'**/.pypirc' \
	'**/.ssh' \
	'**/.aws' \
	'**/*.pem' \
	'**/*.key' \
	'**/*.p12' \
	'**/*.pfx' \
	'**/id_rsa*' \
	'**/id_ed25519*'; do
	require_exact_line "$ROOT_DIR/.dockerignore" "$dockerignore_line"
done

if grep -Eq '^![^#]*\.env([.*]|$)' "$ROOT_DIR/.dockerignore"; then
	fail ".dockerignore must not re-include any environment file in the image build context"
fi

while IFS= read -r tracked_env; do
	[[ -e "$ROOT_DIR/$tracked_env" ]] || continue
	case "$tracked_env" in
	.env.example | */.env.example) ;;
	*) fail "tracked environment file may contain deployment secrets: $tracked_env" ;;
	esac
done < <(git -C "$ROOT_DIR" ls-files | grep -E '(^|/)\.env(\..*)?$' || true)

if grep -Eq 'dotenv\.config|process\.env\.\$?\{?key' "$ROOT_DIR/apps/platform/esbuild.config.ts"; then
	fail "platform build must not compile environment-file values into the server bundle"
fi
if grep -R -Fq 'PUBLIC_METRICS_TOKEN' "$ROOT_DIR/apps/console/src" "$ROOT_DIR/apps/console/.env.example"; then
	fail "monitoring credentials must not be exposed through a PUBLIC_ browser variable"
fi

# Fresh unattended installs use bootstrap registration and must name the only
# email allowed to claim the first owner account.
export NEARZERO_ADMIN_EMAIL=owner@example.com

run_installer() {
	DRY_RUN=1 \
	INSTALL_DIR="$INSTALL_DIR" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null
}

DRY_RUN=1 \
INSTALL_DIR="$INSTALL_DIR" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
NEARZERO_PLATFORM_DOMAIN=Example.COM. \
NEARZERO_ENABLE_MANAGED_DNS=true \
"$ROOT_DIR/scripts/install.sh" >/dev/null

[[ "$(file_mode "$INSTALL_DIR/.env")" == "600" ]] || fail ".env must be mode 0600"
[[ "$(file_mode "$INSTALL_DIR/docker-compose.prod.yml")" == "644" ]] || fail "production Compose must be mode 0644"
[[ "$(file_mode "$INSTALL_DIR/docker-compose.local-db.yml")" == "644" ]] || fail "local database Compose must be mode 0644"
[[ "$(file_mode "$INSTALL_DIR/nearzero")" == "755" ]] || fail "operations helper must be mode 0755"
grep -Fq 'install -o root -g root -m "$mode"' "$ROOT_DIR/scripts/install.sh" || fail "installer files are not installed with explicit root ownership"
[[ "$(env_value NEARZERO_PUBLIC_IP)" == "203.0.113.10" ]] || fail "detected/overridden public IP was not persisted"
[[ "$(env_value NEARZERO_ADMIN_EMAIL)" == "owner@example.com" ]] || fail "bootstrap administrator email was not persisted"
[[ "$(env_value NEARZERO_REGISTRATION_MODE)" == "bootstrap" ]] || fail "fresh install did not default to bootstrap registration"
[[ "$(env_value NEARZERO_DATA_MODE)" == "local" ]] || fail "fresh install did not persist local data mode"
[[ "$(env_value NEARZERO_MANAGEMENT_BIND_ADDRESS)" == "127.0.0.1" ]] || fail "management ports must default to loopback"
[[ "$(env_value NEARZERO_PLATFORM_DOMAIN)" == "example.com" ]] || fail "platform domain was not normalized"
[[ "$(env_value NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE)" == "false" ]] || fail "shared-edge routing must default to false"
[[ "$(env_value NEARZERO_ALLOW_MONITORING_DOCKER_METADATA)" == "false" ]] || fail "Docker metadata monitoring must default to false"
[[ "$(env_value NEARZERO_SSH_STRICT_HOST_KEY_CHECKING)" == "false" ]] || fail "SSH strict host-key mode must default to false until the trust store is seeded"
[[ "$(env_value CONSOLE_URL)" == "http://127.0.0.1:4321" ]] || fail "IP-only loopback install did not publish the SSH-tunnel console origin"
[[ "$(env_value BETTER_AUTH_URL)" == "http://127.0.0.1:4321" ]] || fail "IP-only loopback install did not use the console origin for auth"
[[ "$(env_value PUBLIC_GIT_PROVIDER_BASE_URL)" == "http://127.0.0.1:4321" ]] || fail "IP-only loopback install did not use the console origin for Git callbacks"
[[ "$(env_value PUBLIC_BACKEND_URL)" == "http://127.0.0.1:4321" ]] || fail "IP-only loopback install exposed an unreachable raw API origin"
case ",$(env_value COMPOSE_PROFILES)," in
	*,managed-dns,*) ;;
	*) fail "managed-dns profile was not activated" ;;
esac

cmp -s "$ROOT_DIR/docker-compose.prod.yml" "$INSTALL_DIR/docker-compose.prod.yml" || fail "installer Compose template drifted from docker-compose.prod.yml"
if grep -Fq ':latest' "$INSTALL_DIR/docker-compose.prod.yml"; then
	fail "production Compose contains a mutable latest image tag"
fi
if grep -Fq 'monitoring-docker-proxy' "$INSTALL_DIR/docker-compose.prod.yml" ||
	grep -Fq 'DOCKER_HOST:' "$INSTALL_DIR/docker-compose.prod.yml"; then
	fail "default monitoring Compose exposes Docker metadata"
fi
if grep -Fq '/proc:/host/proc' "$INSTALL_DIR/docker-compose.prod.yml" ||
	grep -Fq '/:/host/root' "$INSTALL_DIR/docker-compose.prod.yml"; then
	fail "default monitoring Compose exposes host process or root secrets"
fi
[[ "$(grep -c '^[[:space:]]*env_file:' "$INSTALL_DIR/docker-compose.prod.yml")" == "1" ]] ||
	fail "only the platform service may receive the complete installer environment"
grep -Fq 'API_KEY: ${API_KEY:-}' "$INSTALL_DIR/docker-compose.prod.yml" ||
	fail "schedules API key wiring is missing"
grep -Fq 'NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE: ${NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE:-false}' "$INSTALL_DIR/docker-compose.prod.yml" ||
	fail "shared-edge routing flag is not explicitly wired to the platform"
grep -Fq '${NEARZERO_MANAGEMENT_BIND_ADDRESS:-127.0.0.1}:${NEARZERO_PLATFORM_PORT:-3000}:3000' "$INSTALL_DIR/docker-compose.prod.yml" || fail "platform port is not bound through the safe management address"
grep -Fq '${NEARZERO_MANAGEMENT_BIND_ADDRESS:-127.0.0.1}:${NEARZERO_CONSOLE_PORT:-4321}:4321' "$INSTALL_DIR/docker-compose.prod.yml" || fail "console port is not bound through the safe management address"
grep -Fq 'entrypoint: ["bun", "/app/dns-init.ts"]' "$INSTALL_DIR/docker-compose.prod.yml" || fail "managed DNS bootstrap entrypoint is missing"
grep -Fq './dns-init.ts:/app/dns-init.ts:ro' "$INSTALL_DIR/docker-compose.prod.yml" || fail "managed DNS bootstrap script mount is missing"
grep -Fq 'user: "0:0"' "$INSTALL_DIR/docker-compose.prod.yml" || fail "CoreDNS must run as root to read installer-owned zone volume files"
[[ -f "$INSTALL_DIR/dns-init.ts" ]] || fail "installer did not materialize dns-init.ts"
for bootstrap_env in NEARZERO_ADMIN_EMAIL NEARZERO_MANAGEMENT_HOSTNAME NEARZERO_MANAGED_DNS_ZONE NEARZERO_MANAGED_DNS_SOA_EMAIL NEARZERO_PUBLIC_IP; do
	grep -Fq "${bootstrap_env}: \${${bootstrap_env}:-}" "$INSTALL_DIR/docker-compose.prod.yml" ||
		fail "managed DNS bootstrap is missing $bootstrap_env"
done
grep -Fq 'directory /etc/coredns/zones (.*)\\.zone {1}' "$ROOT_DIR/docker/dns-init.ts" || fail "CoreDNS zone filename matcher is missing"
grep -Fq 'reload 2s' "$ROOT_DIR/docker/dns-init.ts" || fail "CoreDNS zone reload interval is missing"
grep -Fq 'up -d --force-recreate --wait --wait-timeout' "$ROOT_DIR/scripts/install.sh" || fail "installer does not gate success on Compose readiness"
grep -Fq -- '--remove-orphans' "$ROOT_DIR/scripts/install.sh" || fail "installer does not retire services removed by an explicit mode transition"
grep -Fq 'DATA_MODE="$(installed_env_value NEARZERO_DATA_MODE)"' "$INSTALL_DIR/nearzero" || fail "operations helper does not read the persisted data mode"
grep -Fq 'if [[ ! -f "$INSTALL_DIR/docker-compose.local-db.yml" ]]' "$INSTALL_DIR/nearzero" || fail "operations helper does not fail closed when the local overlay is missing"
cmp -s "$ROOT_DIR/docker-compose.local-db.yml" "$INSTALL_DIR/docker-compose.local-db.yml" || fail "installer local database Compose template drifted"
[[ "$(grep -c 'restart: unless-stopped' "$INSTALL_DIR/docker-compose.local-db.yml")" -ge 2 ]] || fail "local Postgres and Redis do not restart after reboot"
compose_services="$(docker compose -f "$INSTALL_DIR/docker-compose.prod.yml" --env-file "$INSTALL_DIR/.env" config --services)"
case "$compose_services" in
	*dns-init*dns*) ;;
	*) fail "managed DNS services were not activated" ;;
esac

old_auth_secret="$(env_value BETTER_AUTH_SECRET)"
old_metrics_token="$(env_value NEARZERO_METRICS_TOKEN)"
old_console_url="$(env_value CONSOLE_URL)"
run_installer
[[ "$(env_value BETTER_AUTH_SECRET)" == "$old_auth_secret" ]] || fail "auth secret changed on rerun"
[[ "$(env_value NEARZERO_METRICS_TOKEN)" == "$old_metrics_token" ]] || fail "metrics token changed on rerun"
[[ "$(env_value CONSOLE_URL)" == "$old_console_url" ]] || fail "console URL changed on rerun"
[[ "$(env_value NEARZERO_PLATFORM_DOMAIN)" == "example.com" ]] || fail "platform domain was not preserved on rerun"
[[ "$(env_value NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE)" == "false" ]] || fail "shared-edge routing changed on rerun"

preserve_dir="$TEST_ROOT/generated-config-preservation"
custom_nearzero_image='registry.example.com/nearzero:preserved'
custom_monitoring_image='registry.example.com/monitoring:preserved'
custom_schedule_image='registry.example.com/schedule:preserved'
custom_dns_image='registry.example.com/coredns:preserved'
DRY_RUN=1 \
INSTALL_DIR="$preserve_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
POSTGRES_USER=preserved_user \
POSTGRES_DB=preserved_db \
NEARZERO_PLATFORM_PORT=3100 \
NEARZERO_CONSOLE_PORT=4421 \
NEARZERO_METRICS_PORT=4600 \
NEARZERO_METRICS_REFRESH_SECONDS=11 \
NEARZERO_METRICS_RETENTION_DAYS=9 \
NEARZERO_METRICS_CRON='17 4 * * 2' \
NEARZERO_STARTUP_TIMEOUT_SECONDS=777 \
NEARZERO_IMAGE="$custom_nearzero_image" \
NEARZERO_MONITORING_IMAGE="$custom_monitoring_image" \
NEARZERO_SCHEDULE_IMAGE="$custom_schedule_image" \
NEARZERO_DNS_IMAGE="$custom_dns_image" \
"$ROOT_DIR/scripts/install.sh" >/dev/null

custom_secret_marker='provider-secret-marker-must-stay-redacted'
printf '%s\n' "OPENROUTER_API_KEY=$custom_secret_marker" >> "$preserve_dir/.env"
if ! preserve_rerun_output="$(
	DRY_RUN=1 \
	INSTALL_DIR="$preserve_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" 2>&1
)"; then
	fail "plain rerun with preserved generated and custom configuration failed"
fi
[[ "$preserve_rerun_output" != *"$custom_secret_marker"* ]] || fail "preserved custom environment secret appeared in installer output"
for expected_assignment in \
	'POSTGRES_USER=preserved_user' \
	'POSTGRES_DB=preserved_db' \
	'NEARZERO_PLATFORM_PORT=3100' \
	'NEARZERO_CONSOLE_PORT=4421' \
	'NEARZERO_METRICS_PORT=4600' \
	'NEARZERO_METRICS_REFRESH_SECONDS=11' \
	'NEARZERO_METRICS_RETENTION_DAYS=9' \
	'NEARZERO_METRICS_CRON="17 4 * * 2"' \
	'NEARZERO_STARTUP_TIMEOUT_SECONDS=777' \
	"NEARZERO_IMAGE=$custom_nearzero_image" \
	"NEARZERO_MONITORING_IMAGE=$custom_monitoring_image" \
	"NEARZERO_SCHEDULE_IMAGE=$custom_schedule_image" \
	"NEARZERO_DNS_IMAGE=$custom_dns_image" \
	"OPENROUTER_API_KEY=$custom_secret_marker"; do
	grep -Fxq "$expected_assignment" "$preserve_dir/.env" || fail "plain rerun did not preserve a generated or custom environment assignment"
done
[[ -z "$(awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { if (seen[$1]++) print $1 }' "$preserve_dir/.env")" ]] || fail "plain rerun produced duplicate generated environment keys"
grep -Eq '^DATABASE_URL=postgresql://preserved_user:[^@]+@postgres:5432/preserved_db$' "$preserve_dir/.env" || fail "plain rerun rewrote the local database identity"

upgrade_dir="$TEST_ROOT/stale-official-image-upgrade"
mkdir -p "$upgrade_dir"
printf '%s\n' \
	'NEARZERO_IMAGE=ghcr.io/nearzero-systems/nearzero:0.1.40' \
	'NEARZERO_MONITORING_IMAGE=ghcr.io/nearzero-systems/monitoring:0.1.40' \
	'NEARZERO_PUBLIC_IP=203.0.113.10' \
	'NEARZERO_DATA_MODE=local' \
	'POSTGRES_USER=nearzero' \
	'POSTGRES_DB=nearzero' \
	'NEARZERO_REGISTRATION_MODE=open' \
	'BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
	'NEARZERO_METRICS_TOKEN=0123456789abcdef0123456789abcdef' > "$upgrade_dir/.env"
DRY_RUN=1 INSTALL_DIR="$upgrade_dir" NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null
grep -Fxq 'NEARZERO_IMAGE=ghcr.io/nearzero-systems/nearzero:0.1.45' "$upgrade_dir/.env" ||
	fail "plain rerun did not upgrade a stale official NEARZERO_IMAGE"
grep -Fxq 'NEARZERO_MONITORING_IMAGE=ghcr.io/nearzero-systems/monitoring:0.1.45' "$upgrade_dir/.env" ||
	fail "plain rerun did not upgrade a stale official NEARZERO_MONITORING_IMAGE"

duplicate_env_dir="$TEST_ROOT/duplicate-custom-env"
cp -R "$preserve_dir" "$duplicate_env_dir"
printf '%s\n' "OPENROUTER_API_KEY=$custom_secret_marker" >> "$duplicate_env_dir/.env"
if DRY_RUN=1 INSTALL_DIR="$duplicate_env_dir" NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "duplicate custom environment assignment was accepted on rerun"
fi
malformed_env_dir="$TEST_ROOT/malformed-custom-env"
cp -R "$preserve_dir" "$malformed_env_dir"
printf '%s\n' 'this is not a dotenv assignment' >> "$malformed_env_dir/.env"
if DRY_RUN=1 INSTALL_DIR="$malformed_env_dir" NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "malformed custom environment content was accepted on rerun"
fi

backup_fake_bin="$TEST_ROOT/backup-fake-bin"
backup_args="$TEST_ROOT/backup-docker-args"
restore_capture="$TEST_ROOT/restore-capture"
mkdir -p "$backup_fake_bin"
printf '%s\n' \
	'#!/usr/bin/env sh' \
	'printf "%s\n" "$*" >> "$FAKE_DOCKER_ARGS"' \
	'case "$*" in' \
	'  *pg_dump*) printf "%s\n" "-- complete atomic dump"; if [ "${FAKE_DOCKER_FAIL:-0}" = 1 ]; then exit 1; fi; exit 0 ;;' \
	'  *psql*) cat > "$FAKE_RESTORE_CAPTURE" ;;' \
	'esac' > "$backup_fake_bin/docker"
chmod 0755 "$backup_fake_bin/docker"
backup_path="$TEST_ROOT/control-plane.sql"
: > "$backup_args"
PATH="$backup_fake_bin:$PATH" \
INSTALL_DIR="$preserve_dir" \
POSTGRES_USER=wrong_shell_user \
POSTGRES_DB=wrong_shell_db \
FAKE_DOCKER_ARGS="$backup_args" \
FAKE_RESTORE_CAPTURE="$restore_capture" \
"$preserve_dir/nearzero" backup-db "$backup_path" >/dev/null
[[ "$(file_mode "$backup_path")" == "600" ]] || fail "database backup was not installed with mode 0600"
grep -Fq -- 'pg_dump -U preserved_user preserved_db' "$backup_args" || fail "backup helper did not use the installed Postgres identity"
grep -Fq -- '-- complete atomic dump' "$backup_path" || fail "backup helper did not publish the completed dump"

printf '%s\n' 'existing-backup-must-survive' > "$backup_path"
if PATH="$backup_fake_bin:$PATH" \
	INSTALL_DIR="$preserve_dir" \
	FAKE_DOCKER_ARGS="$backup_args" \
	FAKE_RESTORE_CAPTURE="$restore_capture" \
	FAKE_DOCKER_FAIL=1 \
	"$preserve_dir/nearzero" backup-db "$backup_path" >/dev/null 2>&1; then
	fail "failing database dump was reported as successful"
fi
grep -Fxq 'existing-backup-must-survive' "$backup_path" || fail "failed database dump replaced the last complete backup"
[[ -z "$(find "$TEST_ROOT" -maxdepth 1 -name '.control-plane.sql.tmp.*' -print -quit)" ]] || fail "failed database dump left a partial temporary file"

restore_input="$TEST_ROOT/restore-input.sql"
printf '%s\n' 'verified restore input' > "$restore_input"
: > "$backup_args"
PATH="$backup_fake_bin:$PATH" \
INSTALL_DIR="$preserve_dir" \
POSTGRES_USER=wrong_shell_user \
POSTGRES_DB=wrong_shell_db \
FAKE_DOCKER_ARGS="$backup_args" \
FAKE_RESTORE_CAPTURE="$restore_capture" \
"$preserve_dir/nearzero" restore-db "$restore_input" >/dev/null
grep -Fq -- 'psql -U preserved_user preserved_db' "$backup_args" || fail "restore helper did not use the installed Postgres identity"
grep -Fxq 'verified restore input' "$restore_capture" || fail "restore helper did not stream the selected input file"

split_url_dir="$TEST_ROOT/split-public-urls"
DRY_RUN=1 \
INSTALL_DIR="$split_url_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
CONSOLE_URL=https://console.example.com \
BETTER_AUTH_URL=https://auth.example.com \
PUBLIC_GIT_PROVIDER_BASE_URL=https://git-callbacks.example.com \
PUBLIC_BACKEND_URL=https://api.example.com \
"$ROOT_DIR/scripts/install.sh" >/dev/null
DRY_RUN=1 \
INSTALL_DIR="$split_url_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value CONSOLE_URL "$split_url_dir/.env")" == "https://console.example.com" ]] || fail "plain rerun changed an explicit console URL"
[[ "$(env_value BETTER_AUTH_URL "$split_url_dir/.env")" == "https://auth.example.com" ]] || fail "plain rerun changed an explicit split auth URL"
[[ "$(env_value PUBLIC_GIT_PROVIDER_BASE_URL "$split_url_dir/.env")" == "https://git-callbacks.example.com" ]] || fail "plain rerun changed an explicit split Git callback URL"
[[ "$(env_value PUBLIC_BACKEND_URL "$split_url_dir/.env")" == "https://api.example.com" ]] || fail "plain rerun changed an explicit split backend URL"

legacy_url_dir="$TEST_ROOT/legacy-generated-urls"
DRY_RUN=1 INSTALL_DIR="$legacy_url_dir" NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null
awk -F= '
	$1 == "CONSOLE_URL" || $1 == "BETTER_AUTH_URL" || $1 == "PUBLIC_GIT_PROVIDER_BASE_URL" { print $1 "=http://203.0.113.10:4321"; next }
	$1 == "PUBLIC_BACKEND_URL" { print $1 "=http://203.0.113.10:3000"; next }
	{ print }
' "$legacy_url_dir/.env" > "$legacy_url_dir/.env.old-urls"
mv "$legacy_url_dir/.env.old-urls" "$legacy_url_dir/.env"
DRY_RUN=1 INSTALL_DIR="$legacy_url_dir" NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null
for canonical_key in CONSOLE_URL BETTER_AUTH_URL PUBLIC_GIT_PROVIDER_BASE_URL PUBLIC_BACKEND_URL; do
	[[ "$(env_value "$canonical_key" "$legacy_url_dir/.env")" == "http://127.0.0.1:4321" ]] || fail "legacy generated raw URL was not corrected to the loopback console origin"
done

guided_dir="$TEST_ROOT/guided-domain"
DRY_RUN=1 \
INSTALL_DIR="$guided_dir" \
NEARZERO_PUBLIC_IP=8.8.8.8 \
NEARZERO_MANAGEMENT_HOSTNAME=Nearzero.Apps.Example.COM. \
NEARZERO_MANAGED_DNS_ZONE=Apps.Example.COM. \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value NEARZERO_PUBLIC_IP "$guided_dir/.env")" == "8.8.8.8" ]] || fail "guided public IP was not persisted"
[[ "$(env_value NEARZERO_MANAGEMENT_HOSTNAME "$guided_dir/.env")" == "nearzero.apps.example.com" ]] || fail "management hostname was not normalized"
[[ "$(env_value NEARZERO_MANAGED_DNS_ZONE "$guided_dir/.env")" == "apps.example.com" ]] || fail "managed application zone was not normalized"
[[ "$(env_value NEARZERO_ADMIN_EMAIL "$guided_dir/.env")" == "owner@example.com" ]] || fail "guided admin email was not persisted"
[[ "$(env_value NEARZERO_MANAGED_DNS_SOA_EMAIL "$guided_dir/.env")" == "owner@example.com" ]] || fail "SOA email did not default to the admin email"
[[ "$(env_value NEARZERO_REGISTRATION_MODE "$guided_dir/.env")" == "bootstrap" ]] || fail "guided install did not use bootstrap registration"
[[ "$(env_value CONSOLE_URL "$guided_dir/.env")" == "https://nearzero.apps.example.com" ]] || fail "management hostname did not derive the HTTPS console URL"
[[ "$(env_value BETTER_AUTH_URL "$guided_dir/.env")" == "https://nearzero.apps.example.com" ]] || fail "management hostname did not derive the auth URL"
[[ "$(env_value PUBLIC_GIT_PROVIDER_BASE_URL "$guided_dir/.env")" == "https://nearzero.apps.example.com" ]] || fail "management hostname did not derive the Git callback base"
[[ "$(env_value PUBLIC_BACKEND_URL "$guided_dir/.env")" == "https://nearzero.apps.example.com" ]] || fail "management hostname did not derive the proxied public API origin"
case ",$(env_value NEARZERO_TRUSTED_ORIGINS "$guided_dir/.env")," in
	*,https://nearzero.apps.example.com,*) ;;
	*) fail "management hostname was not added to trusted origins" ;;
esac
guided_env_before="$(sha256sum "$guided_dir/.env" | awk '{print $1}')"
DRY_RUN=1 \
INSTALL_DIR="$guided_dir" \
"$ROOT_DIR/scripts/install.sh" >/dev/null
guided_env_after="$(sha256sum "$guided_dir/.env" | awk '{print $1}')"
[[ "$guided_env_after" == "$guided_env_before" ]] || fail "guided first-run domain settings changed on a plain rerun"
awk -F= '$1 == "PUBLIC_BACKEND_URL" { print "PUBLIC_BACKEND_URL=http://8.8.8.8:3000"; next } { print }' \
	"$guided_dir/.env" > "$guided_dir/.env.old-backend-url"
mv "$guided_dir/.env.old-backend-url" "$guided_dir/.env"
DRY_RUN=1 INSTALL_DIR="$guided_dir" "$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value PUBLIC_BACKEND_URL "$guided_dir/.env")" == "https://nearzero.apps.example.com" ]] || fail "legacy management install did not move its generated backend URL to the console origin"
if DRY_RUN=1 \
	INSTALL_DIR="$guided_dir" \
	NEARZERO_MANAGEMENT_HOSTNAME=renamed.apps.example.com \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "management hostname was changed by an unsupported installer rerun"
fi
if DRY_RUN=1 \
	INSTALL_DIR="$guided_dir" \
	NEARZERO_MANAGED_DNS_ZONE=other.example.com \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "managed DNS zone was changed by an unsupported installer rerun"
fi

management_only_dir="$TEST_ROOT/management-only"
DRY_RUN=1 \
INSTALL_DIR="$management_only_dir" \
NEARZERO_PUBLIC_IP=8.8.4.4 \
NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com \
NEARZERO_ADMIN_EMAIL=tls@example.com \
NEARZERO_REGISTRATION_MODE=open \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value NEARZERO_MANAGED_DNS_SOA_EMAIL "$management_only_dir/.env")" == "tls@example.com" ]] || fail "management-only install did not persist its SOA/ACME contact"
DRY_RUN=1 \
INSTALL_DIR="$management_only_dir" \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value NEARZERO_MANAGED_DNS_SOA_EMAIL "$management_only_dir/.env")" == "tls@example.com" ]] || fail "management-only rerun did not preserve its SOA/ACME contact"

legacy_dir="$TEST_ROOT/legacy-registration"
DRY_RUN=1 \
INSTALL_DIR="$legacy_dir" \
NEARZERO_PUBLIC_IP=203.0.113.55 \
NEARZERO_REGISTRATION_MODE=open \
"$ROOT_DIR/scripts/install.sh" >/dev/null
awk -F= '$1 != "NEARZERO_ADMIN_EMAIL" && $1 != "NEARZERO_REGISTRATION_MODE"' \
	"$legacy_dir/.env" > "$legacy_dir/.env.legacy"
mv "$legacy_dir/.env.legacy" "$legacy_dir/.env"
DRY_RUN=1 \
INSTALL_DIR="$legacy_dir" \
NEARZERO_ADMIN_EMAIL= \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value NEARZERO_REGISTRATION_MODE "$legacy_dir/.env")" == "open" ]] || fail "legacy install without registration settings was unexpectedly locked"
[[ -z "$(env_value NEARZERO_ADMIN_EMAIL "$legacy_dir/.env")" ]] || fail "legacy install invented a bootstrap administrator"

ingress_dir="$TEST_ROOT/ingress"
verified_traefik_image='registry.example.com/traefik@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
verified_proxy_image='registry.example.com/socket-proxy@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
verified_heroku_builder_image='registry.example.com/builders/heroku:24@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
verified_paketo_builder_image='registry.example.com/builders/paketo:jammy@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
verified_railpack_frontend_image='ghcr.io/railwayapp/railpack-frontend:v0.15.4@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
verified_static_nginx_image='docker.io/library/nginx:alpine@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
DRY_RUN=1 \
INSTALL_DIR="$ingress_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
TRAEFIK_IMAGE="$verified_traefik_image" \
TRAEFIK_SOCKET_PROXY_IMAGE="$verified_proxy_image" \
NEARZERO_HEROKU_BUILDER_IMAGE="$verified_heroku_builder_image" \
NEARZERO_PAKETO_BUILDER_IMAGE="$verified_paketo_builder_image" \
NEARZERO_RAILPACK_FRONTEND_IMAGE="$verified_railpack_frontend_image" \
NEARZERO_STATIC_NGINX_IMAGE="$verified_static_nginx_image" \
NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=true \
"$ROOT_DIR/scripts/install.sh" >/dev/null
grep -Fxq "TRAEFIK_IMAGE=$verified_traefik_image" "$ingress_dir/.env" || fail "Traefik digest override was not persisted"
grep -Fxq "TRAEFIK_SOCKET_PROXY_IMAGE=$verified_proxy_image" "$ingress_dir/.env" || fail "socket-proxy digest override was not persisted"
grep -Fxq "NEARZERO_HEROKU_BUILDER_IMAGE=$verified_heroku_builder_image" "$ingress_dir/.env" || fail "Heroku builder digest override was not persisted"
grep -Fxq "NEARZERO_PAKETO_BUILDER_IMAGE=$verified_paketo_builder_image" "$ingress_dir/.env" || fail "Paketo builder digest override was not persisted"
grep -Fxq "NEARZERO_RAILPACK_FRONTEND_IMAGE=$verified_railpack_frontend_image" "$ingress_dir/.env" || fail "Railpack frontend digest override was not persisted"
grep -Fxq "NEARZERO_STATIC_NGINX_IMAGE=$verified_static_nginx_image" "$ingress_dir/.env" || fail "static Nginx digest override was not persisted"
grep -Fxq 'NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=true' "$ingress_dir/.env" || fail "strict SSH host-key mode was not persisted"
DRY_RUN=1 \
INSTALL_DIR="$ingress_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
grep -Fxq "TRAEFIK_IMAGE=$verified_traefik_image" "$ingress_dir/.env" || fail "Traefik digest override changed on rerun"
grep -Fxq "TRAEFIK_SOCKET_PROXY_IMAGE=$verified_proxy_image" "$ingress_dir/.env" || fail "socket-proxy digest override changed on rerun"
grep -Fxq "NEARZERO_HEROKU_BUILDER_IMAGE=$verified_heroku_builder_image" "$ingress_dir/.env" || fail "Heroku builder digest override changed on rerun"
grep -Fxq "NEARZERO_PAKETO_BUILDER_IMAGE=$verified_paketo_builder_image" "$ingress_dir/.env" || fail "Paketo builder digest override changed on rerun"
grep -Fxq "NEARZERO_RAILPACK_FRONTEND_IMAGE=$verified_railpack_frontend_image" "$ingress_dir/.env" || fail "Railpack frontend digest override changed on rerun"
grep -Fxq "NEARZERO_STATIC_NGINX_IMAGE=$verified_static_nginx_image" "$ingress_dir/.env" || fail "static Nginx digest override changed on rerun"
grep -Fxq 'NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=true' "$ingress_dir/.env" || fail "strict SSH host-key mode changed on rerun"

schedules_dir="$TEST_ROOT/schedules"
DRY_RUN=1 \
INSTALL_DIR="$schedules_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
COMPOSE_PROFILES=managed-dns,schedules \
NEARZERO_PLATFORM_DOMAIN=apps.example.com \
NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE=true \
"$ROOT_DIR/scripts/install.sh" >/dev/null
schedules_api_key="$(awk -F= '$1 == "API_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$schedules_dir/.env")"
[[ "$schedules_api_key" =~ ^[a-f0-9]{64}$ ]] || fail "schedules profile did not generate a strong API key"
grep -Fxq 'JOBS_URL=http://schedules:4001' "$schedules_dir/.env" || fail "schedules profile did not configure JOBS_URL"
grep -Fxq 'NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE=true' "$schedules_dir/.env" || fail "shared-edge routing flag was not persisted"
DRY_RUN=1 \
INSTALL_DIR="$schedules_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
grep -Fxq "API_KEY=$schedules_api_key" "$schedules_dir/.env" || fail "schedules API key changed on rerun"
grep -Fxq 'JOBS_URL=http://schedules:4001' "$schedules_dir/.env" || fail "schedules JOBS_URL changed on rerun"
grep -Fxq 'NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE=true' "$schedules_dir/.env" || fail "shared-edge routing flag changed on rerun"

DRY_RUN=1 \
INSTALL_DIR="$INSTALL_DIR" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
NEARZERO_DNS_BIND_ADDRESS=127.0.0.1 \
NEARZERO_DNS_PORT=1053 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
run_installer
[[ "$(env_value NEARZERO_DNS_BIND_ADDRESS)" == "127.0.0.1" ]] || fail "DNS bind address was not preserved on rerun"
[[ "$(env_value NEARZERO_DNS_PORT)" == "1053" ]] || fail "DNS port was not preserved on rerun"

DRY_RUN=1 \
INSTALL_DIR="$INSTALL_DIR" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
NEARZERO_MANAGEMENT_BIND_ADDRESS=0.0.0.0 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
run_installer
[[ "$(env_value NEARZERO_MANAGEMENT_BIND_ADDRESS)" == "0.0.0.0" ]] || fail "explicit management bind override was not preserved on rerun"

DRY_RUN=1 \
INSTALL_DIR="$INSTALL_DIR" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
NEARZERO_ENABLE_MANAGED_DNS=false \
"$ROOT_DIR/scripts/install.sh" >/dev/null
case ",$(env_value COMPOSE_PROFILES)," in
	*,managed-dns,*) fail "managed-dns profile remained active after opt-out" ;;
	*) ;;
esac
disabled_services="$(docker compose -f "$INSTALL_DIR/docker-compose.prod.yml" --env-file "$INSTALL_DIR/.env" config --services)"
case "$disabled_services" in
	*dns*) fail "managed DNS service remained active after opt-out" ;;
	*) ;;
esac
run_installer
[[ "$(env_value NEARZERO_ENABLE_MANAGED_DNS)" == "false" ]] || fail "managed-DNS opt-out was not preserved on rerun"
case ",$(env_value COMPOSE_PROFILES)," in
	*,managed-dns,*) fail "managed-dns profile was re-enabled on rerun" ;;
	*) ;;
esac

invalid_dir="$TEST_ROOT/invalid"
wizard_dir="$TEST_ROOT/browser-setup"
DRY_RUN=1 \
	INSTALL_DIR="$wizard_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_ADMIN_EMAIL= \
	NEARZERO_MANAGEMENT_HOSTNAME= \
	NEARZERO_MANAGED_DNS_ZONE= \
	NEARZERO_REGISTRATION_MODE=bootstrap \
	"$ROOT_DIR/scripts/install.sh" >/dev/null || fail "browser-deferred bootstrap setup was rejected"
[[ "$(env_value NEARZERO_INSTALL_SETUP_TOKEN_HASH "$wizard_dir/.env")" =~ ^[a-f0-9]{64}$ ]] ||
	fail "browser setup token hash was not persisted"
[[ -z "$(env_value NEARZERO_ADMIN_EMAIL "$wizard_dir/.env")" ]] ||
	fail "browser-deferred setup should leave admin email empty for the wizard"
[[ -z "$(env_value NEARZERO_MANAGEMENT_HOSTNAME "$wizard_dir/.env")" ]] ||
	fail "browser-deferred setup should leave management hostname empty for the wizard"

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_ADMIN_EMAIL= \
	NEARZERO_INSTALL_SETUP_TOKEN_HASH=not-a-hash \
	NEARZERO_REGISTRATION_MODE=bootstrap \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid install setup token hash was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_REGISTRATION_MODE=unknown \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid registration mode was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$TEST_ROOT/fresh-invite-only" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_ADMIN_EMAIL= \
	NEARZERO_REGISTRATION_MODE=invite_only \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invite-only registration was accepted with a fresh local database"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$TEST_ROOT/management-without-contact" \
	NEARZERO_PUBLIC_IP=8.8.8.8 \
	NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com \
	NEARZERO_ADMIN_EMAIL= \
	NEARZERO_MANAGED_DNS_SOA_EMAIL= \
	NEARZERO_REGISTRATION_MODE=open \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "public management hostname without an SOA/ACME contact was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$TEST_ROOT/management-private-ip" \
	NEARZERO_PUBLIC_IP=10.0.0.10 \
	NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com \
	NEARZERO_ADMIN_EMAIL=owner@example.com \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "private IPv4 address was accepted for a public management hostname"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$TEST_ROOT/zone-documentation-ip" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_MANAGED_DNS_ZONE=apps.example.com \
	NEARZERO_ADMIN_EMAIL=owner@example.com \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "documentation IPv4 range was accepted for managed authoritative DNS"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_MANAGED_DNS_ZONE=apps.example.com \
	NEARZERO_ENABLE_MANAGED_DNS=false \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "managed application zone was accepted while managed DNS was disabled"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_MANAGEMENT_HOSTNAME=https://nearzero.example.com \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "URL syntax was accepted as a management hostname"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=999.0.0.1 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid public IP was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_MANAGEMENT_BIND_ADDRESS=not-an-ip \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid management bind address was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_PLATFORM_DOMAIN=https://example.com \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid platform domain was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_ENABLE_MANAGED_DNS=maybe \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid managed-DNS boolean was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_ALLOW_MONITORING_DOCKER_METADATA=maybe \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid monitoring Docker metadata boolean was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=maybe \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid strict SSH host-key boolean was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	TRAEFIK_IMAGE='traefik:3.6.17;touch-/tmp/pwned' \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "shell syntax in the Traefik image reference was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_HEROKU_BUILDER_IMAGE='heroku/builder:24' \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "mutable Heroku builder override was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_PAKETO_BUILDER_IMAGE='paketobuildpacks/builder-jammy-full;touch-/tmp/pwned' \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "unsafe Paketo builder override was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_RAILPACK_FRONTEND_IMAGE='ghcr.io/railwayapp/railpack-frontend:v0.15.4' \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "mutable Railpack frontend override was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_STATIC_NGINX_IMAGE='nginx:alpine' \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "mutable static Nginx override was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_DNS_BIND_ADDRESS=999.0.0.1 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid DNS bind address was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_PLATFORM_PORT='3000:unexpected' \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "invalid platform port was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_DATA_MODE=external \
	DATABASE_URL='postgresql://user:unsafe$password@example.invalid:5432/nearzero' \
	REDIS_URL=redis://example.invalid:6379 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "dotenv interpolation characters in external credentials were accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_METRICS_CRON='0 " * * *' \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "unsafe quoted metrics cron was accepted"
fi

if DRY_RUN=1 \
	INSTALL_DIR="$invalid_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_DATA_MODE=external \
	DATABASE_URL=postgresql://example.invalid/nearzero \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "partial external-service input was accepted"
fi

external_dir="$TEST_ROOT/external"
external_db_url='postgresql://user:external-db-marker@example.invalid:5432/nearzero'
external_redis_url='rediss://user:external-redis-marker@example.invalid:6379'
if ! external_output="$(
	DRY_RUN=1 \
	INSTALL_DIR="$external_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_DATA_MODE=external \
	DATABASE_URL="$external_db_url" \
	REDIS_URL="$external_redis_url" \
	"$ROOT_DIR/scripts/install.sh" 2>&1
)"; then
	fail "fresh external-service install failed"
fi
if [[ "$external_output" == *external-db-marker* || "$external_output" == *external-redis-marker* ]]; then
	fail "external-service credentials were printed by the installer"
fi
[[ "$(env_value NEARZERO_DATA_MODE "$external_dir/.env")" == "external" ]] || fail "external data mode was not persisted"
[[ ! -e "$external_dir/docker-compose.local-db.yml" ]] || fail "external-service mode generated a local database Compose file"
external_database_before="$(env_value DATABASE_URL "$external_dir/.env")"
external_redis_before="$(env_value REDIS_URL "$external_dir/.env")"

# A plain rerun must preserve the external mode and both stored URLs. Even if a
# stale local overlay is present from an older bug or manual copy, the installer
# must remove it instead of silently starting bundled services.
cp "$ROOT_DIR/docker-compose.local-db.yml" "$external_dir/docker-compose.local-db.yml"
if ! external_rerun_output="$(
	DRY_RUN=1 \
	INSTALL_DIR="$external_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" 2>&1
)"; then
	fail "plain external-service rerun failed"
fi
if [[ "$external_rerun_output" == *external-db-marker* || "$external_rerun_output" == *external-redis-marker* ]]; then
	fail "stored external-service credentials were printed on rerun"
fi
[[ "$(env_value NEARZERO_DATA_MODE "$external_dir/.env")" == "external" ]] || fail "plain rerun changed external data mode"
[[ "$(env_value DATABASE_URL "$external_dir/.env")" == "$external_database_before" ]] || fail "plain rerun changed the external database URL"
[[ "$(env_value REDIS_URL "$external_dir/.env")" == "$external_redis_before" ]] || fail "plain rerun changed the external Redis URL"
[[ ! -e "$external_dir/docker-compose.local-db.yml" ]] || fail "plain external rerun retained a stale local overlay"

# The generated helper must trust the persisted mode, not merely overlay-file
# existence. Recreate a stale overlay and observe the Compose arguments through
# a non-secret fake Docker executable.
cp "$ROOT_DIR/docker-compose.local-db.yml" "$external_dir/docker-compose.local-db.yml"
fake_bin="$TEST_ROOT/fake-bin"
mkdir -p "$fake_bin"
printf '#!/usr/bin/env sh\nprintf "%%s\\n" "$*"\n' > "$fake_bin/docker"
chmod 0755 "$fake_bin/docker"
helper_args="$(PATH="$fake_bin:$PATH" INSTALL_DIR="$external_dir" "$external_dir/nearzero" status)"
if [[ "$helper_args" == *docker-compose.local-db.yml* ]]; then
	fail "operations helper resurrected a stale local overlay in external mode"
fi
rm -f "$external_dir/docker-compose.local-db.yml"

# Both transitions require an explicit mode. Local -> external additionally
# requires a complete fresh pair; external -> local replaces both stored URLs
# with internal service addresses and recreates the overlay.
transition_dir="$TEST_ROOT/data-mode-transition"
DRY_RUN=1 \
INSTALL_DIR="$transition_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
if DRY_RUN=1 \
	INSTALL_DIR="$transition_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	DATABASE_URL="$external_db_url" \
	REDIS_URL="$external_redis_url" \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "implicit local-to-external transition was accepted"
fi
if ! transition_output="$(
	DRY_RUN=1 \
	INSTALL_DIR="$transition_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	NEARZERO_DATA_MODE=external \
	DATABASE_URL="$external_db_url" \
	REDIS_URL="$external_redis_url" \
	"$ROOT_DIR/scripts/install.sh" 2>&1
)"; then
	fail "explicit local-to-external transition failed"
fi
if [[ "$transition_output" == *external-db-marker* || "$transition_output" == *external-redis-marker* ]]; then
	fail "external-service credentials were printed during a mode transition"
fi
[[ "$(env_value NEARZERO_DATA_MODE "$transition_dir/.env")" == "external" ]] || fail "local-to-external transition did not persist its mode"
[[ ! -e "$transition_dir/docker-compose.local-db.yml" ]] || fail "local-to-external transition retained the local overlay"

DRY_RUN=1 \
INSTALL_DIR="$transition_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
NEARZERO_DATA_MODE=local \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value NEARZERO_DATA_MODE "$transition_dir/.env")" == "local" ]] || fail "external-to-local transition did not persist its mode"
[[ -e "$transition_dir/docker-compose.local-db.yml" ]] || fail "external-to-local transition did not recreate the local overlay"
if grep -Fq 'external-db-marker' "$transition_dir/.env" || grep -Fq 'external-redis-marker' "$transition_dir/.env"; then
	fail "external-to-local transition retained external service credentials"
fi

# Legacy installs without the persisted marker are inferred only when their
# generated URLs and overlay agree. A stale overlay combined with external URLs
# is deliberately ambiguous and requires the operator to select a mode.
legacy_local_data_dir="$TEST_ROOT/legacy-local-data"
DRY_RUN=1 \
INSTALL_DIR="$legacy_local_data_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
awk -F= '$1 != "NEARZERO_DATA_MODE"' "$legacy_local_data_dir/.env" > "$legacy_local_data_dir/.env.legacy"
mv "$legacy_local_data_dir/.env.legacy" "$legacy_local_data_dir/.env"
DRY_RUN=1 \
INSTALL_DIR="$legacy_local_data_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value NEARZERO_DATA_MODE "$legacy_local_data_dir/.env")" == "local" ]] || fail "unambiguous legacy local mode was not inferred"

legacy_ambiguous_data_dir="$TEST_ROOT/legacy-ambiguous-data"
DRY_RUN=1 \
INSTALL_DIR="$legacy_ambiguous_data_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
NEARZERO_DATA_MODE=external \
DATABASE_URL="$external_db_url" \
REDIS_URL="$external_redis_url" \
"$ROOT_DIR/scripts/install.sh" >/dev/null
awk -F= '$1 != "NEARZERO_DATA_MODE"' "$legacy_ambiguous_data_dir/.env" > "$legacy_ambiguous_data_dir/.env.legacy"
mv "$legacy_ambiguous_data_dir/.env.legacy" "$legacy_ambiguous_data_dir/.env"
cp "$ROOT_DIR/docker-compose.local-db.yml" "$legacy_ambiguous_data_dir/docker-compose.local-db.yml"
if DRY_RUN=1 \
	INSTALL_DIR="$legacy_ambiguous_data_dir" \
	NEARZERO_PUBLIC_IP=203.0.113.10 \
	"$ROOT_DIR/scripts/install.sh" >/dev/null 2>&1; then
	fail "ambiguous legacy data mode was guessed from a stale overlay"
fi
DRY_RUN=1 \
INSTALL_DIR="$legacy_ambiguous_data_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
NEARZERO_DATA_MODE=external \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ "$(env_value NEARZERO_DATA_MODE "$legacy_ambiguous_data_dir/.env")" == "external" ]] || fail "explicit legacy external mode was not persisted"
[[ ! -e "$legacy_ambiguous_data_dir/docker-compose.local-db.yml" ]] || fail "explicit legacy external selection retained a stale overlay"

docker compose \
	-f "$external_dir/docker-compose.prod.yml" \
	--env-file "$external_dir/.env" \
	config --quiet

docker compose \
	-f "$INSTALL_DIR/docker-compose.prod.yml" \
	-f "$INSTALL_DIR/docker-compose.local-db.yml" \
	--env-file "$INSTALL_DIR/.env" \
	config --quiet

printf 'OSS installer verification passed.\n'
