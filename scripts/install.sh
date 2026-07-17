#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR_INPUT="${INSTALL_DIR:-}"
if [[ "${DRY_RUN:-}" == "1" && -z "$INSTALL_DIR_INPUT" ]]; then
	INSTALL_DIR="/tmp/nearzero-dry-run"
else
	INSTALL_DIR="${INSTALL_DIR_INPUT:-/opt/nearzero}"
fi

NEARZERO_IMAGE="${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.39}"
NEARZERO_MONITORING_IMAGE="${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:0.1.39}"
NEARZERO_SCHEDULE_IMAGE="${NEARZERO_SCHEDULE_IMAGE:-ghcr.io/nearzero-systems/schedule:0.1.39}"
NEARZERO_DNS_IMAGE="${NEARZERO_DNS_IMAGE:-coredns/coredns:1.14.6}"
if [[ "${NEARZERO_HEROKU_BUILDER_IMAGE+x}" == "x" ]]; then
	NEARZERO_HEROKU_BUILDER_IMAGE_WAS_SET=1
else
	NEARZERO_HEROKU_BUILDER_IMAGE_WAS_SET=0
fi
NEARZERO_HEROKU_BUILDER_IMAGE="${NEARZERO_HEROKU_BUILDER_IMAGE:-}"
if [[ "${NEARZERO_PAKETO_BUILDER_IMAGE+x}" == "x" ]]; then
	NEARZERO_PAKETO_BUILDER_IMAGE_WAS_SET=1
else
	NEARZERO_PAKETO_BUILDER_IMAGE_WAS_SET=0
fi
NEARZERO_PAKETO_BUILDER_IMAGE="${NEARZERO_PAKETO_BUILDER_IMAGE:-}"
if [[ "${NEARZERO_RAILPACK_FRONTEND_IMAGE+x}" == "x" ]]; then
	NEARZERO_RAILPACK_FRONTEND_IMAGE_WAS_SET=1
else
	NEARZERO_RAILPACK_FRONTEND_IMAGE_WAS_SET=0
fi
NEARZERO_RAILPACK_FRONTEND_IMAGE="${NEARZERO_RAILPACK_FRONTEND_IMAGE:-}"
if [[ "${NEARZERO_STATIC_NGINX_IMAGE+x}" == "x" ]]; then
	NEARZERO_STATIC_NGINX_IMAGE_WAS_SET=1
else
	NEARZERO_STATIC_NGINX_IMAGE_WAS_SET=0
fi
NEARZERO_STATIC_NGINX_IMAGE="${NEARZERO_STATIC_NGINX_IMAGE:-}"
if [[ "${TRAEFIK_IMAGE+x}" == "x" ]]; then
	TRAEFIK_IMAGE_WAS_SET=1
else
	TRAEFIK_IMAGE_WAS_SET=0
fi
TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-}"
if [[ "${TRAEFIK_SOCKET_PROXY_IMAGE+x}" == "x" ]]; then
	TRAEFIK_SOCKET_PROXY_IMAGE_WAS_SET=1
else
	TRAEFIK_SOCKET_PROXY_IMAGE_WAS_SET=0
fi
TRAEFIK_SOCKET_PROXY_IMAGE="${TRAEFIK_SOCKET_PROXY_IMAGE:-}"
if [[ "${NEARZERO_SSH_STRICT_HOST_KEY_CHECKING+x}" == "x" ]]; then
	NEARZERO_SSH_STRICT_HOST_KEY_CHECKING_WAS_SET=1
else
	NEARZERO_SSH_STRICT_HOST_KEY_CHECKING_WAS_SET=0
fi
NEARZERO_SSH_STRICT_HOST_KEY_CHECKING="${NEARZERO_SSH_STRICT_HOST_KEY_CHECKING:-false}"
DOCKER_COMPOSE_BOOTSTRAP_VERSION="5.1.4"
if [[ "${NEARZERO_ENABLE_MANAGED_DNS+x}" == "x" ]]; then
	NEARZERO_ENABLE_MANAGED_DNS_WAS_SET=1
else
	NEARZERO_ENABLE_MANAGED_DNS_WAS_SET=0
fi
NEARZERO_ENABLE_MANAGED_DNS="${NEARZERO_ENABLE_MANAGED_DNS:-true}"
if [[ "${NEARZERO_DNS_BIND_ADDRESS+x}" == "x" ]]; then
	NEARZERO_DNS_BIND_ADDRESS_WAS_SET=1
else
	NEARZERO_DNS_BIND_ADDRESS_WAS_SET=0
fi
NEARZERO_DNS_BIND_ADDRESS="${NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}"
if [[ "${NEARZERO_DNS_PORT+x}" == "x" ]]; then
	NEARZERO_DNS_PORT_WAS_SET=1
else
	NEARZERO_DNS_PORT_WAS_SET=0
fi
NEARZERO_DNS_PORT="${NEARZERO_DNS_PORT:-53}"
if [[ "${NEARZERO_PLATFORM_DOMAIN+x}" == "x" ]]; then
	NEARZERO_PLATFORM_DOMAIN_WAS_SET=1
else
	NEARZERO_PLATFORM_DOMAIN_WAS_SET=0
fi
NEARZERO_PLATFORM_DOMAIN="${NEARZERO_PLATFORM_DOMAIN:-}"
if [[ "${NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE+x}" == "x" ]]; then
	NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE_WAS_SET=1
else
	NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE_WAS_SET=0
fi
NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE="${NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE:-false}"
NEARZERO_PLATFORM_PORT="${NEARZERO_PLATFORM_PORT:-3000}"
NEARZERO_CONSOLE_PORT="${NEARZERO_CONSOLE_PORT:-4321}"
NEARZERO_METRICS_PORT="${NEARZERO_METRICS_PORT:-4500}"
NEARZERO_METRICS_REFRESH_SECONDS="${NEARZERO_METRICS_REFRESH_SECONDS:-5}"
NEARZERO_METRICS_RETENTION_DAYS="${NEARZERO_METRICS_RETENTION_DAYS:-2}"
NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON:-0 0 * * *}"
NEARZERO_METRICS_TOKEN="${NEARZERO_METRICS_TOKEN:-}"
if [[ "${NEARZERO_ALLOW_MONITORING_DOCKER_METADATA+x}" == "x" ]]; then
	NEARZERO_ALLOW_MONITORING_DOCKER_METADATA_WAS_SET=1
else
	NEARZERO_ALLOW_MONITORING_DOCKER_METADATA_WAS_SET=0
