#!/usr/bin/env bash
# Remove Nearzero and everything it deployed from this server:
#
#   curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash
#
# Add `-s -- --yes` after `bash` to skip the confirmation in scripts.
set -Euo pipefail

INSTALL_URL="https://cdn.nearzero.dev/install.sh"
UNINSTALL_URL="https://cdn.nearzero.dev/uninstall.sh"
ASSUME_YES=0

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
	STYLE_BOLD=$'\033[1m'
	STYLE_GREEN=$'\033[32m'
	STYLE_RED=$'\033[31m'
	STYLE_RESET=$'\033[0m'
else
	STYLE_BOLD=""
	STYLE_GREEN=""
	STYLE_RED=""
	STYLE_RESET=""
fi

log() {
	printf '  %s\n' "$*"
}

step_done() {
	printf '  %s✓%s %s\n' "$STYLE_GREEN" "$STYLE_RESET" "$*"
}

die() {
	printf '\n  %s✗ %s%s\n\n' "$STYLE_RED" "$*" "$STYLE_RESET" >&2
	exit 1
}

usage() {
	cat <<USAGE
usage: curl -fsSL $UNINSTALL_URL | sudo bash [-s -- --yes]

Removes the Nearzero control plane, every app, database and Compose project it
deployed, their volumes and data, unused Docker images and build cache,
/opt/nearzero, /etc/nearzero and the nearzero command. Docker stays installed.

  -y, --yes   do not ask for confirmation
USAGE
}

parse_args() {
	local arg
	for arg in "$@"; do
		case "$arg" in
			-y | --yes) ASSUME_YES=1 ;;
			-h | --help)
				usage
				exit 0
				;;
			*) die "Unknown option: $arg (see --help)" ;;
		esac
	done
	case "$(printf '%s' "${NEARZERO_UNINSTALL_YES:-}" | tr '[:upper:]' '[:lower:]')" in
		1 | true | yes) ASSUME_YES=1 ;;
	esac
}

# The script arrives on stdin (`curl ... | sudo bash`), so ask on /dev/tty.
confirm() {
	local answer=""
	[[ "$ASSUME_YES" == "1" ]] && return 0
	if ! (exec </dev/tty) 2>/dev/null; then
		die "No terminal to confirm on, so nothing was removed. To remove without asking, run: curl -fsSL $UNINSTALL_URL | sudo bash -s -- --yes"
	fi
	{
		printf '\n  %sThis deletes Nearzero and everything it deployed on this server.%s\n' "$STYLE_BOLD" "$STYLE_RESET"
		printf '  Apps, databases and their data, every unused Docker volume and image,\n'
		printf '  /opt/nearzero and /etc/nearzero. Docker stays installed. This cannot be undone.\n\n'
		printf '  Remove Nearzero? [y/N] '
	} >/dev/tty
	IFS= read -r answer </dev/tty || answer=""
	printf '\n' >/dev/tty
	case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
		y | yes) ;;
		*) die "Cancelled. Nothing was removed." ;;
	esac
}

remove_containers() {
	docker ps -aq --filter label=com.docker.compose.project=nearzero | xargs -r docker rm -f >/dev/null 2>&1
	docker rm -f nearzero-traefik nearzero-docker-proxy nearzero-monitoring nearzero-dns >/dev/null 2>&1 || true
	step_done "Stopped Nearzero"

	if [[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" == "active" ]]; then
		docker service ls -q | xargs -r docker service rm >/dev/null 2>&1
		docker swarm leave --force >/dev/null 2>&1 || true
	fi
	docker ps -aq --filter label=com.docker.swarm.service.id | xargs -r docker rm -f >/dev/null 2>&1
	local project
	for project in $(docker ps -a --format '{{.Label "com.docker.compose.project"}} {{.Label "com.docker.compose.project.working_dir"}}' |
		awk '$2 ~ "^/etc/nearzero/compose/" { print $1 }' | sort -u); do
		docker ps -aq --filter "label=com.docker.compose.project=${project}" | xargs -r docker rm -f >/dev/null 2>&1
	done
	step_done "Removed the apps and databases it deployed"
}

remove_docker_data() {
	docker network rm nearzero-network nearzero-traefik-control >/dev/null 2>&1 || true
	docker network prune --force >/dev/null 2>&1 || true
	docker volume prune --all --force >/dev/null 2>&1 || docker volume prune --force >/dev/null 2>&1 || true
	step_done "Deleted networks and volumes"
	docker image prune --all --force >/dev/null 2>&1 || true
	docker builder prune --all --force >/dev/null 2>&1 || true
	step_done "Deleted unused images and build cache"
}

report_leftovers() {
	local containers volumes
	command -v docker >/dev/null 2>&1 || return 0
	containers="$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')"
	volumes="$(docker volume ls -q 2>/dev/null | wc -l | tr -d ' ')"
	if [[ "$containers" != "0" || "$volumes" != "0" ]]; then
		log "Still on this server and not Nearzero's: ${containers} container(s), ${volumes} volume(s)."
		log "See them with: docker ps -a && docker volume ls"
		printf '\n'
	fi
}

main() {
	parse_args "$@"
	[[ "$(id -u)" == "0" ]] || die "Run it with sudo: curl -fsSL $UNINSTALL_URL | sudo bash"
	confirm

	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
		remove_containers
		remove_docker_data
	else
		log "Docker is not running here; removing the Nearzero files only."
	fi
	rm -rf /opt/nearzero /etc/nearzero /usr/local/bin/nearzero
	step_done "Deleted /opt/nearzero, /etc/nearzero and the nearzero command"

	printf '\n  %s%sNearzero is removed.%s\n\n' "$STYLE_BOLD" "$STYLE_GREEN" "$STYLE_RESET"
	report_leftovers
	log "Install it again with:"
	log "  curl -fsSL $INSTALL_URL | sudo bash"
	printf '\n'
}

main "$@"
