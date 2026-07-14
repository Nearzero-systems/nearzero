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
	awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$INSTALL_DIR/.env"
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
[[ "$(env_value NEARZERO_PLATFORM_DOMAIN)" == "example.com" ]] || fail "platform domain was not normalized"
[[ "$(env_value NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE)" == "false" ]] || fail "shared-edge routing must default to false"
[[ "$(env_value NEARZERO_ALLOW_MONITORING_DOCKER_METADATA)" == "false" ]] || fail "Docker metadata monitoring must default to false"
[[ "$(env_value NEARZERO_SSH_STRICT_HOST_KEY_CHECKING)" == "false" ]] || fail "SSH strict host-key mode must default to false until the trust store is seeded"
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
grep -Fq 'directory /etc/coredns/zones (.*)\.zone {1}' "$INSTALL_DIR/docker-compose.prod.yml" || fail "CoreDNS zone filename matcher is missing"
grep -Fq 'reload 2s' "$INSTALL_DIR/docker-compose.prod.yml" || fail "CoreDNS zone reload interval is missing"
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
	EXTERNAL_SERVICES=1 \
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

external_dir="$TEST_ROOT/external"
DRY_RUN=1 \
INSTALL_DIR="$external_dir" \
NEARZERO_PUBLIC_IP=203.0.113.10 \
EXTERNAL_SERVICES=1 \
DATABASE_URL=postgresql://user:test%24encoded@example.invalid:5432/nearzero \
REDIS_URL=redis://user:test%23encoded@example.invalid:6379 \
"$ROOT_DIR/scripts/install.sh" >/dev/null
[[ ! -e "$external_dir/docker-compose.local-db.yml" ]] || fail "external-service mode generated a local database Compose file"
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
