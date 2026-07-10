#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR_INPUT="${INSTALL_DIR:-}"
if [[ "${DRY_RUN:-}" == "1" && -z "$INSTALL_DIR_INPUT" ]]; then
	INSTALL_DIR="/tmp/nearzero-dry-run"
else
	INSTALL_DIR="${INSTALL_DIR_INPUT:-/opt/nearzero}"
fi

NEARZERO_IMAGE="${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.16}"
NEARZERO_MONITORING_IMAGE="${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:latest}"
NEARZERO_PLATFORM_PORT="${NEARZERO_PLATFORM_PORT:-3000}"
NEARZERO_CONSOLE_PORT="${NEARZERO_CONSOLE_PORT:-4321}"
NEARZERO_METRICS_PORT="${NEARZERO_METRICS_PORT:-4500}"
NEARZERO_METRICS_REFRESH_SECONDS="${NEARZERO_METRICS_REFRESH_SECONDS:-5}"
NEARZERO_METRICS_RETENTION_DAYS="${NEARZERO_METRICS_RETENTION_DAYS:-2}"
NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON:-0 0 * * *}"
NEARZERO_METRICS_TOKEN="${NEARZERO_METRICS_TOKEN:-}"
POSTGRES_USER="${POSTGRES_USER:-nearzero}"
POSTGRES_DB="${POSTGRES_DB:-nearzero}"
REDIS_URL="${REDIS_URL:-}"
DATABASE_URL="${DATABASE_URL:-}"
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
	log "Installing Docker with get.docker.com"
	curl -fsSL https://get.docker.com -o /tmp/nearzero-get-docker.sh
	run_sudo sh /tmp/nearzero-get-docker.sh
	rm -f /tmp/nearzero-get-docker.sh
}

ensure_docker_compose() {
	if [[ "$DRY_RUN" == "1" ]]; then
		return
	fi
	if ! "${SUDO[@]}" docker compose version >/dev/null 2>&1; then
		die "Docker Compose plugin is required"
	fi
}

