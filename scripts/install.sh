#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR_INPUT="${INSTALL_DIR:-}"
if [[ "${DRY_RUN:-}" == "1" && -z "$INSTALL_DIR_INPUT" ]]; then
	INSTALL_DIR="/tmp/nearzero-dry-run"
else
	INSTALL_DIR="${INSTALL_DIR_INPUT:-/opt/nearzero}"
fi

if [[ "${NEARZERO_IMAGE+x}" == "x" ]]; then NEARZERO_IMAGE_WAS_SET=1; else NEARZERO_IMAGE_WAS_SET=0; fi
NEARZERO_IMAGE="${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.43}"
if [[ "${NEARZERO_MONITORING_IMAGE+x}" == "x" ]]; then NEARZERO_MONITORING_IMAGE_WAS_SET=1; else NEARZERO_MONITORING_IMAGE_WAS_SET=0; fi
NEARZERO_MONITORING_IMAGE="${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:0.1.43}"
if [[ "${NEARZERO_SCHEDULE_IMAGE+x}" == "x" ]]; then NEARZERO_SCHEDULE_IMAGE_WAS_SET=1; else NEARZERO_SCHEDULE_IMAGE_WAS_SET=0; fi
NEARZERO_SCHEDULE_IMAGE="${NEARZERO_SCHEDULE_IMAGE:-ghcr.io/nearzero-systems/schedule:0.1.43}"
if [[ "${NEARZERO_DNS_IMAGE+x}" == "x" ]]; then NEARZERO_DNS_IMAGE_WAS_SET=1; else NEARZERO_DNS_IMAGE_WAS_SET=0; fi
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
if [[ "${NEARZERO_PUBLIC_IP+x}" == "x" ]]; then
	NEARZERO_PUBLIC_IP_WAS_SET=1
else
	NEARZERO_PUBLIC_IP_WAS_SET=0
fi
NEARZERO_PUBLIC_IP="${NEARZERO_PUBLIC_IP:-}"
if [[ "${NEARZERO_MANAGEMENT_HOSTNAME+x}" == "x" ]]; then
	NEARZERO_MANAGEMENT_HOSTNAME_WAS_SET=1
else
	NEARZERO_MANAGEMENT_HOSTNAME_WAS_SET=0
fi
NEARZERO_MANAGEMENT_HOSTNAME="${NEARZERO_MANAGEMENT_HOSTNAME:-}"
if [[ "${NEARZERO_MANAGED_DNS_ZONE+x}" == "x" ]]; then
	NEARZERO_MANAGED_DNS_ZONE_WAS_SET=1
else
	NEARZERO_MANAGED_DNS_ZONE_WAS_SET=0
fi
NEARZERO_MANAGED_DNS_ZONE="${NEARZERO_MANAGED_DNS_ZONE:-}"
if [[ "${NEARZERO_MANAGED_DNS_SOA_EMAIL+x}" == "x" ]]; then
	NEARZERO_MANAGED_DNS_SOA_EMAIL_WAS_SET=1
else
	NEARZERO_MANAGED_DNS_SOA_EMAIL_WAS_SET=0
fi
NEARZERO_MANAGED_DNS_SOA_EMAIL="${NEARZERO_MANAGED_DNS_SOA_EMAIL:-}"
if [[ "${NEARZERO_ADMIN_EMAIL+x}" == "x" ]]; then
	NEARZERO_ADMIN_EMAIL_WAS_SET=1
else
	NEARZERO_ADMIN_EMAIL_WAS_SET=0
fi
NEARZERO_ADMIN_EMAIL="${NEARZERO_ADMIN_EMAIL:-}"
if [[ "${NEARZERO_REGISTRATION_MODE+x}" == "x" ]]; then
	NEARZERO_REGISTRATION_MODE_WAS_SET=1
else
	NEARZERO_REGISTRATION_MODE_WAS_SET=0
fi
NEARZERO_REGISTRATION_MODE="${NEARZERO_REGISTRATION_MODE:-bootstrap}"
if [[ "${NEARZERO_INSTALL_SETUP_TOKEN_HASH+x}" == "x" ]]; then
	NEARZERO_INSTALL_SETUP_TOKEN_HASH_WAS_SET=1
else
	NEARZERO_INSTALL_SETUP_TOKEN_HASH_WAS_SET=0
fi
NEARZERO_INSTALL_SETUP_TOKEN_HASH="${NEARZERO_INSTALL_SETUP_TOKEN_HASH:-}"
INSTALL_SETUP_TOKEN_PLAINTEXT=""
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
if [[ "${NEARZERO_MANAGEMENT_BIND_ADDRESS+x}" == "x" ]]; then
	NEARZERO_MANAGEMENT_BIND_ADDRESS_WAS_SET=1
else
	NEARZERO_MANAGEMENT_BIND_ADDRESS_WAS_SET=0
fi
NEARZERO_MANAGEMENT_BIND_ADDRESS="${NEARZERO_MANAGEMENT_BIND_ADDRESS:-127.0.0.1}"
if [[ "${NEARZERO_PLATFORM_PORT+x}" == "x" ]]; then NEARZERO_PLATFORM_PORT_WAS_SET=1; else NEARZERO_PLATFORM_PORT_WAS_SET=0; fi
NEARZERO_PLATFORM_PORT="${NEARZERO_PLATFORM_PORT:-3000}"
if [[ "${NEARZERO_CONSOLE_PORT+x}" == "x" ]]; then NEARZERO_CONSOLE_PORT_WAS_SET=1; else NEARZERO_CONSOLE_PORT_WAS_SET=0; fi
NEARZERO_CONSOLE_PORT="${NEARZERO_CONSOLE_PORT:-4321}"
if [[ "${NEARZERO_METRICS_PORT+x}" == "x" ]]; then NEARZERO_METRICS_PORT_WAS_SET=1; else NEARZERO_METRICS_PORT_WAS_SET=0; fi
NEARZERO_METRICS_PORT="${NEARZERO_METRICS_PORT:-4500}"
if [[ "${NEARZERO_METRICS_REFRESH_SECONDS+x}" == "x" ]]; then NEARZERO_METRICS_REFRESH_SECONDS_WAS_SET=1; else NEARZERO_METRICS_REFRESH_SECONDS_WAS_SET=0; fi
NEARZERO_METRICS_REFRESH_SECONDS="${NEARZERO_METRICS_REFRESH_SECONDS:-5}"
if [[ "${NEARZERO_METRICS_RETENTION_DAYS+x}" == "x" ]]; then NEARZERO_METRICS_RETENTION_DAYS_WAS_SET=1; else NEARZERO_METRICS_RETENTION_DAYS_WAS_SET=0; fi
NEARZERO_METRICS_RETENTION_DAYS="${NEARZERO_METRICS_RETENTION_DAYS:-2}"
if [[ "${NEARZERO_METRICS_CRON+x}" == "x" ]]; then NEARZERO_METRICS_CRON_WAS_SET=1; else NEARZERO_METRICS_CRON_WAS_SET=0; fi
NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON:-0 0 * * *}"
NEARZERO_METRICS_TOKEN="${NEARZERO_METRICS_TOKEN:-}"
if [[ "${NEARZERO_STARTUP_TIMEOUT_SECONDS+x}" == "x" ]]; then NEARZERO_STARTUP_TIMEOUT_SECONDS_WAS_SET=1; else NEARZERO_STARTUP_TIMEOUT_SECONDS_WAS_SET=0; fi
NEARZERO_STARTUP_TIMEOUT_SECONDS="${NEARZERO_STARTUP_TIMEOUT_SECONDS:-300}"
if [[ "${NEARZERO_ALLOW_MONITORING_DOCKER_METADATA+x}" == "x" ]]; then
	NEARZERO_ALLOW_MONITORING_DOCKER_METADATA_WAS_SET=1
else
	NEARZERO_ALLOW_MONITORING_DOCKER_METADATA_WAS_SET=0
fi
NEARZERO_ALLOW_MONITORING_DOCKER_METADATA="${NEARZERO_ALLOW_MONITORING_DOCKER_METADATA:-false}"
if [[ "${POSTGRES_USER+x}" == "x" ]]; then POSTGRES_USER_WAS_SET=1; else POSTGRES_USER_WAS_SET=0; fi
POSTGRES_USER="${POSTGRES_USER:-nearzero}"
if [[ "${POSTGRES_DB+x}" == "x" ]]; then POSTGRES_DB_WAS_SET=1; else POSTGRES_DB_WAS_SET=0; fi
POSTGRES_DB="${POSTGRES_DB:-nearzero}"
if [[ "${DATABASE_URL+x}" == "x" ]]; then
	DATABASE_URL_WAS_SET=1
else
	DATABASE_URL_WAS_SET=0
fi
if [[ "${REDIS_URL+x}" == "x" ]]; then
	REDIS_URL_WAS_SET=1
else
	REDIS_URL_WAS_SET=0
fi
if [[ "${NEARZERO_DATA_MODE+x}" == "x" ]]; then
	NEARZERO_DATA_MODE_WAS_SET=1
else
	NEARZERO_DATA_MODE_WAS_SET=0