fi
NEARZERO_ALLOW_MONITORING_DOCKER_METADATA="${NEARZERO_ALLOW_MONITORING_DOCKER_METADATA:-false}"
POSTGRES_USER="${POSTGRES_USER:-nearzero}"
POSTGRES_DB="${POSTGRES_DB:-nearzero}"
REDIS_URL="${REDIS_URL:-}"
DATABASE_URL="${DATABASE_URL:-}"
JOBS_URL="${JOBS_URL:-}"
API_KEY="${API_KEY:-}"
SKIP_DOCKER_INSTALL="${SKIP_DOCKER_INSTALL:-}"
DRY_RUN="${DRY_RUN:-}"
USE_LOCAL_SERVICES=1
if [[ -n "$DATABASE_URL" && -n "$REDIS_URL" ]]; then
	USE_LOCAL_SERVICES=0
fi
if [[ "${EXTERNAL_SERVICES:-}" == "1" || "${EXTERNAL_SERVICES:-}" == "true" ]]; then
	USE_LOCAL_SERVICES=0
fi

if [[ "$(id -u)" == "0" ]]; then
	SUDO=()
else
	SUDO=(sudo)
fi

log() {
	printf 'nearzero: %s\n' "$*"
}

die() {
	printf 'nearzero: %s\n' "$*" >&2
	exit 1
}

run() {
	log "+ $*"
	if [[ "$DRY_RUN" != "1" ]]; then
		"$@"
	fi
}

run_sudo() {
	log "+ ${SUDO[*]} $*"
	if [[ "$DRY_RUN" != "1" ]]; then
		"${SUDO[@]}" "$@"
	fi
}

write_file() {
	local path="$1"
	local tmp
	tmp="$(mktemp)"
	cat > "$tmp"
	if [[ "$DRY_RUN" == "1" ]]; then
		mkdir -p "$(dirname "$path")"
		mv "$tmp" "$path"
		return
	fi
	"${SUDO[@]}" mkdir -p "$(dirname "$path")"
	"${SUDO[@]}" mv "$tmp" "$path"
}

chmod_file() {
	local mode="$1"
	local path="$2"
	if [[ "$DRY_RUN" == "1" ]]; then
		chmod "$mode" "$path"
		return
	fi
	"${SUDO[@]}" chmod "$mode" "$path"
}

rand_hex() {
	local bytes="$1"
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex "$bytes"
	else
		tr -dc 'a-f0-9' < /dev/urandom | head -c "$((bytes * 2))"
	fi
}

existing_env_value() {
	local key="$1"
	local env_file="$INSTALL_DIR/.env"
	[[ -r "$env_file" ]] || return 0
	awk -F= -v key="$key" '
		$1 == key {
			sub(/^[^=]*=/, "")
			print
			exit
		}
	' "$env_file"
}

detect_private_ip() {
	if command -v hostname >/dev/null 2>&1; then
		hostname -I 2>/dev/null | awk '{print $1}' || true
	fi
}

detect_public_ip() {
	if [[ -n "${NEARZERO_PUBLIC_IP:-}" ]]; then
		printf '%s' "$NEARZERO_PUBLIC_IP"
		return
	fi

	local ip=""
	ip="$(curl -fsS --max-time 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
	if [[ -n "$ip" ]]; then
		printf '%s' "$ip"
		return
	fi

	for endpoint in "https://api.ipify.org" "https://ifconfig.me/ip"; do
		ip="$(curl -fsS --max-time 3 "$endpoint" 2>/dev/null | tr -d '[:space:]' || true)"
		if [[ -n "$ip" ]]; then
			printf '%s' "$ip"
			return
		fi
	done
}

detect_host() {
	if [[ -n "${NEARZERO_DOMAIN:-}" ]]; then
		printf '%s' "$NEARZERO_DOMAIN"
		return
	fi

	local public_ip private_ip
	public_ip="$(detect_public_ip)"
	if [[ -n "$public_ip" ]]; then
		printf '%s' "$public_ip"
		return
	fi

	private_ip="$(detect_private_ip)"
	if [[ -n "$private_ip" ]]; then
		printf '%s' "$private_ip"
		return
	fi

	printf '%s' "127.0.0.1"
}

append_origin_if_new() {
	local list="$1"
	local origin="$2"
	if [[ -z "$origin" ]]; then
		printf '%s' "$list"
		return
	fi
	case ",$list," in
	*,"$origin",*) printf '%s' "$list" ;;
	*)
		if [[ -n "$list" ]]; then
			printf '%s,%s' "$list" "$origin"
		else
			printf '%s' "$origin"
		fi
		;;
	esac
}

remove_csv_value() {
	local list="$1"
	local remove="$2"
	local result=""
	local item
	local items=()
	if [[ -z "$list" ]]; then
		return
	fi
	IFS=',' read -r -a items <<< "$list"
	for item in "${items[@]}"; do
		item="${item//[[:space:]]/}"
		if [[ -n "$item" && "$item" != "$remove" ]]; then
			result="$(append_origin_if_new "$result" "$item")"
		fi
	done
	printf '%s' "$result"
}

is_enabled() {
	local normalized
	normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
	case "$normalized" in
	1 | true | yes | on) return 0 ;;
	*) return 1 ;;
	esac
}

validate_boolean() {
	local name="$1"
	local value="$2"
	local normalized
	normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
	case "$normalized" in
	1 | true | yes | on | 0 | false | no | off) ;;
	*) die "$name must be true or false" ;;
	esac
}

csv_contains() {
	local list="${1//[[:space:]]/}"
	local expected="$2"
	case ",$list," in
	*,"$expected",*) return 0 ;;
	*) return 1 ;;
	esac
}

validate_single_line_value() {
	local name="$1"
	local value="$2"
	if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
		die "$name must not contain line breaks"
	fi
}