write_compose_base() {
	write_file "$INSTALL_DIR/docker-compose.prod.yml" <<'YAML'
name: nearzero

services:
  platform:
    image: ${NEARZERO_IMAGE:-ghcr.io/nearzero-systems/nearzero:0.1.16}
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      REDIS_URL: ${REDIS_URL:?REDIS_URL is required}
      NEARZERO_METRICS_URL: ${NEARZERO_METRICS_URL:-http://monitoring:${NEARZERO_METRICS_PORT:-4500}/metrics}
      NEARZERO_METRICS_TOKEN: ${NEARZERO_METRICS_TOKEN:?NEARZERO_METRICS_TOKEN is required}
      NEARZERO_METRICS_PORT: ${NEARZERO_METRICS_PORT:-4500}
      NEARZERO_MONITORING_IMAGE: ${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:latest}
    ports:
      - "${NEARZERO_PLATFORM_PORT:-3000}:3000"
      - "${NEARZERO_CONSOLE_PORT:-4321}:4321"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - nearzero-data:/etc/nearzero
    depends_on:
      monitoring:
        condition: service_healthy
    restart: unless-stopped

  monitoring:
    container_name: nearzero-monitoring
    image: ${NEARZERO_MONITORING_IMAGE:-ghcr.io/nearzero-systems/monitoring:latest}
    environment:
      METRICS_CONFIG: '{"server":{"type":"Nearzero","refreshRate":${NEARZERO_METRICS_REFRESH_SECONDS:-5},"port":${NEARZERO_METRICS_PORT:-4500},"token":"${NEARZERO_METRICS_TOKEN:?NEARZERO_METRICS_TOKEN is required}","urlCallback":"${NEARZERO_METRICS_CALLBACK_URL:-http://platform:3000/api/trpc/notification.receiveNotification}","retentionDays":${NEARZERO_METRICS_RETENTION_DAYS:-2},"cronJob":"${NEARZERO_METRICS_CRON:-0 0 * * *}","thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":${NEARZERO_METRICS_REFRESH_SECONDS:-5},"services":{"include":[],"exclude":[]}}}'
      HOST_PROC: /host/proc
      HOST_SYS: /host/sys
      NEARZERO_HOST_ROOT: /host/root
    ports:
      - "127.0.0.1:${NEARZERO_METRICS_PORT:-4500}:${NEARZERO_METRICS_PORT:-4500}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /:/host/root:ro
      - /sys:/host/sys:ro
      - /etc/os-release:/etc/os-release:ro
      - /proc:/host/proc:ro
      - /etc/nearzero/monitoring/monitoring.db:/app/monitoring.db
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${NEARZERO_METRICS_PORT:-4500}/health >/dev/null 2>&1"]
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  schedules:
    image: ${NEARZERO_SCHEDULE_IMAGE:-ghcr.io/nearzero-systems/schedule:latest}
    profiles: ["schedules"]
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      REDIS_URL: ${REDIS_URL:?REDIS_URL is required}
    restart: unless-stopped

volumes:
  nearzero-data:
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
	local existing_auth_secret existing_postgres_password existing_metrics_token existing_database_url existing_redis_url
	host="$(detect_host)"
	private_ip="$(detect_private_ip)"
	console_url="${CONSOLE_URL:-$(url_from_host "$host" "$NEARZERO_CONSOLE_PORT")}"
	platform_url="${PUBLIC_BACKEND_URL:-$(url_from_host "$host" "$NEARZERO_PLATFORM_PORT")}"
	trusted_origins="${NEARZERO_TRUSTED_ORIGINS:-$(collect_trusted_origins "$host" "$private_ip")}"
	existing_auth_secret="$(existing_env_value BETTER_AUTH_SECRET)"
	existing_postgres_password="$(existing_env_value POSTGRES_PASSWORD)"
	existing_metrics_token="$(existing_env_value NEARZERO_METRICS_TOKEN)"
	existing_database_url="$(existing_env_value DATABASE_URL)"
	existing_redis_url="$(existing_env_value REDIS_URL)"
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
	local_redis_url="${REDIS_URL:-redis://redis:6379}"

	write_file "$INSTALL_DIR/.env" <<EOF
NEARZERO_IMAGE=${NEARZERO_IMAGE}
NEARZERO_MONITORING_IMAGE=${NEARZERO_MONITORING_IMAGE}
NEARZERO_PLATFORM_PORT=${NEARZERO_PLATFORM_PORT}
NEARZERO_CONSOLE_PORT=${NEARZERO_CONSOLE_PORT}
NEARZERO_METRICS_PORT=${NEARZERO_METRICS_PORT}
NEARZERO_METRICS_REFRESH_SECONDS=${NEARZERO_METRICS_REFRESH_SECONDS}
NEARZERO_METRICS_RETENTION_DAYS=${NEARZERO_METRICS_RETENTION_DAYS}
NEARZERO_METRICS_CRON="${NEARZERO_METRICS_CRON}"
NEARZERO_METRICS_TOKEN=${metrics_token}
NEARZERO_METRICS_URL=http://monitoring:${NEARZERO_METRICS_PORT}/metrics
NEARZERO_METRICS_CALLBACK_URL=http://platform:3000/api/trpc/notification.receiveNotification

DATABASE_URL=${DATABASE_URL}
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${postgres_password}
POSTGRES_DB=${POSTGRES_DB}

REDIS_URL=${local_redis_url}

PORT=3000
HOST=0.0.0.0
NODE_ENV=production

BETTER_AUTH_URL=${BETTER_AUTH_URL:-$console_url}
BETTER_AUTH_SECRET=${auth_secret}
CONSOLE_URL=${console_url}
BACKEND_URL=http://platform:3000
PUBLIC_BACKEND_URL=${platform_url}
PUBLIC_GIT_PROVIDER_BASE_URL=${PUBLIC_GIT_PROVIDER_BASE_URL:-$console_url}
NEARZERO_TRUSTED_ORIGINS=${trusted_origins}
EOF
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