fi
REDIS_URL="${REDIS_URL:-}"
DATABASE_URL="${DATABASE_URL:-}"
NEARZERO_DATA_MODE="${NEARZERO_DATA_MODE:-}"
JOBS_URL="${JOBS_URL:-}"
API_KEY="${API_KEY:-}"
SKIP_DOCKER_INSTALL="${SKIP_DOCKER_INSTALL:-}"
DRY_RUN="${DRY_RUN:-}"
NEARZERO_NONINTERACTIVE="${NEARZERO_NONINTERACTIVE:-false}"
INTERACTIVE_FIRST_RUN=0
if [[ "${CONSOLE_URL+x}" == "x" ]]; then
	CONSOLE_URL_WAS_SET=1
else
	CONSOLE_URL_WAS_SET=0
fi
if [[ "${PUBLIC_BACKEND_URL+x}" == "x" ]]; then
	PUBLIC_BACKEND_URL_WAS_SET=1
else
	PUBLIC_BACKEND_URL_WAS_SET=0
fi
PUBLIC_BACKEND_URL="${PUBLIC_BACKEND_URL:-}"
if [[ "${BETTER_AUTH_URL+x}" == "x" ]]; then
	BETTER_AUTH_URL_WAS_SET=1
else
	BETTER_AUTH_URL_WAS_SET=0
fi
if [[ "${PUBLIC_GIT_PROVIDER_BASE_URL+x}" == "x" ]]; then
	PUBLIC_GIT_PROVIDER_BASE_URL_WAS_SET=1
else
	PUBLIC_GIT_PROVIDER_BASE_URL_WAS_SET=0
fi
if [[ "${NEARZERO_TRUSTED_ORIGINS+x}" == "x" ]]; then
	NEARZERO_TRUSTED_ORIGINS_WAS_SET=1
else
	NEARZERO_TRUSTED_ORIGINS_WAS_SET=0
fi
USE_LOCAL_SERVICES=1

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
	local mode="${2:-0644}"
	local tmp
	tmp="$(mktemp)"
	cat > "$tmp"
	if [[ "$DRY_RUN" == "1" ]]; then
		mkdir -p "$(dirname "$path")"
		install -m "$mode" "$tmp" "$path"
		rm -f "$tmp"
		return
	fi
	"${SUDO[@]}" install -d -o root -g root -m 0755 "$(dirname "$path")"
	if ! "${SUDO[@]}" install -o root -g root -m "$mode" "$tmp" "$path"; then
		rm -f "$tmp"
		die "Failed to install $path"
	fi
	rm -f "$tmp"
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
	local awk_program='
		$1 == key {
			sub(/^[^=]*=/, "")
			print
			exit
		}
	'
	if [[ -r "$env_file" ]]; then
		awk -F= -v key="$key" "$awk_program" "$env_file"
		return
	fi
	if [[ "$DRY_RUN" != "1" ]] && "${SUDO[@]}" test -r "$env_file" 2>/dev/null; then
		"${SUDO[@]}" awk -F= -v key="$key" "$awk_program" "$env_file"
	fi
}

GENERATED_ENV_KEYS="COMPOSE_PROFILES,NEARZERO_IMAGE,NEARZERO_MONITORING_IMAGE,NEARZERO_SCHEDULE_IMAGE,NEARZERO_DNS_IMAGE,NEARZERO_ENABLE_MANAGED_DNS,NEARZERO_DNS_BIND_ADDRESS,NEARZERO_DNS_PORT,NEARZERO_PUBLIC_IP,NEARZERO_MANAGEMENT_HOSTNAME,NEARZERO_MANAGED_DNS_ZONE,NEARZERO_MANAGED_DNS_SOA_EMAIL,NEARZERO_ADMIN_EMAIL,NEARZERO_REGISTRATION_MODE,NEARZERO_INSTALL_SETUP_TOKEN_HASH,NEARZERO_DATA_MODE,NEARZERO_PLATFORM_DOMAIN,NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE,NEARZERO_MANAGEMENT_BIND_ADDRESS,NEARZERO_PLATFORM_PORT,NEARZERO_CONSOLE_PORT,NEARZERO_METRICS_PORT,NEARZERO_METRICS_REFRESH_SECONDS,NEARZERO_METRICS_RETENTION_DAYS,NEARZERO_METRICS_CRON,NEARZERO_STARTUP_TIMEOUT_SECONDS,NEARZERO_METRICS_TOKEN,NEARZERO_METRICS_URL,NEARZERO_METRICS_CALLBACK_URL,NEARZERO_ALLOW_MONITORING_DOCKER_METADATA,TRAEFIK_IMAGE,TRAEFIK_SOCKET_PROXY_IMAGE,NEARZERO_SSH_STRICT_HOST_KEY_CHECKING,NEARZERO_HEROKU_BUILDER_IMAGE,NEARZERO_PAKETO_BUILDER_IMAGE,NEARZERO_RAILPACK_FRONTEND_IMAGE,NEARZERO_STATIC_NGINX_IMAGE,DATABASE_URL,POSTGRES_USER,POSTGRES_PASSWORD,POSTGRES_DB,REDIS_URL,PORT,HOST,NODE_ENV,BETTER_AUTH_URL,BETTER_AUTH_SECRET,CONSOLE_URL,BACKEND_URL,PUBLIC_BACKEND_URL,PUBLIC_GIT_PROVIDER_BASE_URL,NEARZERO_TRUSTED_ORIGINS,JOBS_URL,API_KEY"