validate_dotenv_unquoted_value() {
	local name="$1"
	local value="$2"
	validate_single_line_value "$name" "$value"
	# The installer intentionally writes a simple KEY=value file so reruns can
	# preserve existing values without evaluating a shell or a dotenv parser.
	# Reject characters that Compose would treat as quoting, interpolation, a
	# comment, or whitespace. URI credentials containing these characters must be
	# percent-encoded (for example, '$' as '%24').
	if [[ "$value" =~ [[:space:]\"\'\#\$\\] ]]; then
		die "$name contains a character that is unsafe in the installer environment file; percent-encode URI credentials and avoid whitespace, quotes, #, $, and backslashes"
	fi
}

validate_dotenv_quoted_value() {
	local name="$1"
	local value="$2"
	validate_single_line_value "$name" "$value"
	if [[ "$value" == *'"'* || "$value" == *'$'* || "$value" == *'\'* ]]; then
		die "$name contains a character that is unsafe in a quoted installer environment value"
	fi
}

validate_port() {
	local name="$1"
	local value="$2"
	if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < 1 || 10#$value > 65535 )); then
		die "$name must be between 1 and 65535"
	fi
}

validate_positive_integer() {
	local name="$1"
	local value="$2"
	if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < 1 )); then
		die "$name must be a positive integer"
	fi
}

validate_docker_image_reference() {
	local name="$1"
	local value="$2"
	[[ -z "$value" ]] && return 0
	validate_dotenv_unquoted_value "$name" "$value"
	if (( ${#value} > 512 )) || [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._+:/@-]*$ ]]; then
		die "$name contains unsupported Docker image-reference characters"
	fi
}

validate_immutable_builder_image_reference() {
	local name="$1"
	local value="$2"
	[[ -z "$value" ]] && return 0
	validate_single_line_value "$name" "$value"
	if (( ${#value} > 512 )) ||
		[[ ! "$value" =~ ^([a-z0-9]+([._-][a-z0-9]+)*(:[0-9]{1,5})?/)?([a-z0-9]+([._-][a-z0-9]+)*/)*[a-z0-9]+([._-][a-z0-9]+)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$ ]]; then
		die "$name must be a complete OCI image reference pinned by sha256 digest"
	fi
}

normalize_platform_domain() {
	local domain
	domain="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
	domain="${domain%.}"
	if [[ -z "$domain" ]]; then
		return
	fi
	if (( ${#domain} > 253 )) || [[ ! "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
		die "NEARZERO_PLATFORM_DOMAIN must be a DNS name without a scheme, path, wildcard, or port"
	fi
	printf '%s' "$domain"
}

validate_dns_listener() {
	if [[ ! "$NEARZERO_DNS_PORT" =~ ^[0-9]+$ ]] || (( NEARZERO_DNS_PORT < 1 || NEARZERO_DNS_PORT > 65535 )); then
		die "NEARZERO_DNS_PORT must be between 1 and 65535"
	fi
	if [[ ! "$NEARZERO_DNS_BIND_ADDRESS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
		die "NEARZERO_DNS_BIND_ADDRESS must be an IPv4 address such as 0.0.0.0"
	fi
	local octet
	local octets=()
	IFS='.' read -r -a octets <<< "$NEARZERO_DNS_BIND_ADDRESS"
	for octet in "${octets[@]}"; do
		if (( 10#$octet > 255 )); then
			die "NEARZERO_DNS_BIND_ADDRESS contains an invalid IPv4 octet"
		fi
	done
}

collect_trusted_origins() {
	local primary_host="$1"
	local private_ip="$2"
	local origins=""

	origins="$(append_origin_if_new "$origins" "$(url_from_host "$primary_host" "$NEARZERO_CONSOLE_PORT")")"
	origins="$(append_origin_if_new "$origins" "$(url_from_host "$primary_host" "$NEARZERO_PLATFORM_PORT")")"

	if [[ -n "$private_ip" && "$private_ip" != "$primary_host" ]]; then
		origins="$(append_origin_if_new "$origins" "$(url_from_host "$private_ip" "$NEARZERO_CONSOLE_PORT")")"
		origins="$(append_origin_if_new "$origins" "$(url_from_host "$private_ip" "$NEARZERO_PLATFORM_PORT")")"
	fi

	origins="$(append_origin_if_new "$origins" "http://127.0.0.1:${NEARZERO_CONSOLE_PORT}")"
	origins="$(append_origin_if_new "$origins" "http://127.0.0.1:${NEARZERO_PLATFORM_PORT}")"
	origins="$(append_origin_if_new "$origins" "http://localhost:${NEARZERO_CONSOLE_PORT}")"
	origins="$(append_origin_if_new "$origins" "http://localhost:${NEARZERO_PLATFORM_PORT}")"

	printf '%s' "$origins"
}

url_from_host() {
	local host="$1"
	local port="$2"
	if [[ "$host" == http://* || "$host" == https://* ]]; then
		printf '%s' "${host%/}"
	elif [[ -n "$host" ]]; then
		printf 'http://%s:%s' "$host" "$port"
	else
		printf 'http://localhost:%s' "$port"
	fi
}

print_banner() {
	cat <<'EOF'

 _   _                                   
| \ | | ___  __ _ _ __ _______ _ __ ___  
|  \| |/ _ \/ _` | '__|_  / _ \ '__/ _ \ 
| |\  |  __/ (_| | |   / /  __/ | | (_) |
|_| \_|\___|\__,_|_|  /___\___|_|  \___/ 

Self-hosted Platform as a Service · Community Edition

EOF
}

announce_install() {
	log "Installing Nearzero into $INSTALL_DIR"
}

ensure_sudo() {
	if [[ "$(id -u)" != "0" && ${#SUDO[@]} -gt 0 ]] && ! command -v sudo >/dev/null 2>&1; then
		die "sudo is required when not running as root"
	fi
}

ensure_docker() {
	if [[ "$DRY_RUN" == "1" ]]; then
		return
	fi
	if command -v docker >/dev/null 2>&1; then
		return
	fi
	if [[ "$SKIP_DOCKER_INSTALL" == "1" || "$SKIP_DOCKER_INSTALL" == "true" ]]; then
		die "Docker is not installed and SKIP_DOCKER_INSTALL is set"
	fi
	[[ -r /etc/os-release ]] || die "Docker is not installed. Install it from https://docs.docker.com/engine/install/ and rerun Nearzero."
	# shellcheck disable=SC1091
	source /etc/os-release
	local os_id="${ID:-}"
	local os_like=" ${ID_LIKE:-} "

	log "Installing Docker from a signed package repository"
	case "$os_id" in
		ubuntu | debian | raspbian)
			command -v apt-get >/dev/null 2>&1 || die "apt-get is required to install Docker on $os_id"
			run_sudo apt-get update
			run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl docker.io
			;;
		alpine)
			run_sudo apk add --no-cache ca-certificates curl docker
			;;
		arch | manjaro)
			run_sudo pacman -Sy --noconfirm --needed ca-certificates curl docker
			;;
		amzn)
			run_sudo dnf install -y ca-certificates curl docker
			;;
		fedora | centos | rhel | rocky | almalinux | ol)
			command -v dnf >/dev/null 2>&1 || die "dnf is required to install Docker on $os_id"
			local docker_repo_os="centos"
			[[ "$os_id" == "fedora" ]] && docker_repo_os="fedora"
			if command -v dnf5 >/dev/null 2>&1; then
				run_sudo dnf install -y ca-certificates curl dnf5-plugins
				run_sudo dnf config-manager addrepo \
					--from-repofile="https://download.docker.com/linux/${docker_repo_os}/docker-ce.repo" \
					--overwrite
			else
				run_sudo dnf install -y ca-certificates curl dnf-plugins-core
				run_sudo dnf config-manager --add-repo \
					"https://download.docker.com/linux/${docker_repo_os}/docker-ce.repo"
			fi
			run_sudo dnf install -y docker-ce docker-ce-cli containerd.io
			;;
		sles | opensuse-leap | opensuse-tumbleweed)
			run_sudo zypper --non-interactive refresh
			run_sudo zypper --non-interactive install ca-certificates curl docker
			;;
		*)
			if [[ "$os_like" == *" debian "* ]]; then
				run_sudo apt-get update
				run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl docker.io
			elif [[ "$os_like" == *" rhel "* || "$os_like" == *" fedora "* ]]; then
				die "Docker is not installed on $os_id. Install it from a signed package repository, then rerun Nearzero."
			else
				die "Docker is not installed on unsupported distribution $os_id. Install it from https://docs.docker.com/engine/install/ and rerun Nearzero."
			fi
			;;
	esac

	command -v docker >/dev/null 2>&1 || die "Docker installation from the signed package repository failed"
	if command -v systemctl >/dev/null 2>&1; then
		run_sudo systemctl enable --now docker
	elif command -v rc-update >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1; then
		run_sudo rc-update add docker default
		run_sudo rc-service docker start
	elif command -v service >/dev/null 2>&1; then
		run_sudo service docker start
	else
		log "Docker was installed; start the Docker daemon before continuing if it is not already running"
	fi
}

ensure_docker_compose() {
	if [[ "$DRY_RUN" == "1" ]]; then
		return
	fi
	if "${SUDO[@]}" docker compose version >/dev/null 2>&1; then
		return
	fi

	local compose_arch=""
	local compose_sha256=""
	case "$(uname -m)" in
		x86_64 | amd64)
			compose_arch="x86_64"
			compose_sha256="33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4"
			;;
		aarch64 | arm64)
			compose_arch="aarch64"
			compose_sha256="d4fb48b72857810314d3ee77123c89954101844efa4788031221f4c370495946"
			;;
		*)
			die "Docker Compose is missing and no checksum-pinned fallback is available for $(uname -m)"
			;;
	esac

	command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required to verify Docker Compose"
	local compose_asset="docker-compose-linux-${compose_arch}"
	local compose_url="https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_BOOTSTRAP_VERSION}/${compose_asset}"
	local compose_tmp
	compose_tmp="$(mktemp)"
	if ! curl --fail --location --show-error --silent \
		--proto '=https' --proto-redir '=https' --tlsv1.2 \
		--retry 3 --connect-timeout 20 --max-time 300 \
		--output "$compose_tmp" "$compose_url"; then
		rm -f "$compose_tmp"
		die "Unable to download Docker Compose $DOCKER_COMPOSE_BOOTSTRAP_VERSION"
	fi
	if ! printf '%s  %s\n' "$compose_sha256" "$compose_tmp" | sha256sum -c - >/dev/null; then
		rm -f "$compose_tmp"
		die "Docker Compose checksum verification failed"
	fi
	run_sudo install -d -m 0755 /usr/local/lib/docker/cli-plugins
	run_sudo install -m 0755 "$compose_tmp" /usr/local/lib/docker/cli-plugins/docker-compose
	rm -f "$compose_tmp"
	"${SUDO[@]}" docker compose version >/dev/null 2>&1 || die "Verified Docker Compose installation failed"
}

write_compose_base() {
	write_file "$INSTALL_DIR/docker-compose.prod.yml" <<'YAML'
name: nearzero

services:
  dns-init:
    image: ${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.39}
    profiles: ["managed-dns"]
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - |
        umask 022
        mkdir -p /etc/coredns/zones
        if [ -d /legacy-nearzero/dns/zones ]; then
          cp -n /legacy-nearzero/dns/zones/*.zone /etc/coredns/zones/ 2>/dev/null || true
        fi
        if [ ! -f /etc/coredns/Corefile ]; then
          printf '%s\n' \
            '# Managed by Nearzero. Authoritative zones only; this is not a recursive resolver.' \
            '.:53 {' \
            '  auto {' \
            '    directory /etc/coredns/zones (.*)\.zone {1}' \
            '    reload 2s' \
            '  }' \
            '  reload 30s' \
            '  errors' \
            '}' > /etc/coredns/Corefile
        fi
    volumes:
      - nearzero-data:/legacy-nearzero:ro
      - nearzero-dns:/etc/coredns
    read_only: true
    network_mode: none
    mem_limit: 128m
    pids_limit: 64
    cap_drop: ["ALL"]
    security_opt:
      - no-new-privileges:true
    restart: "no"

  dns:
    container_name: nearzero-dns
    image: ${NEARZERO_DNS_IMAGE:-coredns/coredns:1.14.6}
    profiles: ["managed-dns"]
    command: ["-conf", "/etc/coredns/Corefile"]
    depends_on:
      dns-init:
        condition: service_completed_successfully
    ports:
      - "${NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_DNS_PORT:-53}:53/tcp"
      - "${NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_DNS_PORT:-53}:53/udp"
    volumes:
      - nearzero-dns:/etc/coredns:ro
    read_only: true
    mem_limit: 128m
    pids_limit: 128
    cap_drop: ["ALL"]
    cap_add: ["NET_BIND_SERVICE"]
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped

  platform:
    image: ${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.39}
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      REDIS_URL: ${REDIS_URL:?REDIS_URL is required}
      NEARZERO_METRICS_URL: ${NEARZERO_METRICS_URL:-http://monitoring:${NEARZERO_METRICS_PORT:-4500}/metrics}
      NEARZERO_METRICS_TOKEN: ${NEARZERO_METRICS_TOKEN:?NEARZERO_METRICS_TOKEN is required}
      NEARZERO_METRICS_PORT: ${NEARZERO_METRICS_PORT:-4500}
      NEARZERO_MONITORING_IMAGE: ${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:0.1.39}
      NEARZERO_PLATFORM_DOMAIN: ${NEARZERO_PLATFORM_DOMAIN:-}
      NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE: ${NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE:-false}
    ports:
      - "${NEARZERO_PLATFORM_PORT:-3000}:3000"
      - "${NEARZERO_CONSOLE_PORT:-4321}:4321"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - nearzero-data:/etc/nearzero
      - nearzero-dns:/etc/nearzero/dns
    depends_on:
      monitoring:
        condition: service_healthy
    restart: unless-stopped

  monitoring:
    container_name: nearzero-monitoring
    image: ${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:0.1.39}
    environment:
      METRICS_CONFIG: '{"server":{"type":"Nearzero","refreshRate":${NEARZERO_METRICS_REFRESH_SECONDS:-5},"port":${NEARZERO_METRICS_PORT:-4500},"token":"${NEARZERO_METRICS_TOKEN:?NEARZERO_METRICS_TOKEN is required}","urlCallback":"${NEARZERO_METRICS_CALLBACK_URL:-http://platform:3000/api/trpc/notification.receiveNotification}","retentionDays":${NEARZERO_METRICS_RETENTION_DAYS:-2},"cronJob":"${NEARZERO_METRICS_CRON:-0 0 * * *}","thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":${NEARZERO_METRICS_REFRESH_SECONDS:-5},"services":{"include":[],"exclude":[]}}}'
      HOST_SYS: /host/sys
      NEARZERO_HOST_ROOT: /host/root
    ports:
      - "127.0.0.1:${NEARZERO_METRICS_PORT:-4500}:${NEARZERO_METRICS_PORT:-4500}"
    volumes:
      # statfs on this same-filesystem directory reports host disk usage
      # without exposing the host's entire root filesystem to monitoring.
      - /etc/nearzero/monitoring:/host/root:ro
      - /sys:/host/sys:ro
      - /etc/os-release:/etc/os-release:ro
      - /etc/nearzero/monitoring/monitoring.db:/app/monitoring.db
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${NEARZERO_METRICS_PORT:-4500}/health >/dev/null 2>&1"]
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  schedules:
    image: ${NEARZERO_SCHEDULE_IMAGE:-ghcr.io/nearzero-systems/schedule:0.1.39}
    profiles: ["schedules"]
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      REDIS_URL: ${REDIS_URL:?REDIS_URL is required}
      API_KEY: ${API_KEY:-}
      PORT: ${NEARZERO_SCHEDULE_PORT:-4001}
    restart: unless-stopped

volumes:
  nearzero-data:
  nearzero-dns:
YAML
}

write_compose_local_db() {
	write_file "$INSTALL_DIR/docker-compose.local-db.yml" <<'YAML'
name: nearzero

services:
  postgres:
    container_name: nearzero-postgres
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-nearzero}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: ${POSTGRES_DB:-nearzero}
    volumes:
      - nearzero-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-nearzero} -d ${POSTGRES_DB:-nearzero}"]
      interval: 10s
      timeout: 5s
      retries: 20

  redis:
    container_name: nearzero-redis
    image: redis:7-alpine
    volumes:
      - nearzero-redis:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 20

  platform:
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      REDIS_URL: ${REDIS_URL:-redis://redis:6379}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  schedules:
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      REDIS_URL: ${REDIS_URL:-redis://redis:6379}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

volumes:
  nearzero-postgres:
  nearzero-redis:
YAML
}

write_env() {
	local host private_ip console_url platform_url postgres_password auth_secret local_redis_url metrics_token trusted_origins
	local better_auth_url git_provider_base_url platform_domain compose_profiles
	local platform_domain_shared_edge jobs_url api_key
	local existing_auth_secret existing_postgres_password existing_metrics_token existing_database_url existing_redis_url
	local existing_console_url existing_platform_url existing_better_auth_url existing_git_provider_base_url existing_trusted_origins
	local existing_platform_domain existing_compose_profiles existing_enable_managed_dns existing_dns_bind_address existing_dns_port
	local existing_allow_monitoring_docker_metadata existing_platform_domain_shared_edge existing_jobs_url existing_api_key
	local existing_traefik_image existing_traefik_socket_proxy_image existing_ssh_strict_host_key_checking
	local existing_heroku_builder_image existing_paketo_builder_image existing_railpack_frontend_image existing_static_nginx_image
	existing_auth_secret="$(existing_env_value BETTER_AUTH_SECRET)"
	existing_postgres_password="$(existing_env_value POSTGRES_PASSWORD)"
	existing_metrics_token="$(existing_env_value NEARZERO_METRICS_TOKEN)"
	existing_database_url="$(existing_env_value DATABASE_URL)"
	existing_redis_url="$(existing_env_value REDIS_URL)"
	existing_console_url="$(existing_env_value CONSOLE_URL)"
	existing_platform_url="$(existing_env_value PUBLIC_BACKEND_URL)"
	existing_better_auth_url="$(existing_env_value BETTER_AUTH_URL)"
	existing_git_provider_base_url="$(existing_env_value PUBLIC_GIT_PROVIDER_BASE_URL)"
	existing_trusted_origins="$(existing_env_value NEARZERO_TRUSTED_ORIGINS)"
	existing_platform_domain="$(existing_env_value NEARZERO_PLATFORM_DOMAIN)"
	existing_platform_domain_shared_edge="$(existing_env_value NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE)"
	existing_compose_profiles="$(existing_env_value COMPOSE_PROFILES)"
	existing_enable_managed_dns="$(existing_env_value NEARZERO_ENABLE_MANAGED_DNS)"
	existing_dns_bind_address="$(existing_env_value NEARZERO_DNS_BIND_ADDRESS)"
	existing_dns_port="$(existing_env_value NEARZERO_DNS_PORT)"
	existing_allow_monitoring_docker_metadata="$(existing_env_value NEARZERO_ALLOW_MONITORING_DOCKER_METADATA)"
	existing_jobs_url="$(existing_env_value JOBS_URL)"
	existing_api_key="$(existing_env_value API_KEY)"
	existing_traefik_image="$(existing_env_value TRAEFIK_IMAGE)"
	existing_traefik_socket_proxy_image="$(existing_env_value TRAEFIK_SOCKET_PROXY_IMAGE)"
	existing_ssh_strict_host_key_checking="$(existing_env_value NEARZERO_SSH_STRICT_HOST_KEY_CHECKING)"
	existing_heroku_builder_image="$(existing_env_value NEARZERO_HEROKU_BUILDER_IMAGE)"
	existing_paketo_builder_image="$(existing_env_value NEARZERO_PAKETO_BUILDER_IMAGE)"
	existing_railpack_frontend_image="$(existing_env_value NEARZERO_RAILPACK_FRONTEND_IMAGE)"
	existing_static_nginx_image="$(existing_env_value NEARZERO_STATIC_NGINX_IMAGE)"

	host="$(detect_host)"
	private_ip="$(detect_private_ip)"
	console_url="${CONSOLE_URL:-${existing_console_url:-$(url_from_host "$host" "$NEARZERO_CONSOLE_PORT")}}"
	platform_url="${PUBLIC_BACKEND_URL:-${existing_platform_url:-$(url_from_host "$host" "$NEARZERO_PLATFORM_PORT")}}"
	better_auth_url="${BETTER_AUTH_URL:-${existing_better_auth_url:-$console_url}}"
	git_provider_base_url="${PUBLIC_GIT_PROVIDER_BASE_URL:-${existing_git_provider_base_url:-$console_url}}"
	trusted_origins="${NEARZERO_TRUSTED_ORIGINS:-${existing_trusted_origins:-$(collect_trusted_origins "$host" "$private_ip")}}"
	if [[ "$NEARZERO_PLATFORM_DOMAIN_WAS_SET" == "1" ]]; then
		platform_domain="$(normalize_platform_domain "$NEARZERO_PLATFORM_DOMAIN")"
	else
		platform_domain="$(normalize_platform_domain "$existing_platform_domain")"
	fi
	if [[ "$NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE_WAS_SET" == "0" && -n "$existing_platform_domain_shared_edge" ]]; then
		NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE="$existing_platform_domain_shared_edge"
	fi
	validate_boolean "NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE" "$NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE"
	if is_enabled "$NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE"; then
		platform_domain_shared_edge=true
	else
		platform_domain_shared_edge=false
	fi
	if [[ "$NEARZERO_ENABLE_MANAGED_DNS_WAS_SET" == "0" && -n "$existing_enable_managed_dns" ]]; then
		NEARZERO_ENABLE_MANAGED_DNS="$existing_enable_managed_dns"
	fi
	if [[ "$NEARZERO_DNS_BIND_ADDRESS_WAS_SET" == "0" && -n "$existing_dns_bind_address" ]]; then
		NEARZERO_DNS_BIND_ADDRESS="$existing_dns_bind_address"
	fi
	if [[ "$NEARZERO_DNS_PORT_WAS_SET" == "0" && -n "$existing_dns_port" ]]; then
		NEARZERO_DNS_PORT="$existing_dns_port"
	fi
	if [[ "$NEARZERO_ALLOW_MONITORING_DOCKER_METADATA_WAS_SET" == "0" && -n "$existing_allow_monitoring_docker_metadata" ]]; then
		NEARZERO_ALLOW_MONITORING_DOCKER_METADATA="$existing_allow_monitoring_docker_metadata"
	fi
	if [[ "$TRAEFIK_IMAGE_WAS_SET" == "0" && -n "$existing_traefik_image" ]]; then
		TRAEFIK_IMAGE="$existing_traefik_image"
	fi
	if [[ "$TRAEFIK_SOCKET_PROXY_IMAGE_WAS_SET" == "0" && -n "$existing_traefik_socket_proxy_image" ]]; then
		TRAEFIK_SOCKET_PROXY_IMAGE="$existing_traefik_socket_proxy_image"
	fi
	if [[ "$NEARZERO_SSH_STRICT_HOST_KEY_CHECKING_WAS_SET" == "0" && -n "$existing_ssh_strict_host_key_checking" ]]; then
		NEARZERO_SSH_STRICT_HOST_KEY_CHECKING="$existing_ssh_strict_host_key_checking"
	fi
	if [[ "$NEARZERO_HEROKU_BUILDER_IMAGE_WAS_SET" == "0" && -n "$existing_heroku_builder_image" ]]; then
		NEARZERO_HEROKU_BUILDER_IMAGE="$existing_heroku_builder_image"
	fi
	if [[ "$NEARZERO_PAKETO_BUILDER_IMAGE_WAS_SET" == "0" && -n "$existing_paketo_builder_image" ]]; then
		NEARZERO_PAKETO_BUILDER_IMAGE="$existing_paketo_builder_image"
	fi
	if [[ "$NEARZERO_RAILPACK_FRONTEND_IMAGE_WAS_SET" == "0" && -n "$existing_railpack_frontend_image" ]]; then
		NEARZERO_RAILPACK_FRONTEND_IMAGE="$existing_railpack_frontend_image"
	fi
	if [[ "$NEARZERO_STATIC_NGINX_IMAGE_WAS_SET" == "0" && -n "$existing_static_nginx_image" ]]; then
		NEARZERO_STATIC_NGINX_IMAGE="$existing_static_nginx_image"
	fi
	compose_profiles="${COMPOSE_PROFILES:-$existing_compose_profiles}"
	validate_boolean "NEARZERO_ENABLE_MANAGED_DNS" "$NEARZERO_ENABLE_MANAGED_DNS"
	if is_enabled "$NEARZERO_ENABLE_MANAGED_DNS"; then
		NEARZERO_ENABLE_MANAGED_DNS=true
		validate_dns_listener
		compose_profiles="$(append_origin_if_new "$compose_profiles" "managed-dns")"
	else
		NEARZERO_ENABLE_MANAGED_DNS=false
		compose_profiles="$(remove_csv_value "$compose_profiles" "managed-dns")"
	fi
	validate_boolean "NEARZERO_ALLOW_MONITORING_DOCKER_METADATA" "$NEARZERO_ALLOW_MONITORING_DOCKER_METADATA"
	if is_enabled "$NEARZERO_ALLOW_MONITORING_DOCKER_METADATA"; then
		NEARZERO_ALLOW_MONITORING_DOCKER_METADATA=true
	else
		NEARZERO_ALLOW_MONITORING_DOCKER_METADATA=false
	fi
	validate_boolean "NEARZERO_SSH_STRICT_HOST_KEY_CHECKING" "$NEARZERO_SSH_STRICT_HOST_KEY_CHECKING"
	if is_enabled "$NEARZERO_SSH_STRICT_HOST_KEY_CHECKING"; then
		NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=true
	else
		NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=false
	fi
	validate_docker_image_reference "TRAEFIK_IMAGE" "$TRAEFIK_IMAGE"
	validate_docker_image_reference "TRAEFIK_SOCKET_PROXY_IMAGE" "$TRAEFIK_SOCKET_PROXY_IMAGE"
	validate_immutable_builder_image_reference "NEARZERO_HEROKU_BUILDER_IMAGE" "$NEARZERO_HEROKU_BUILDER_IMAGE"
	validate_immutable_builder_image_reference "NEARZERO_PAKETO_BUILDER_IMAGE" "$NEARZERO_PAKETO_BUILDER_IMAGE"
	validate_immutable_builder_image_reference "NEARZERO_RAILPACK_FRONTEND_IMAGE" "$NEARZERO_RAILPACK_FRONTEND_IMAGE"
	validate_immutable_builder_image_reference "NEARZERO_STATIC_NGINX_IMAGE" "$NEARZERO_STATIC_NGINX_IMAGE"
	jobs_url="${JOBS_URL:-$existing_jobs_url}"
	api_key="${API_KEY:-$existing_api_key}"
	if csv_contains "$compose_profiles" "schedules"; then
		jobs_url="${jobs_url:-http://schedules:4001}"
		api_key="${api_key:-$(rand_hex 32)}"
	fi
	auth_secret="${BETTER_AUTH_SECRET:-${existing_auth_secret:-$(rand_hex 32)}}"
	postgres_password="${POSTGRES_PASSWORD:-${existing_postgres_password:-$(rand_hex 24)}}"
	metrics_token="${NEARZERO_METRICS_TOKEN:-${existing_metrics_token:-$(rand_hex 32)}}"
	if [[ "$USE_LOCAL_SERVICES" == "1" ]]; then
		DATABASE_URL="postgresql://${POSTGRES_USER}:${postgres_password}@postgres:5432/${POSTGRES_DB}"
		REDIS_URL="${REDIS_URL:-redis://redis:6379}"
	else
		DATABASE_URL="${DATABASE_URL:-$existing_database_url}"
		REDIS_URL="${REDIS_URL:-$existing_redis_url}"
	fi
	if [[ "$USE_LOCAL_SERVICES" == "0" && ( -z "$DATABASE_URL" || -z "$REDIS_URL" ) ]]; then
		die "External-service mode requires both DATABASE_URL and REDIS_URL"
	fi
	for env_name in DATABASE_URL REDIS_URL CONSOLE_URL PUBLIC_BACKEND_URL BETTER_AUTH_URL PUBLIC_GIT_PROVIDER_BASE_URL NEARZERO_TRUSTED_ORIGINS JOBS_URL API_KEY; do
		validate_single_line_value "$env_name" "${!env_name:-}"
	done
	validate_single_line_value "resolved JOBS_URL" "$jobs_url"
	validate_single_line_value "resolved API_KEY" "$api_key"
	local_redis_url="${REDIS_URL:-redis://redis:6379}"

	validate_port "NEARZERO_PLATFORM_PORT" "$NEARZERO_PLATFORM_PORT"
	validate_port "NEARZERO_CONSOLE_PORT" "$NEARZERO_CONSOLE_PORT"
	validate_port "NEARZERO_METRICS_PORT" "$NEARZERO_METRICS_PORT"
	validate_positive_integer "NEARZERO_METRICS_REFRESH_SECONDS" "$NEARZERO_METRICS_REFRESH_SECONDS"
	validate_positive_integer "NEARZERO_METRICS_RETENTION_DAYS" "$NEARZERO_METRICS_RETENTION_DAYS"
	validate_dotenv_quoted_value "NEARZERO_METRICS_CRON" "$NEARZERO_METRICS_CRON"

	for env_name in \
		NEARZERO_IMAGE \
		NEARZERO_MONITORING_IMAGE \
		NEARZERO_SCHEDULE_IMAGE \
		NEARZERO_DNS_IMAGE \
		NEARZERO_DNS_BIND_ADDRESS \
		POSTGRES_USER \
		POSTGRES_DB; do
		validate_dotenv_unquoted_value "$env_name" "${!env_name}"
	done
	validate_dotenv_unquoted_value "COMPOSE_PROFILES" "$compose_profiles"
	validate_dotenv_unquoted_value "NEARZERO_PLATFORM_DOMAIN" "$platform_domain"
	validate_dotenv_unquoted_value "NEARZERO_METRICS_TOKEN" "$metrics_token"
	validate_dotenv_unquoted_value "DATABASE_URL" "$DATABASE_URL"
	validate_dotenv_unquoted_value "POSTGRES_PASSWORD" "$postgres_password"
	validate_dotenv_unquoted_value "REDIS_URL" "$local_redis_url"
	validate_dotenv_unquoted_value "BETTER_AUTH_URL" "$better_auth_url"
	validate_dotenv_unquoted_value "BETTER_AUTH_SECRET" "$auth_secret"
	validate_dotenv_unquoted_value "CONSOLE_URL" "$console_url"
	validate_dotenv_unquoted_value "PUBLIC_BACKEND_URL" "$platform_url"
	validate_dotenv_unquoted_value "PUBLIC_GIT_PROVIDER_BASE_URL" "$git_provider_base_url"
	validate_dotenv_unquoted_value "NEARZERO_TRUSTED_ORIGINS" "$trusted_origins"
	validate_dotenv_unquoted_value "JOBS_URL" "$jobs_url"
	validate_dotenv_unquoted_value "API_KEY" "$api_key"

	write_file "$INSTALL_DIR/.env" <<EOF
COMPOSE_PROFILES=${compose_profiles}
NEARZERO_IMAGE=${NEARZERO_IMAGE}
NEARZERO_MONITORING_IMAGE=${NEARZERO_MONITORING_IMAGE}
NEARZERO_SCHEDULE_IMAGE=${NEARZERO_SCHEDULE_IMAGE}
NEARZERO_DNS_IMAGE=${NEARZERO_DNS_IMAGE}
NEARZERO_ENABLE_MANAGED_DNS=${NEARZERO_ENABLE_MANAGED_DNS}
NEARZERO_DNS_BIND_ADDRESS=${NEARZERO_DNS_BIND_ADDRESS}
NEARZERO_DNS_PORT=${NEARZERO_DNS_PORT}
NEARZERO_PLATFORM_DOMAIN=${platform_domain}
NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE=${platform_domain_shared_edge}
NEARZERO_PLATFORM_PORT=${NEARZERO_PLATFORM_PORT}
NEARZERO_CONSOLE_PORT=${NEARZERO_CONSOLE_PORT}
NEARZERO_METRICS_PORT=${NEARZERO_METRICS_PORT}
NEARZERO_METRICS_REFRESH_SECONDS=${NEARZERO_METRICS_REFRESH_SECONDS}
NEARZERO_METRICS_RETENTION_DAYS=${NEARZERO_METRICS_RETENTION_DAYS}
NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON}"
NEARZERO_METRICS_TOKEN=${metrics_token}
NEARZERO_METRICS_URL=http://monitoring:${NEARZERO_METRICS_PORT}/metrics
NEARZERO_METRICS_CALLBACK_URL=http://platform:3000/api/trpc/notification.receiveNotification
NEARZERO_ALLOW_MONITORING_DOCKER_METADATA=${NEARZERO_ALLOW_MONITORING_DOCKER_METADATA}
TRAEFIK_IMAGE=${TRAEFIK_IMAGE}
TRAEFIK_SOCKET_PROXY_IMAGE=${TRAEFIK_SOCKET_PROXY_IMAGE}
NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=${NEARZERO_SSH_STRICT_HOST_KEY_CHECKING}
NEARZERO_HEROKU_BUILDER_IMAGE=${NEARZERO_HEROKU_BUILDER_IMAGE}
NEARZERO_PAKETO_BUILDER_IMAGE=${NEARZERO_PAKETO_BUILDER_IMAGE}
NEARZERO_RAILPACK_FRONTEND_IMAGE=${NEARZERO_RAILPACK_FRONTEND_IMAGE}
NEARZERO_STATIC_NGINX_IMAGE=${NEARZERO_STATIC_NGINX_IMAGE}

DATABASE_URL=${DATABASE_URL}
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${postgres_password}
POSTGRES_DB=${POSTGRES_DB}

REDIS_URL=${local_redis_url}

PORT=3000
HOST=0.0.0.0
NODE_ENV=production

BETTER_AUTH_URL=${better_auth_url}
BETTER_AUTH_SECRET=${auth_secret}
CONSOLE_URL=${console_url}
BACKEND_URL=http://platform:3000
PUBLIC_BACKEND_URL=${platform_url}
PUBLIC_GIT_PROVIDER_BASE_URL=${git_provider_base_url}
NEARZERO_TRUSTED_ORIGINS=${trusted_origins}
JOBS_URL=${jobs_url}
API_KEY=${api_key}
EOF
	chmod_file 0600 "$INSTALL_DIR/.env"
}

prepare_monitoring_storage() {
	if [[ "$DRY_RUN" == "1" ]]; then
		log "dry run: not creating /etc/nearzero/monitoring/monitoring.db"
		return
	fi
	run_sudo mkdir -p /etc/nearzero/monitoring
	run_sudo touch /etc/nearzero/monitoring/monitoring.db
}

write_helper() {
	local helper_path="/usr/local/bin/nearzero"
	if [[ "$DRY_RUN" == "1" ]]; then
		helper_path="$INSTALL_DIR/nearzero"
	fi
	write_file "$helper_path" <<'HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/nearzero}"
COMPOSE=(-f "$INSTALL_DIR/docker-compose.prod.yml")
if [[ -f "$INSTALL_DIR/docker-compose.local-db.yml" ]]; then
	COMPOSE+=(-f "$INSTALL_DIR/docker-compose.local-db.yml")
fi

docker_compose() {
	docker compose "${COMPOSE[@]}" --env-file "$INSTALL_DIR/.env" "$@"
}

case "${1:-status}" in
	status)
		docker_compose ps
		;;
	logs)
		shift || true
		docker_compose logs -f "$@"
		;;
	restart)
		docker_compose restart
		;;
	update)
		docker_compose pull
		docker_compose up -d
		;;
	backup-db)
		if [[ ! -f "$INSTALL_DIR/docker-compose.local-db.yml" ]]; then
			echo "backup-db only supports the local Postgres install" >&2
			exit 1
		fi
		out="${2:-$INSTALL_DIR/nearzero-db-$(date +%Y%m%d-%H%M%S).sql}"
		docker_compose exec -T postgres pg_dump -U "${POSTGRES_USER:-nearzero}" "${POSTGRES_DB:-nearzero}" > "$out"
		echo "$out"
		;;
	restore-db)
		if [[ ! -f "$INSTALL_DIR/docker-compose.local-db.yml" ]]; then
			echo "restore-db only supports the local Postgres install" >&2
			exit 1
		fi
		file="${2:?usage: nearzero restore-db dump.sql}"
		docker_compose exec -T postgres psql -U "${POSTGRES_USER:-nearzero}" "${POSTGRES_DB:-nearzero}" < "$file"
		;;
	*)
		echo "usage: nearzero {status|logs|restart|update|backup-db|restore-db}" >&2
		exit 1
		;;
esac
HELPER
	chmod_file 0755 "$helper_path"
}

start_stack() {
	local compose_args=(-f "$INSTALL_DIR/docker-compose.prod.yml")
	if [[ "$USE_LOCAL_SERVICES" == "1" ]]; then
		compose_args+=(-f "$INSTALL_DIR/docker-compose.local-db.yml")
	fi
	if [[ "$DRY_RUN" == "1" ]]; then
		log "dry run: not starting Docker services"
		return
	fi
	if ! is_enabled "$NEARZERO_ENABLE_MANAGED_DNS"; then
		if "${SUDO[@]}" docker container inspect nearzero-dns >/dev/null 2>&1; then
			log "Managed DNS disabled; removing the Nearzero CoreDNS container while preserving its volume"
			"${SUDO[@]}" docker container rm -f nearzero-dns >/dev/null
		fi
	fi
	log "Pulling Nearzero images..."
	"${SUDO[@]}" docker compose "${compose_args[@]}" --env-file "$INSTALL_DIR/.env" pull
	"${SUDO[@]}" docker compose "${compose_args[@]}" --env-file "$INSTALL_DIR/.env" up -d --force-recreate
}

main() {
	print_banner
	ensure_sudo
	announce_install
	run_sudo mkdir -p "$INSTALL_DIR"
	write_compose_base
	if [[ "$USE_LOCAL_SERVICES" == "1" ]]; then
		write_compose_local_db
	else
		log "Using external DATABASE_URL/REDIS_URL only"
	fi
	write_env
	prepare_monitoring_storage
	write_helper
	ensure_docker
	ensure_docker_compose
	start_stack
	log "Installed Nearzero in $INSTALL_DIR"
	log "Console: $(grep '^CONSOLE_URL=' "$INSTALL_DIR/.env" | cut -d= -f2-)"
	log "Helper: nearzero status"
}

main "$@"