preserved_custom_env_assignments() {
	local env_file="$INSTALL_DIR/.env"
	local awk_program='
		BEGIN {
			count = split(generated_csv, keys, ",")
			for (i = 1; i <= count; i++) generated[keys[i]] = 1
		}
		/^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
		{
			if (index($0, "\r") != 0 || $0 !~ /^[A-Za-z_][A-Za-z0-9_]*=.*/) exit 42
			key = $0
			sub(/=.*/, "", key)
			if (seen[key]++) exit 43
			if (!(key in generated)) print $0
		}
	'
	if [[ -r "$env_file" ]]; then
		awk -v generated_csv="$GENERATED_ENV_KEYS" "$awk_program" "$env_file"
		return
	fi
	if [[ "$DRY_RUN" != "1" ]] && "${SUDO[@]}" test -r "$env_file" 2>/dev/null; then
		"${SUDO[@]}" awk -v generated_csv="$GENERATED_ENV_KEYS" "$awk_program" "$env_file"
	fi
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

can_prompt() {
	[[ -t 0 && -t 1 ]] && ! is_enabled "$NEARZERO_NONINTERACTIVE"
}

prompt_value() {
	local variable_name="$1"
	local message="$2"
	local reply=""
	printf '%s' "$message"
	if ! IFS= read -r reply; then
		die "Interactive input ended before first-run configuration was complete; rerun with the documented environment variables"
	fi
	printf -v "$variable_name" '%s' "$reply"
}

prompt_value_with_default() {
	local variable_name="$1"
	local message="$2"
	local default_value="$3"
	local value=""
	if [[ -n "$default_value" ]]; then
		prompt_value value "$message [$default_value]: "
		value="${value:-$default_value}"
	else
		prompt_value value "$message: "
	fi
	printf -v "$variable_name" '%s' "$value"
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

normalize_dns_hostname() {
	local name="$1"
	local domain
	domain="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
	domain="${domain%.}"
	if [[ -z "$domain" ]]; then
		return
	fi
	if (( ${#domain} > 253 )) || [[ ! "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
		die "$name must be a DNS hostname without a scheme, path, wildcard, or port"
	fi
	printf '%s' "$domain"
}

normalize_platform_domain() {
	normalize_dns_hostname "NEARZERO_PLATFORM_DOMAIN" "$1"
}

normalize_management_hostname() {
	normalize_dns_hostname "NEARZERO_MANAGEMENT_HOSTNAME" "$1"
}

normalize_managed_dns_zone() {
	normalize_dns_hostname "NEARZERO_MANAGED_DNS_ZONE" "$1"
}

normalize_email() {
	local name="$1"
	local email="$2"
	if [[ -z "$email" ]]; then
		return
	fi
	validate_dotenv_unquoted_value "$name" "$email"
	if (( ${#email} > 254 )) || [[ "$email" != *@* ]] || [[ "${email#*@}" == *@* ]]; then
		die "$name must be one valid email address"
	fi
	local local_part="${email%@*}"
	local domain="${email##*@}"
	if [[ -z "$local_part" || "$local_part" == .* || "$local_part" == *. || "$local_part" == *..* ]] ||
		[[ ! "$local_part" =~ ^[A-Za-z0-9.!%\&*+/=?^_{}\|~-]+$ ]]; then
		die "$name must be one valid email address"
	fi
	domain="$(normalize_dns_hostname "$name domain" "$domain")"
	printf '%s@%s' "$local_part" "$domain"
}

normalize_managed_dns_soa_email() {
	normalize_email "NEARZERO_MANAGED_DNS_SOA_EMAIL" "$1"
}

normalize_admin_email() {
	normalize_email "NEARZERO_ADMIN_EMAIL" "$1"
}

normalize_registration_mode() {
	local mode
	mode="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
	case "$mode" in
	bootstrap | invite_only | open) printf '%s' "$mode" ;;
	*) die "NEARZERO_REGISTRATION_MODE must be bootstrap, invite_only, or open" ;;
	esac
}

normalize_data_mode() {
	local mode
	mode="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
	case "$mode" in
	local | external) printf '%s' "$mode" ;;
	*) die "NEARZERO_DATA_MODE must be local or external" ;;
	esac
}

installed_file_exists() {
	local path="$1"
	if [[ -e "$path" ]]; then
		return 0
	fi
	if [[ "$DRY_RUN" != "1" ]] && (( ${#SUDO[@]} > 0 )); then
		"${SUDO[@]}" test -e "$path" 2>/dev/null
		return
	fi
	return 1
}

resolve_data_mode() {
	local existing_mode=""
	local existing_database_url=""
	local existing_redis_url=""
	local requested_mode=""
	local supplied_url_pair=0
	local external_services="${EXTERNAL_SERVICES:-}"

	if [[ "$DATABASE_URL_WAS_SET" != "$REDIS_URL_WAS_SET" ]]; then
		die "DATABASE_URL and REDIS_URL must be supplied together; partial external-service input is not accepted"
	fi
	if [[ "$DATABASE_URL_WAS_SET" == "1" ]]; then
		if [[ -z "$DATABASE_URL" || -z "$REDIS_URL" ]]; then
			die "DATABASE_URL and REDIS_URL must both be non-empty when supplied"
		fi
		supplied_url_pair=1
	fi

	if [[ -n "$external_services" ]]; then
		validate_boolean "EXTERNAL_SERVICES" "$external_services"
		if is_enabled "$external_services"; then
			requested_mode="external"
		fi
	fi
	if [[ "$NEARZERO_DATA_MODE_WAS_SET" == "1" ]]; then
		NEARZERO_DATA_MODE="$(normalize_data_mode "$NEARZERO_DATA_MODE")"
		if [[ -n "$requested_mode" && "$requested_mode" != "$NEARZERO_DATA_MODE" ]]; then
			die "NEARZERO_DATA_MODE conflicts with the deprecated EXTERNAL_SERVICES flag"
		fi
		requested_mode="$NEARZERO_DATA_MODE"
	fi

	if installed_file_exists "$INSTALL_DIR/.env"; then
		existing_mode="$(existing_env_value NEARZERO_DATA_MODE)"
		existing_database_url="$(existing_env_value DATABASE_URL)"
		existing_redis_url="$(existing_env_value REDIS_URL)"
		if [[ -n "$existing_mode" ]]; then
			existing_mode="$(normalize_data_mode "$existing_mode")"
		elif [[ "$existing_database_url" == *"@postgres:5432/"* && "$existing_redis_url" == "redis://redis:6379" ]]; then
			# The legacy bundled-service URLs are unambiguous, and the overlay can
			# be recreated if an operator accidentally removed it.
			existing_mode="local"
		elif ! installed_file_exists "$INSTALL_DIR/docker-compose.local-db.yml" &&
			[[ -n "$existing_database_url" && -n "$existing_redis_url" ]]; then
			# A complete non-local pair without the bundled overlay is external.
			existing_mode="external"
		elif [[ -n "$requested_mode" ]]; then
			# An explicit selection is the only safe way to resolve a legacy install
			# whose URLs and overlay disagree (including the historical stale-overlay bug).
			existing_mode="$requested_mode"
		else
			die "Cannot safely infer the legacy data-service mode because its URLs and local overlay disagree; rerun with an explicit NEARZERO_DATA_MODE=local or NEARZERO_DATA_MODE=external"
		fi
	fi

	if [[ -n "$requested_mode" ]]; then
		NEARZERO_DATA_MODE="$requested_mode"
	elif [[ "$supplied_url_pair" == "1" ]]; then
		if [[ "$existing_mode" == "local" ]]; then
			die "Switching a local install to external services requires NEARZERO_DATA_MODE=external together with both URLs"
		fi
		NEARZERO_DATA_MODE="external"
	elif [[ -n "$existing_mode" ]]; then
		NEARZERO_DATA_MODE="$existing_mode"
	else
		NEARZERO_DATA_MODE="local"
	fi

	if [[ "$NEARZERO_DATA_MODE" == "local" ]]; then
		if [[ "$supplied_url_pair" == "1" ]]; then
			die "DATABASE_URL and REDIS_URL cannot be supplied with NEARZERO_DATA_MODE=local; unset them before switching"
		fi
		USE_LOCAL_SERVICES=1
		return
	fi

	USE_LOCAL_SERVICES=0
	if [[ "$supplied_url_pair" == "0" && "$existing_mode" != "external" ]]; then
		die "NEARZERO_DATA_MODE=external requires both DATABASE_URL and REDIS_URL when entering external mode"
	fi
}

generate_install_setup_token() {
	# High-entropy token for the browser wizard. Only the SHA-256 hash is persisted.
	if command -v openssl >/dev/null 2>&1; then
		INSTALL_SETUP_TOKEN_PLAINTEXT="$(openssl rand -base64 48 | tr -d '\n=/+' | head -c 43)"
	else
		INSTALL_SETUP_TOKEN_PLAINTEXT="$(tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 43)"
	fi
	if [[ ${#INSTALL_SETUP_TOKEN_PLAINTEXT} -lt 32 ]]; then
		die "Failed to generate a secure install setup token"
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		NEARZERO_INSTALL_SETUP_TOKEN_HASH="$(printf '%s' "$INSTALL_SETUP_TOKEN_PLAINTEXT" | sha256sum | awk '{print $1}')"
	elif command -v shasum >/dev/null 2>&1; then
		NEARZERO_INSTALL_SETUP_TOKEN_HASH="$(printf '%s' "$INSTALL_SETUP_TOKEN_PLAINTEXT" | shasum -a 256 | awk '{print $1}')"
	else
		die "sha256sum or shasum is required to hash the install setup token"
	fi
	NEARZERO_INSTALL_SETUP_TOKEN_HASH_WAS_SET=1
}

configure_first_run() {
	validate_boolean "NEARZERO_NONINTERACTIVE" "$NEARZERO_NONINTERACTIVE"
	if [[ -e "$INSTALL_DIR/.env" ]]; then
		return
	fi
	NEARZERO_REGISTRATION_MODE="$(normalize_registration_mode "$NEARZERO_REGISTRATION_MODE")"
	if ! can_prompt; then
		log "Non-interactive first run; using supplied environment variables and safe defaults"
		# Browser wizard token is generated when domains/admin are deferred to the UI.
		if [[ -z "$NEARZERO_MANAGEMENT_HOSTNAME" && -z "$NEARZERO_ADMIN_EMAIL" && -z "$NEARZERO_INSTALL_SETUP_TOKEN_HASH" ]]; then
			generate_install_setup_token
		fi
		return
	fi
	INTERACTIVE_FIRST_RUN=1

	log "First-run infrastructure choices"
	if [[ "$NEARZERO_ENABLE_MANAGED_DNS_WAS_SET" == "0" ]]; then
		local enable_dns_answer="Y"
		prompt_value_with_default enable_dns_answer \
			"Enable Nearzero managed DNS on UDP/TCP 53? [Y/n]" \
			"Y"
		case "${enable_dns_answer,,}" in
			n|no|false|0) NEARZERO_ENABLE_MANAGED_DNS=false ;;
			*) NEARZERO_ENABLE_MANAGED_DNS=true ;;
		esac
		NEARZERO_ENABLE_MANAGED_DNS_WAS_SET=1
	fi

	# Domain hostnames and admin email are collected in the browser wizard when
	# the operator did not already supply them. Keep non-empty env overrides.
	if [[ "$NEARZERO_MANAGEMENT_HOSTNAME_WAS_SET" == "1" && -n "$NEARZERO_MANAGEMENT_HOSTNAME" ]]; then
		NEARZERO_MANAGEMENT_HOSTNAME="$(normalize_management_hostname "$NEARZERO_MANAGEMENT_HOSTNAME")"
	else
		NEARZERO_MANAGEMENT_HOSTNAME=""
		NEARZERO_MANAGEMENT_HOSTNAME_WAS_SET=0
	fi
	if is_enabled "$NEARZERO_ENABLE_MANAGED_DNS"; then
		if [[ "$NEARZERO_MANAGED_DNS_ZONE_WAS_SET" == "1" && -n "$NEARZERO_MANAGED_DNS_ZONE" ]]; then
			NEARZERO_MANAGED_DNS_ZONE="$(normalize_managed_dns_zone "$NEARZERO_MANAGED_DNS_ZONE")"
		else
			NEARZERO_MANAGED_DNS_ZONE=""
			NEARZERO_MANAGED_DNS_ZONE_WAS_SET=0
		fi
	else
		NEARZERO_MANAGED_DNS_ZONE=""
	fi
	if [[ "$NEARZERO_ADMIN_EMAIL_WAS_SET" == "1" && -n "$NEARZERO_ADMIN_EMAIL" ]]; then
		NEARZERO_ADMIN_EMAIL="$(normalize_admin_email "$NEARZERO_ADMIN_EMAIL")"
	else
		NEARZERO_ADMIN_EMAIL=""
		NEARZERO_ADMIN_EMAIL_WAS_SET=0
	fi
	if [[ "$NEARZERO_MANAGED_DNS_SOA_EMAIL_WAS_SET" == "0" && -n "$NEARZERO_ADMIN_EMAIL" ]]; then
		NEARZERO_MANAGED_DNS_SOA_EMAIL="$NEARZERO_ADMIN_EMAIL"
		NEARZERO_MANAGED_DNS_SOA_EMAIL_WAS_SET=1
	fi

	if [[ -z "$NEARZERO_MANAGEMENT_HOSTNAME" || -z "$NEARZERO_ADMIN_EMAIL" ]]; then
		if [[ -z "$NEARZERO_INSTALL_SETUP_TOKEN_HASH" ]]; then
			generate_install_setup_token
			log "Browser setup will collect the management hostname and administrator email"
		fi
	fi
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

validate_ipv4_address() {
	local name="$1"
	local value="$2"
	[[ -z "$value" ]] && return
	if [[ ! "$value" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
		die "$name must be one IPv4 address"
	fi
	local octet
	local octets=()
	IFS='.' read -r -a octets <<< "$value"
	for octet in "${octets[@]}"; do
		if (( 10#$octet > 255 )); then
			die "$name contains an invalid IPv4 octet"
		fi
	done
}

validate_public_ipv4_address() {
	local name="$1"
	local value="$2"
	local a b c d
	validate_ipv4_address "$name" "$value"
	IFS='.' read -r a b c d <<< "$value"
	if ((
		10#$a == 0 ||
		10#$a == 10 ||
		(10#$a == 100 && 10#$b >= 64 && 10#$b <= 127) ||
		10#$a == 127 ||
		(10#$a == 169 && 10#$b == 254) ||
		(10#$a == 172 && 10#$b >= 16 && 10#$b <= 31) ||
		(10#$a == 192 && 10#$b == 0 && (10#$c == 0 || 10#$c == 2)) ||
		(10#$a == 192 && 10#$b == 88 && 10#$c == 99) ||
		(10#$a == 192 && 10#$b == 168) ||
		(10#$a == 198 && (10#$b == 18 || 10#$b == 19)) ||
		(10#$a == 198 && 10#$b == 51 && 10#$c == 100) ||
		(10#$a == 203 && 10#$b == 0 && 10#$c == 113) ||
		10#$a >= 224
	)); then
		die "$name must be a publicly routable IPv4 address; private, shared, loopback, link-local, documentation, benchmark, multicast, and reserved ranges are not accepted"
	fi
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

url_matches_generated_host_port() {
	local value="${1%/}"
	local port="$2"
	local public_ip="$3"
	local private_ip="$4"
	local previous_public_ip="${5:-}"
	[[ -n "$value" ]] || return 1
	[[ -n "$public_ip" && "$value" == "$(url_from_host "$public_ip" "$port")" ]] && return 0
	[[ -n "$previous_public_ip" && "$value" == "$(url_from_host "$previous_public_ip" "$port")" ]] && return 0
	[[ -n "$private_ip" && "$value" == "$(url_from_host "$private_ip" "$port")" ]] && return 0
	[[ "$value" == "http://127.0.0.1:${port}" || "$value" == "http://localhost:${port}" ]]
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
	write_file "$INSTALL_DIR/docker-compose.prod.yml" 0644 <<'YAML'
name: nearzero

services:
  dns-init:
    image: ${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.43}
    profiles: ["managed-dns"]
    entrypoint: ["bun", "/app/dns-init.ts"]
    environment:
      NEARZERO_ADMIN_EMAIL: ${NEARZERO_ADMIN_EMAIL:-}
      NEARZERO_MANAGEMENT_HOSTNAME: ${NEARZERO_MANAGEMENT_HOSTNAME:-}
      NEARZERO_MANAGED_DNS_ZONE: ${NEARZERO_MANAGED_DNS_ZONE:-}
      NEARZERO_MANAGED_DNS_SOA_EMAIL: ${NEARZERO_MANAGED_DNS_SOA_EMAIL:-}
      NEARZERO_PUBLIC_IP: ${NEARZERO_PUBLIC_IP:-}
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
    image: ${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.43}
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      REDIS_URL: ${REDIS_URL:?REDIS_URL is required}
      NEARZERO_METRICS_URL: ${NEARZERO_METRICS_URL:-http://monitoring:${NEARZERO_METRICS_PORT:-4500}/metrics}
      NEARZERO_METRICS_TOKEN: ${NEARZERO_METRICS_TOKEN:?NEARZERO_METRICS_TOKEN is required}
      NEARZERO_METRICS_PORT: ${NEARZERO_METRICS_PORT:-4500}
      NEARZERO_MONITORING_IMAGE: ${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:0.1.43}
      NEARZERO_ADMIN_EMAIL: ${NEARZERO_ADMIN_EMAIL:-}
      NEARZERO_REGISTRATION_MODE: ${NEARZERO_REGISTRATION_MODE:-bootstrap}
      NEARZERO_INSTALL_SETUP_TOKEN_HASH: ${NEARZERO_INSTALL_SETUP_TOKEN_HASH:-}
      NEARZERO_ENABLE_MANAGED_DNS: ${NEARZERO_ENABLE_MANAGED_DNS:-true}
      NEARZERO_MANAGEMENT_HOSTNAME: ${NEARZERO_MANAGEMENT_HOSTNAME:-}
      NEARZERO_MANAGED_DNS_ZONE: ${NEARZERO_MANAGED_DNS_ZONE:-}
      NEARZERO_MANAGED_DNS_SOA_EMAIL: ${NEARZERO_MANAGED_DNS_SOA_EMAIL:-}
      NEARZERO_PUBLIC_IP: ${NEARZERO_PUBLIC_IP:-}
      NEARZERO_PLATFORM_DOMAIN: ${NEARZERO_PLATFORM_DOMAIN:-}
      NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE: ${NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE:-false}
    ports:
      - "${NEARZERO_MANAGEMENT_BIND_ADDRESS:-127.0.0.1}:${NEARZERO_PLATFORM_PORT:-3000}:3000"
      - "${NEARZERO_MANAGEMENT_BIND_ADDRESS:-127.0.0.1}:${NEARZERO_CONSOLE_PORT:-4321}:4321"
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
    image: ${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:0.1.43}
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
    image: ${NEARZERO_SCHEDULE_IMAGE:-ghcr.io/nearzero-systems/schedule:0.1.43}
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
	write_file "$INSTALL_DIR/docker-compose.local-db.yml" 0644 <<'YAML'
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
    restart: unless-stopped

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
    restart: unless-stopped

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

sync_data_service_overlay() {
	local overlay="$INSTALL_DIR/docker-compose.local-db.yml"
	if [[ "$NEARZERO_DATA_MODE" == "local" ]]; then
		write_compose_local_db
		return
	fi
	if installed_file_exists "$overlay"; then
		log "External data mode selected; removing the local Postgres/Redis Compose overlay"
		if [[ "$DRY_RUN" == "1" ]]; then
			rm -f "$overlay"
		else
			"${SUDO[@]}" rm -f "$overlay"
		fi
	fi
}

write_env() {
	local host private_ip console_url platform_url desired_console_url postgres_password auth_secret local_redis_url metrics_token trusted_origins preserved_custom_env
	local better_auth_url git_provider_base_url platform_domain compose_profiles management_hostname managed_dns_zone managed_dns_soa_email
	local public_ip admin_email registration_mode install_setup_token_hash
	local platform_domain_shared_edge jobs_url api_key
	local existing_auth_secret existing_postgres_password existing_metrics_token existing_database_url existing_redis_url
	local existing_console_url existing_platform_url existing_better_auth_url existing_git_provider_base_url existing_trusted_origins
	local existing_public_ip existing_management_hostname existing_managed_dns_zone existing_managed_dns_soa_email existing_admin_email existing_registration_mode
	local existing_platform_domain existing_compose_profiles existing_enable_managed_dns existing_dns_bind_address existing_dns_port existing_management_bind_address
	local existing_allow_monitoring_docker_metadata existing_platform_domain_shared_edge existing_jobs_url existing_api_key
	local existing_traefik_image existing_traefik_socket_proxy_image existing_ssh_strict_host_key_checking
	local existing_heroku_builder_image existing_paketo_builder_image existing_railpack_frontend_image existing_static_nginx_image
	local existing_nearzero_image existing_monitoring_image existing_schedule_image existing_dns_image
	local existing_postgres_user existing_postgres_db existing_platform_port existing_console_port existing_metrics_port
	local existing_metrics_refresh_seconds existing_metrics_retention_days existing_metrics_cron existing_startup_timeout_seconds
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
	existing_public_ip="$(existing_env_value NEARZERO_PUBLIC_IP)"
	existing_management_hostname="$(existing_env_value NEARZERO_MANAGEMENT_HOSTNAME)"
	existing_managed_dns_zone="$(existing_env_value NEARZERO_MANAGED_DNS_ZONE)"
	existing_managed_dns_soa_email="$(existing_env_value NEARZERO_MANAGED_DNS_SOA_EMAIL)"
	existing_admin_email="$(existing_env_value NEARZERO_ADMIN_EMAIL)"
	existing_registration_mode="$(existing_env_value NEARZERO_REGISTRATION_MODE)"
	existing_platform_domain="$(existing_env_value NEARZERO_PLATFORM_DOMAIN)"
	existing_platform_domain_shared_edge="$(existing_env_value NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE)"
	existing_compose_profiles="$(existing_env_value COMPOSE_PROFILES)"
	existing_enable_managed_dns="$(existing_env_value NEARZERO_ENABLE_MANAGED_DNS)"
	existing_dns_bind_address="$(existing_env_value NEARZERO_DNS_BIND_ADDRESS)"
	existing_dns_port="$(existing_env_value NEARZERO_DNS_PORT)"
	existing_management_bind_address="$(existing_env_value NEARZERO_MANAGEMENT_BIND_ADDRESS)"
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
	existing_nearzero_image="$(existing_env_value NEARZERO_IMAGE)"
	existing_monitoring_image="$(existing_env_value NEARZERO_MONITORING_IMAGE)"
	existing_schedule_image="$(existing_env_value NEARZERO_SCHEDULE_IMAGE)"
	existing_dns_image="$(existing_env_value NEARZERO_DNS_IMAGE)"
	existing_postgres_user="$(existing_env_value POSTGRES_USER)"
	existing_postgres_db="$(existing_env_value POSTGRES_DB)"
	existing_platform_port="$(existing_env_value NEARZERO_PLATFORM_PORT)"
	existing_console_port="$(existing_env_value NEARZERO_CONSOLE_PORT)"
	existing_metrics_port="$(existing_env_value NEARZERO_METRICS_PORT)"
	existing_metrics_refresh_seconds="$(existing_env_value NEARZERO_METRICS_REFRESH_SECONDS)"
	existing_metrics_retention_days="$(existing_env_value NEARZERO_METRICS_RETENTION_DAYS)"
	existing_metrics_cron="$(existing_env_value NEARZERO_METRICS_CRON)"
	existing_startup_timeout_seconds="$(existing_env_value NEARZERO_STARTUP_TIMEOUT_SECONDS)"

	if [[ "$NEARZERO_IMAGE_WAS_SET" == "0" && -n "$existing_nearzero_image" ]]; then NEARZERO_IMAGE="$existing_nearzero_image"; fi
	if [[ "$NEARZERO_MONITORING_IMAGE_WAS_SET" == "0" && -n "$existing_monitoring_image" ]]; then NEARZERO_MONITORING_IMAGE="$existing_monitoring_image"; fi
	if [[ "$NEARZERO_SCHEDULE_IMAGE_WAS_SET" == "0" && -n "$existing_schedule_image" ]]; then NEARZERO_SCHEDULE_IMAGE="$existing_schedule_image"; fi
	if [[ "$NEARZERO_DNS_IMAGE_WAS_SET" == "0" && -n "$existing_dns_image" ]]; then NEARZERO_DNS_IMAGE="$existing_dns_image"; fi
	if [[ "$POSTGRES_USER_WAS_SET" == "0" && -n "$existing_postgres_user" ]]; then POSTGRES_USER="$existing_postgres_user"; fi
	if [[ "$POSTGRES_DB_WAS_SET" == "0" && -n "$existing_postgres_db" ]]; then POSTGRES_DB="$existing_postgres_db"; fi
	if [[ "$NEARZERO_PLATFORM_PORT_WAS_SET" == "0" && -n "$existing_platform_port" ]]; then NEARZERO_PLATFORM_PORT="$existing_platform_port"; fi
	if [[ "$NEARZERO_CONSOLE_PORT_WAS_SET" == "0" && -n "$existing_console_port" ]]; then NEARZERO_CONSOLE_PORT="$existing_console_port"; fi
	if [[ "$NEARZERO_METRICS_PORT_WAS_SET" == "0" && -n "$existing_metrics_port" ]]; then NEARZERO_METRICS_PORT="$existing_metrics_port"; fi
	if [[ "$NEARZERO_METRICS_REFRESH_SECONDS_WAS_SET" == "0" && -n "$existing_metrics_refresh_seconds" ]]; then NEARZERO_METRICS_REFRESH_SECONDS="$existing_metrics_refresh_seconds"; fi
	if [[ "$NEARZERO_METRICS_RETENTION_DAYS_WAS_SET" == "0" && -n "$existing_metrics_retention_days" ]]; then NEARZERO_METRICS_RETENTION_DAYS="$existing_metrics_retention_days"; fi
	if [[ "$NEARZERO_METRICS_CRON_WAS_SET" == "0" && -n "$existing_metrics_cron" ]]; then
		NEARZERO_METRICS_CRON="$existing_metrics_cron"
		if [[ "$NEARZERO_METRICS_CRON" == \"*\" ]]; then
			NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON#\"}"
			NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON%\"}"
		fi
	fi
	if [[ "$NEARZERO_STARTUP_TIMEOUT_SECONDS_WAS_SET" == "0" && -n "$existing_startup_timeout_seconds" ]]; then NEARZERO_STARTUP_TIMEOUT_SECONDS="$existing_startup_timeout_seconds"; fi

	if [[ "$NEARZERO_PUBLIC_IP_WAS_SET" == "1" ]]; then
		public_ip="$NEARZERO_PUBLIC_IP"
	else
		public_ip="${existing_public_ip:-$(detect_public_ip)}"
	fi
	validate_ipv4_address "NEARZERO_PUBLIC_IP" "$public_ip"
	if [[ "$NEARZERO_MANAGEMENT_HOSTNAME_WAS_SET" == "1" ]]; then
		management_hostname="$(normalize_management_hostname "$NEARZERO_MANAGEMENT_HOSTNAME")"
	else
		management_hostname="$(normalize_management_hostname "$existing_management_hostname")"
	fi
	if installed_file_exists "$INSTALL_DIR/.env" && [[ "$NEARZERO_MANAGEMENT_HOSTNAME_WAS_SET" == "1" ]] &&
		[[ "$management_hostname" != "$(normalize_management_hostname "$existing_management_hostname")" ]]; then
		die "Changing NEARZERO_MANAGEMENT_HOSTNAME on an installed control plane requires a migration workflow and is not supported by a rerun"
	fi
	if [[ "$NEARZERO_MANAGED_DNS_ZONE_WAS_SET" == "1" ]]; then
		managed_dns_zone="$(normalize_managed_dns_zone "$NEARZERO_MANAGED_DNS_ZONE")"
	else
		managed_dns_zone="$(normalize_managed_dns_zone "$existing_managed_dns_zone")"
	fi
	if installed_file_exists "$INSTALL_DIR/.env" && [[ "$NEARZERO_MANAGED_DNS_ZONE_WAS_SET" == "1" ]] &&
		[[ "$managed_dns_zone" != "$(normalize_managed_dns_zone "$existing_managed_dns_zone")" ]]; then
		die "Changing NEARZERO_MANAGED_DNS_ZONE on an installed control plane requires a migration workflow and is not supported by a rerun"
	fi
	if [[ "$NEARZERO_MANAGED_DNS_SOA_EMAIL_WAS_SET" == "1" ]]; then
		managed_dns_soa_email="$(normalize_managed_dns_soa_email "$NEARZERO_MANAGED_DNS_SOA_EMAIL")"
	else
		managed_dns_soa_email="$(normalize_managed_dns_soa_email "$existing_managed_dns_soa_email")"
	fi
	if [[ "$NEARZERO_ADMIN_EMAIL_WAS_SET" == "1" ]]; then
		admin_email="$(normalize_admin_email "$NEARZERO_ADMIN_EMAIL")"
	else
		admin_email="$(normalize_admin_email "${existing_admin_email:-$managed_dns_soa_email}")"
	fi
	if [[ ( -n "$management_hostname" || -n "$managed_dns_zone" ) && -z "$managed_dns_soa_email" && -n "$admin_email" ]]; then
		managed_dns_soa_email="$admin_email"
	fi
	if [[ ( -n "$management_hostname" || -n "$managed_dns_zone" ) && -z "$managed_dns_soa_email" ]]; then
		die "NEARZERO_MANAGED_DNS_SOA_EMAIL or NEARZERO_ADMIN_EMAIL is required as the SOA/ACME contact when public management or managed DNS is configured"
	fi
	if [[ "$NEARZERO_REGISTRATION_MODE_WAS_SET" == "1" ]]; then
		registration_mode="$(normalize_registration_mode "$NEARZERO_REGISTRATION_MODE")"
	elif [[ -n "$existing_registration_mode" ]]; then
		registration_mode="$(normalize_registration_mode "$existing_registration_mode")"
	elif [[ -e "$INSTALL_DIR/.env" ]]; then
		# Installations created before registration modes existed were open. Keep
		# that behavior until the operator deliberately selects a safer mode.
		registration_mode="open"
	else
		registration_mode="bootstrap"
	fi
	if [[ "$NEARZERO_INSTALL_SETUP_TOKEN_HASH_WAS_SET" == "1" ]]; then
		install_setup_token_hash="$(printf '%s' "$NEARZERO_INSTALL_SETUP_TOKEN_HASH" | tr '[:upper:]' '[:lower:]')"
	else
		install_setup_token_hash="$(existing_env_value NEARZERO_INSTALL_SETUP_TOKEN_HASH | tr '[:upper:]' '[:lower:]')"
	fi
	if [[ -n "$install_setup_token_hash" && ! "$install_setup_token_hash" =~ ^[a-f0-9]{64}$ ]]; then
		die "NEARZERO_INSTALL_SETUP_TOKEN_HASH must be a 64-character lowercase hex SHA-256 digest"
	fi
	if [[ "$registration_mode" == "bootstrap" && -z "$admin_email" && -z "$install_setup_token_hash" ]]; then
		die "NEARZERO_ADMIN_EMAIL is required when NEARZERO_REGISTRATION_MODE=bootstrap unless a browser setup token hash is configured"
	fi
	if ! installed_file_exists "$INSTALL_DIR/.env" && [[ "$registration_mode" == "invite_only" ]]; then
		die "NEARZERO_REGISTRATION_MODE=invite_only cannot be used on a first installer run because ownership has not been established; use bootstrap"
	fi
	if [[ ( -n "$management_hostname" || -n "$managed_dns_zone" ) && -z "$public_ip" ]]; then
		die "NEARZERO_PUBLIC_IP is required when configuring public management or managed DNS; automatic public-IP detection failed"
	fi
	if [[ -n "$management_hostname" || -n "$managed_dns_zone" ]]; then
		validate_public_ipv4_address "NEARZERO_PUBLIC_IP" "$public_ip"
	fi
	if [[ -n "$management_hostname" && "$CONSOLE_URL_WAS_SET" == "1" && "${CONSOLE_URL%/}" != "https://${management_hostname}" ]]; then
		die "CONSOLE_URL must be https://${management_hostname} when NEARZERO_MANAGEMENT_HOSTNAME is set"
	fi

	private_ip="$(detect_private_ip)"
	host="${NEARZERO_DOMAIN:-${public_ip:-${private_ip:-127.0.0.1}}}"
	if [[ -n "$management_hostname" ]]; then
		desired_console_url="https://${management_hostname}"
	elif [[ "$NEARZERO_MANAGEMENT_BIND_ADDRESS" == "127.0.0.1" ]]; then
		desired_console_url="http://127.0.0.1:${NEARZERO_CONSOLE_PORT}"
	else
		desired_console_url="$(url_from_host "$host" "$NEARZERO_CONSOLE_PORT")"
	fi
	if [[ "$CONSOLE_URL_WAS_SET" == "1" ]]; then
		console_url="${CONSOLE_URL%/}"
	elif [[ -n "$management_hostname" ]]; then
		console_url="$desired_console_url"
	elif [[ "$NEARZERO_MANAGEMENT_BIND_ADDRESS" == "127.0.0.1" ]] &&
		{ [[ -z "$existing_console_url" ]] || url_matches_generated_host_port "$existing_console_url" "$NEARZERO_CONSOLE_PORT" "$public_ip" "$private_ip" "$existing_public_ip"; }; then
		console_url="$desired_console_url"
	else
		console_url="${existing_console_url:-$desired_console_url}"
	fi
	if [[ "$PUBLIC_BACKEND_URL_WAS_SET" == "1" ]]; then
		[[ -n "$PUBLIC_BACKEND_URL" ]] || die "PUBLIC_BACKEND_URL must not be empty when explicitly supplied"
		platform_url="${PUBLIC_BACKEND_URL%/}"
	elif [[ -n "$management_hostname" || "$NEARZERO_MANAGEMENT_BIND_ADDRESS" == "127.0.0.1" ]]; then
		if [[ -z "$existing_platform_url" || "${existing_platform_url%/}" == "${existing_console_url%/}" ]] ||
			{ [[ "$NEARZERO_MANAGEMENT_BIND_ADDRESS" == "127.0.0.1" ]] && url_matches_generated_host_port "$existing_platform_url" "$NEARZERO_PLATFORM_PORT" "$public_ip" "$private_ip" "$existing_public_ip"; }; then
			platform_url="$console_url"
		else
			platform_url="${existing_platform_url%/}"
		fi
	else
		platform_url="${existing_platform_url:-$(url_from_host "$host" "$NEARZERO_PLATFORM_PORT")}"
	fi
	if [[ "$BETTER_AUTH_URL_WAS_SET" == "1" ]]; then
		better_auth_url="${BETTER_AUTH_URL%/}"
	elif [[ -n "$management_hostname" || "$NEARZERO_MANAGEMENT_BIND_ADDRESS" == "127.0.0.1" || "$CONSOLE_URL_WAS_SET" == "1" ]]; then
		if [[ -z "$existing_better_auth_url" || "${existing_better_auth_url%/}" == "${existing_console_url%/}" ]] ||
			url_matches_generated_host_port "$existing_better_auth_url" "$NEARZERO_CONSOLE_PORT" "$public_ip" "$private_ip" "$existing_public_ip"; then
			better_auth_url="$console_url"
		else
			better_auth_url="${existing_better_auth_url%/}"
		fi
	else
		better_auth_url="${existing_better_auth_url:-$console_url}"
	fi
	if [[ "$PUBLIC_GIT_PROVIDER_BASE_URL_WAS_SET" == "1" ]]; then
		git_provider_base_url="${PUBLIC_GIT_PROVIDER_BASE_URL%/}"
	elif [[ -n "$management_hostname" || "$NEARZERO_MANAGEMENT_BIND_ADDRESS" == "127.0.0.1" || "$CONSOLE_URL_WAS_SET" == "1" ]]; then
		if [[ -z "$existing_git_provider_base_url" || "${existing_git_provider_base_url%/}" == "${existing_console_url%/}" ]] ||
			url_matches_generated_host_port "$existing_git_provider_base_url" "$NEARZERO_CONSOLE_PORT" "$public_ip" "$private_ip" "$existing_public_ip"; then
			git_provider_base_url="$console_url"
		else
			git_provider_base_url="${existing_git_provider_base_url%/}"
		fi
	else
		git_provider_base_url="${existing_git_provider_base_url:-$console_url}"
	fi
	if [[ "$NEARZERO_TRUSTED_ORIGINS_WAS_SET" == "1" ]]; then
		trusted_origins="$NEARZERO_TRUSTED_ORIGINS"
	elif [[ "$NEARZERO_MANAGEMENT_HOSTNAME_WAS_SET" == "1" || "$CONSOLE_URL_WAS_SET" == "1" ]]; then
		trusted_origins="$(append_origin_if_new "$(collect_trusted_origins "$host" "$private_ip")" "$console_url")"
	else
		trusted_origins="${existing_trusted_origins:-$(append_origin_if_new "$(collect_trusted_origins "$host" "$private_ip")" "$console_url")}"
	fi
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
	if [[ "$NEARZERO_MANAGEMENT_BIND_ADDRESS_WAS_SET" == "0" && -n "$existing_management_bind_address" ]]; then
		NEARZERO_MANAGEMENT_BIND_ADDRESS="$existing_management_bind_address"
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
	if [[ -n "$managed_dns_zone" && "$NEARZERO_ENABLE_MANAGED_DNS" != "true" ]]; then
		die "NEARZERO_MANAGED_DNS_ZONE requires NEARZERO_ENABLE_MANAGED_DNS=true; clear the zone and SOA email explicitly before disabling managed DNS"
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
		REDIS_URL="redis://redis:6379"
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
	validate_ipv4_address "NEARZERO_MANAGEMENT_BIND_ADDRESS" "$NEARZERO_MANAGEMENT_BIND_ADDRESS"
	validate_positive_integer "NEARZERO_METRICS_REFRESH_SECONDS" "$NEARZERO_METRICS_REFRESH_SECONDS"
	validate_positive_integer "NEARZERO_METRICS_RETENTION_DAYS" "$NEARZERO_METRICS_RETENTION_DAYS"
	validate_positive_integer "NEARZERO_STARTUP_TIMEOUT_SECONDS" "$NEARZERO_STARTUP_TIMEOUT_SECONDS"
	validate_dotenv_quoted_value "NEARZERO_METRICS_CRON" "$NEARZERO_METRICS_CRON"

	for env_name in \
		NEARZERO_IMAGE \
		NEARZERO_MONITORING_IMAGE \
		NEARZERO_SCHEDULE_IMAGE \
		NEARZERO_DNS_IMAGE \
		NEARZERO_DNS_BIND_ADDRESS \
		NEARZERO_MANAGEMENT_BIND_ADDRESS \
		POSTGRES_USER \
		POSTGRES_DB; do
		validate_dotenv_unquoted_value "$env_name" "${!env_name}"
	done
	validate_dotenv_unquoted_value "COMPOSE_PROFILES" "$compose_profiles"
	validate_dotenv_unquoted_value "NEARZERO_PUBLIC_IP" "$public_ip"
	validate_dotenv_unquoted_value "NEARZERO_MANAGEMENT_HOSTNAME" "$management_hostname"
	validate_dotenv_unquoted_value "NEARZERO_MANAGED_DNS_ZONE" "$managed_dns_zone"
	validate_dotenv_unquoted_value "NEARZERO_MANAGED_DNS_SOA_EMAIL" "$managed_dns_soa_email"
	validate_dotenv_unquoted_value "NEARZERO_ADMIN_EMAIL" "$admin_email"
	validate_dotenv_unquoted_value "NEARZERO_REGISTRATION_MODE" "$registration_mode"
	validate_dotenv_unquoted_value "NEARZERO_INSTALL_SETUP_TOKEN_HASH" "$install_setup_token_hash"
	validate_dotenv_unquoted_value "NEARZERO_DATA_MODE" "$NEARZERO_DATA_MODE"
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
	if ! preserved_custom_env="$(preserved_custom_env_assignments)"; then
		die "Existing .env contains a malformed or duplicate assignment; fix it before rerunning the installer"
	fi

	write_file "$INSTALL_DIR/.env" 0600 <<EOF
COMPOSE_PROFILES=${compose_profiles}
NEARZERO_IMAGE=${NEARZERO_IMAGE}
NEARZERO_MONITORING_IMAGE=${NEARZERO_MONITORING_IMAGE}
NEARZERO_SCHEDULE_IMAGE=${NEARZERO_SCHEDULE_IMAGE}
NEARZERO_DNS_IMAGE=${NEARZERO_DNS_IMAGE}
NEARZERO_ENABLE_MANAGED_DNS=${NEARZERO_ENABLE_MANAGED_DNS}
NEARZERO_DNS_BIND_ADDRESS=${NEARZERO_DNS_BIND_ADDRESS}
NEARZERO_DNS_PORT=${NEARZERO_DNS_PORT}
NEARZERO_PUBLIC_IP=${public_ip}
NEARZERO_MANAGEMENT_HOSTNAME=${management_hostname}
NEARZERO_MANAGED_DNS_ZONE=${managed_dns_zone}
NEARZERO_MANAGED_DNS_SOA_EMAIL=${managed_dns_soa_email}
NEARZERO_ADMIN_EMAIL=${admin_email}
NEARZERO_REGISTRATION_MODE=${registration_mode}
NEARZERO_INSTALL_SETUP_TOKEN_HASH=${install_setup_token_hash}
NEARZERO_DATA_MODE=${NEARZERO_DATA_MODE}
NEARZERO_PLATFORM_DOMAIN=${platform_domain}
NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE=${platform_domain_shared_edge}
NEARZERO_MANAGEMENT_BIND_ADDRESS=${NEARZERO_MANAGEMENT_BIND_ADDRESS}
NEARZERO_PLATFORM_PORT=${NEARZERO_PLATFORM_PORT}
NEARZERO_CONSOLE_PORT=${NEARZERO_CONSOLE_PORT}
NEARZERO_METRICS_PORT=${NEARZERO_METRICS_PORT}
NEARZERO_METRICS_REFRESH_SECONDS=${NEARZERO_METRICS_REFRESH_SECONDS}
NEARZERO_METRICS_RETENTION_DAYS=${NEARZERO_METRICS_RETENTION_DAYS}
NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON}"
NEARZERO_STARTUP_TIMEOUT_SECONDS=${NEARZERO_STARTUP_TIMEOUT_SECONDS}
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
${preserved_custom_env}
EOF
}

confirm_first_run_configuration() {
	[[ "$INTERACTIVE_FIRST_RUN" == "1" ]] || return 0
	local management_hostname managed_dns_zone public_ip admin_email registration_mode data_mode console_url bind_address management_url answer
	management_hostname="$(existing_env_value NEARZERO_MANAGEMENT_HOSTNAME)"
	managed_dns_zone="$(existing_env_value NEARZERO_MANAGED_DNS_ZONE)"
	public_ip="$(existing_env_value NEARZERO_PUBLIC_IP)"
	admin_email="$(existing_env_value NEARZERO_ADMIN_EMAIL)"
	registration_mode="$(existing_env_value NEARZERO_REGISTRATION_MODE)"
	data_mode="$(existing_env_value NEARZERO_DATA_MODE)"
	console_url="$(existing_env_value CONSOLE_URL)"
	bind_address="$(existing_env_value NEARZERO_MANAGEMENT_BIND_ADDRESS)"
	if [[ -n "$management_hostname" ]]; then
		management_url="$console_url"
	else
		management_url="http://127.0.0.1:${NEARZERO_CONSOLE_PORT} through SSH/VPN"
	fi

	log "Confirm first-run configuration:"
	log "  Management URL: ${management_url}"
	log "  Managed application zone: ${managed_dns_zone:-not configured}"
	log "  Server public IPv4: ${public_ip:-not detected}"
	log "  First-owner/admin email: ${admin_email:-not configured}"
	log "  Registration mode: ${registration_mode}"
	log "  Data services: ${data_mode}"
	if [[ "$bind_address" == "127.0.0.1" ]]; then
		log "  Raw management ports: loopback-only on ${NEARZERO_PLATFORM_PORT} and ${NEARZERO_CONSOLE_PORT}"
	else
		log "  Raw management ports: ${bind_address}:${NEARZERO_PLATFORM_PORT} and ${bind_address}:${NEARZERO_CONSOLE_PORT} (explicit override; firewall from the public Internet)"
	fi
	while true; do
		prompt_value answer "Continue with these values? [Y/n]: "
		case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
		"" | y | yes) return ;;
		n | no)
			if [[ "$DRY_RUN" == "1" ]]; then
				rm -f "$INSTALL_DIR/.env" "$INSTALL_DIR/docker-compose.prod.yml" "$INSTALL_DIR/docker-compose.local-db.yml"
			else
				"${SUDO[@]}" rm -f "$INSTALL_DIR/.env" "$INSTALL_DIR/docker-compose.prod.yml" "$INSTALL_DIR/docker-compose.local-db.yml"
			fi
			die "Installation cancelled before Docker changes; rerun the installer to enter corrected values"
			;;
		*) log "Enter yes or no." ;;
		esac
	done
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
	write_file "$helper_path" 0755 <<'HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/nearzero}"
umask 077
COMPOSE=(-f "$INSTALL_DIR/docker-compose.prod.yml")

installed_env_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key { sub(/^[^=]*=/, ""); value = $0; count++ }
		END { if (count != 1) exit 1; print value }
	' "$INSTALL_DIR/.env"
}

if ! DATA_MODE="$(installed_env_value NEARZERO_DATA_MODE)"; then
	echo "missing or duplicate NEARZERO_DATA_MODE in $INSTALL_DIR/.env; rerun the installer" >&2
	exit 1
fi
case "$DATA_MODE" in
	local)
		if [[ ! -f "$INSTALL_DIR/docker-compose.local-db.yml" ]]; then
			echo "local data mode is missing docker-compose.local-db.yml; rerun the installer" >&2
			exit 1
		fi
		COMPOSE+=(-f "$INSTALL_DIR/docker-compose.local-db.yml")
		;;
	external) ;;
	*)
		echo "invalid or missing NEARZERO_DATA_MODE in $INSTALL_DIR/.env; rerun the installer" >&2
		exit 1
		;;
esac
if ! POSTGRES_USER="$(installed_env_value POSTGRES_USER)"; then
	echo "missing or duplicate POSTGRES_USER in $INSTALL_DIR/.env; rerun the installer" >&2
	exit 1
fi
if ! POSTGRES_DB="$(installed_env_value POSTGRES_DB)"; then
	echo "missing or duplicate POSTGRES_DB in $INSTALL_DIR/.env; rerun the installer" >&2
	exit 1
fi
case "$POSTGRES_USER" in
	"" | *[!A-Za-z0-9_.-]*) echo "invalid POSTGRES_USER in $INSTALL_DIR/.env; rerun the installer" >&2; exit 1 ;;
esac
case "$POSTGRES_DB" in
	"" | *[!A-Za-z0-9_.-]*) echo "invalid POSTGRES_DB in $INSTALL_DIR/.env; rerun the installer" >&2; exit 1 ;;
esac

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
		docker_compose up -d --remove-orphans
		;;
	backup-db)
		if [[ "$DATA_MODE" != "local" ]]; then
			echo "backup-db only supports the local Postgres install" >&2
			exit 1
		fi
		out="${2:-$INSTALL_DIR/nearzero-db-$(date +%Y%m%d-%H%M%S).sql}"
		out_dir="$(dirname -- "$out")"
		out_base="$(basename -- "$out")"
		[[ -d "$out_dir" ]] || { echo "backup destination directory does not exist: $out_dir" >&2; exit 1; }
		tmp="$(mktemp "$out_dir/.${out_base}.tmp.XXXXXX")"
		trap 'rm -f -- "$tmp"' EXIT
		trap 'exit 1' HUP INT TERM
		if ! docker_compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "$tmp"; then
			echo "database backup failed; no destination file was replaced" >&2
			exit 1
		fi
		chmod 0600 "$tmp"
		mv -f -- "$tmp" "$out"
		tmp=""
		trap - EXIT HUP INT TERM
		printf '%s\n' "$out"
		;;
	restore-db)
		if [[ "$DATA_MODE" != "local" ]]; then
			echo "restore-db only supports the local Postgres install" >&2
			exit 1
		fi
		file="${2:?usage: nearzero restore-db dump.sql}"
		[[ -f "$file" && -r "$file" ]] || { echo "restore input is not a readable file: $file" >&2; exit 1; }
		docker_compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" < "$file"
		;;
	*)
		echo "usage: nearzero {status|logs|restart|update|backup-db|restore-db}" >&2
		exit 1
		;;
esac
HELPER
}

start_stack() {
	local compose_args=(-f "$INSTALL_DIR/docker-compose.prod.yml")
	local compose_command=("${SUDO[@]}" docker compose "${compose_args[@]}" --env-file "$INSTALL_DIR/.env")
	if [[ "$USE_LOCAL_SERVICES" == "1" ]]; then
		compose_args+=(-f "$INSTALL_DIR/docker-compose.local-db.yml")
		compose_command=("${SUDO[@]}" docker compose "${compose_args[@]}" --env-file "$INSTALL_DIR/.env")
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
	"${compose_command[@]}" pull
	log "Starting Nearzero and waiting up to ${NEARZERO_STARTUP_TIMEOUT_SECONDS}s for readiness..."
	if "${compose_command[@]}" up --help 2>/dev/null | grep -q -- '--wait-timeout'; then
		if ! "${compose_command[@]}" up -d --force-recreate --wait --wait-timeout "$NEARZERO_STARTUP_TIMEOUT_SECONDS" --remove-orphans; then
			log "Startup failed. Current service state:"
			"${compose_command[@]}" ps --all >&2 || true
			log "Recent service logs:"
			"${compose_command[@]}" logs --no-color --tail 100 >&2 || true
			die "Nearzero did not become ready; fix the reported service error and rerun the installer"
		fi
		return
	fi

	"${compose_command[@]}" up -d --force-recreate --remove-orphans
	local services=(platform monitoring)
	if [[ "$USE_LOCAL_SERVICES" == "1" ]]; then
		services+=(postgres redis)
	fi
	if is_enabled "$NEARZERO_ENABLE_MANAGED_DNS"; then
		services+=(dns)
	fi
	if csv_contains "$(existing_env_value COMPOSE_PROFILES)" "schedules"; then
		services+=(schedules)
	fi
	local deadline=$((SECONDS + NEARZERO_STARTUP_TIMEOUT_SECONDS))
	local service container_id state status health all_ready
	while (( SECONDS < deadline )); do
		all_ready=1
		for service in "${services[@]}"; do
			container_id="$("${compose_command[@]}" ps --all --quiet "$service" 2>/dev/null | head -n 1 || true)"
			if [[ -z "$container_id" ]]; then
				all_ready=0
				continue
			fi
			state="$("${SUDO[@]}" docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
			status="${state%% *}"
			health="${state#* }"
			if [[ "$status" == "exited" || "$status" == "dead" ]]; then
				all_ready=0
				break 2
			fi
			if [[ "$status" != "running" || ( "$health" != "healthy" && "$health" != "none" ) ]]; then
				all_ready=0
			fi
		done
		if [[ "$all_ready" == "1" ]]; then
			return
		fi
		sleep 2
	done

	log "Startup readiness timed out. Current service state:"
	"${compose_command[@]}" ps --all >&2 || true
	log "Recent service logs:"
	"${compose_command[@]}" logs --no-color --tail 100 >&2 || true
	die "Nearzero did not become ready within ${NEARZERO_STARTUP_TIMEOUT_SECONDS}s; fix the reported service error and rerun the installer"
}

hostname_is_in_zone() {
	local hostname="$1"
	local zone="$2"
	[[ -n "$hostname" && -n "$zone" ]] &&
		[[ "$hostname" == "$zone" || "$hostname" == *."$zone" ]]
}

print_next_steps() {
	local management_hostname managed_dns_zone public_ip admin_email registration_mode console_url access_url setup_token_hash
	management_hostname="$(existing_env_value NEARZERO_MANAGEMENT_HOSTNAME)"
	managed_dns_zone="$(existing_env_value NEARZERO_MANAGED_DNS_ZONE)"
	public_ip="$(existing_env_value NEARZERO_PUBLIC_IP)"
	admin_email="$(existing_env_value NEARZERO_ADMIN_EMAIL)"
	registration_mode="$(existing_env_value NEARZERO_REGISTRATION_MODE)"
	setup_token_hash="$(existing_env_value NEARZERO_INSTALL_SETUP_TOKEN_HASH)"
	console_url="$(existing_env_value CONSOLE_URL)"
	if [[ -n "$management_hostname" ]]; then
		access_url="$console_url"
	else
		access_url="http://127.0.0.1:${NEARZERO_CONSOLE_PORT} (through the SSH/VPN path above)"
	fi

	if [[ -n "$INSTALL_SETUP_TOKEN_PLAINTEXT" || ( -n "$setup_token_hash" && -z "$management_hostname" ) ]]; then
		log "Next steps (one-time browser setup):"
		log "  1. Keep raw ports ${NEARZERO_PLATFORM_PORT} and ${NEARZERO_CONSOLE_PORT} private."
		log "     - Open an SSH tunnel: ssh -L ${NEARZERO_CONSOLE_PORT}:127.0.0.1:${NEARZERO_CONSOLE_PORT} <user>@<server>"
		if [[ -n "$INSTALL_SETUP_TOKEN_PLAINTEXT" ]]; then
			log "  2. Open the setup wizard once:"
			log "     http://127.0.0.1:${NEARZERO_CONSOLE_PORT}/setup#token=${INSTALL_SETUP_TOKEN_PLAINTEXT}"
			log "     This token is shown only now. It is not stored in plaintext."
		else
			log "  2. Open http://127.0.0.1:${NEARZERO_CONSOLE_PORT}/setup with the operator setup token generated at install time."
		fi
		log "  3. In the wizard, set the management hostname (required) and optional application zone, then create DNS A/NS records."
		log "  4. Create the first owner account with the administrator email configured in the wizard."
		log "  5. Run 'nearzero status', test externally, and create a protected backup before the first production deployment."
		return
	fi

	log "Next steps (the management hostname and application DNS zone are separate):"
	log "  1. Finish DNS and firewall setup."
	if [[ -n "$management_hostname" ]]; then
		if hostname_is_in_zone "$management_hostname" "$managed_dns_zone"; then
			log "     - The bootstrap zone already contains ${management_hostname} A ${public_ip}; complete the application-zone delegation below before opening the console."
		else
			log "     - Create ${management_hostname} A ${public_ip} at its current DNS provider."
		fi
		log "     - Allow public TCP 80 and 443 for Nearzero-managed HTTPS. Keep raw ports ${NEARZERO_PLATFORM_PORT} and ${NEARZERO_CONSOLE_PORT} private."
	else
		log "     - Keep raw ports ${NEARZERO_PLATFORM_PORT} and ${NEARZERO_CONSOLE_PORT} private. Use an SSH/VPN path for first login, for example: ssh -L ${NEARZERO_CONSOLE_PORT}:127.0.0.1:${NEARZERO_CONSOLE_PORT} <user>@<server>"
	fi
	if [[ -n "$managed_dns_zone" ]]; then
		log "     - Allow TCP and UDP 53, then delegate ${managed_dns_zone} to ns1.${managed_dns_zone} and ns2.${managed_dns_zone}; point both nameserver glue/A records to ${public_ip}."
	fi

	log "  2. Claim the first owner account."
	if [[ "$registration_mode" == "bootstrap" ]]; then
		log "     - Open ${access_url} and register exactly ${admin_email}. After that claim, registration becomes invite-only."
	elif [[ "$registration_mode" == "invite_only" ]]; then
		log "     - Registration is invite-only; use an existing owner or invitation to open ${access_url}."
	else
		log "     - Registration is open at ${access_url}; change NEARZERO_REGISTRATION_MODE after creating the intended owners."
	fi

	if [[ -n "$managed_dns_zone" ]]; then
		log "  3. In Settings -> DNS, review ${managed_dns_zone} and verify public delegation/authoritative answers. New projects inherit it automatically; bind it under Project -> Domains only for existing or other environments."
	else
		log "  3. Add a dedicated application zone in Settings -> DNS before requesting Nearzero-managed hostnames."
	fi
	log "  4. Run 'nearzero status', test externally, and create a protected backup before the first production deployment."
}

main() {
	print_banner
	ensure_sudo
	announce_install
	configure_first_run
	resolve_data_mode
	run_sudo mkdir -p "$INSTALL_DIR"
	write_compose_base
	write_env
	sync_data_service_overlay
	if [[ "$NEARZERO_DATA_MODE" == "external" ]]; then
		log "Using external database and Redis services"
	fi
	confirm_first_run_configuration
	prepare_monitoring_storage
	write_helper
	ensure_docker
	ensure_docker_compose
	start_stack
	log "Installed Nearzero in $INSTALL_DIR"
	print_next_steps
}

main "$@"
