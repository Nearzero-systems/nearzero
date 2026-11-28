#!/usr/bin/env bash
#
# Nearzero uninstaller (spec 03 3.3). Removes Nearzero and everything it deployed on this server.
#
#   curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash
#   curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash -s -- --yes     (no question)
#   NEARZERO_UNINSTALL_YES=true works like --yes.
#
# Nearzero's folder is /opt/nearzero, or the one the installed nearzero command names when it was
# installed with NEARZERO_INSTALL_DIR (or INSTALL_DIR); either setting names it here too.
#
# It removes only what Nearzero 1.0 created: containers, volumes, networks and images carrying the
# label dev.nearzero.edition=1 (or belonging to its Compose project, nearzero1), the images the installer
# downloaded and those the runner recorded pulling for builds (buildpacks), Nearzero's build
# cache, its files and its command. On the Nearzero host and on servers set up from it alike.
# Database dumps made with `nearzero backup-db` are kept, and the last lines say where. Anything
# else is left alone.
#
# It stops before removing anything when Docker is installed but not running (Nearzero's
# containers would come back when it starts), or when Nearzero 0.1.x is still on the server
# (its containers would keep running with their files gone), and says what to run.
#
# Nothing runs until the last line calls main, so a download cut short runs nothing.

set -o pipefail

NZU_COMMAND_URL="curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash"
NZU_DIR="/opt/nearzero"
NZU_ETC="/etc/nearzero"
NZU_BIN="/usr/local/bin/nearzero"
# The installer's link for sudo's secure_path (RHEL, Amazon Linux).
NZU_BIN_LINK="/usr/bin/nearzero"
NZU_RUNNER_BIN="/usr/local/bin/nearzero-runner"
# What server setup puts on a server besides /etc/nearzero (apps/control/src/server-setup).
NZU_RUNNER_STATE_DIR="/var/lib/nearzero-runner"
NZU_SETUP_DIR="/var/lib/nearzero"
NZU_LIB_DIR="/usr/local/lib/nearzero"
NZU_RUNNER_LOG="/var/log/nearzero-runner.log"
NZU_RUNNER_PID="/run/nearzero-runner.pid"
# Where database dumps in $NZU_DIR are kept (spec 03 3.3: back up first, then uninstall).
NZU_KEEP_DIR="/var/backups/nearzero"
# 0.1.x's own uninstaller, at the versioned address the final 0.1.x release publishes it at with
# a .sha256 beside it (spec 31 "0.1.x's own scripts", 31d R4-02): 1.0 owns the root address.
NZU_LEGACY_RELEASE_URL="https://cdn.nearzero.dev/releases/0.1.80"
NZU_LEGACY_UNINSTALL="curl -fsSL $NZU_LEGACY_RELEASE_URL/uninstall.sh | sudo bash"
# 1.0's own label and project (spec 29.5 "No shared names with 0.1.x"): a 0.1.x install's things
# on the same server never carry them.
NZU_LABEL="dev.nearzero.edition=1"
NZU_PROJECT_LABEL="com.docker.compose.project=nearzero1"
# The buildx builder Railpack builds use (its BuildKit container and cache carry the label).
NZU_BUILDER="nearzero-railpack"
NZU_MARK_OK="✓"

nzu_say() { printf '%s\n' "$*"; }

# Whether a folder holds Nearzero's files: a settings file with Nearzero's settings, or 1.0's
# compose file. Only such a folder is ever deleted in place of /opt/nearzero (B2-26).
nzu_nearzero_folder() {
  grep -q '^NEARZERO_[A-Z0-9_]*=' "$1/.env" 2>/dev/null && return 0
  grep -qx 'name: nearzero1' "$1/compose.yml" 2>/dev/null
}

# The install folder: NEARZERO_INSTALL_DIR or INSTALL_DIR when given, else the folder the
# installed command was written for (its NZC_DIR line), else /opt/nearzero.
nzu_choose_dir() {
  local dir="${NEARZERO_INSTALL_DIR:-${INSTALL_DIR:-}}" given=1
  if [ -z "$dir" ]; then
    given=0
    dir=$(sed -n 's/^NZC_DIR="\${NEARZERO_INSTALL_DIR:-\(\/[^"}]*\)}"$/\1/p' "$NZU_BIN" 2>/dev/null | head -n 1)
  fi
  [ -n "$dir" ] || return 0
  while [ "${#dir}" -gt 1 ] && [ "${dir%/}" != "$dir" ]; do dir="${dir%/}"; done
  local plain=1
  case "$dir/" in
    /[!/]*) ;;
    *) plain=0 ;;
  esac
  case "$dir/" in
    */./* | */../* | *//* | *[!A-Za-z0-9._/-]*) plain=0 ;;
  esac
  if [ "$plain" = 1 ] && { [ ! -e "$dir" ] || nzu_nearzero_folder "$dir"; }; then
    NZU_DIR="$dir"
    return 0
  fi
  [ "$given" = 1 ] || return 0
  [ "$plain" = 1 ] || nzu_die "NEARZERO_INSTALL_DIR must be a plain absolute folder path such as $NZU_DIR, so nothing was removed."
  nzu_die "NEARZERO_INSTALL_DIR names $dir, which doesn't hold Nearzero's files (.env or compose.yml), so nothing was removed." \
    "Name the folder Nearzero was installed in, or leave the setting out."
}

nzu_die() {
  local line
  for line in "$@"; do printf '%s\n' "$line" >&2; done
  exit 1
}

nzu_has() { command -v "$1" >/dev/null 2>&1; }

nzu_docker() { nzu_has docker && docker info >/dev/null 2>&1; }

# IDs of Docker objects of one kind with Nearzero's label or in its Compose project.
nzu_ids() {
  local kind="$1"
  case "$kind" in
    container)
      {
        docker ps -aq --filter "label=$NZU_LABEL"
        docker ps -aq --filter "label=$NZU_PROJECT_LABEL"
      } 2>/dev/null | sort -u
      ;;
    volume)
      {
        docker volume ls -q --filter "label=$NZU_LABEL"
        docker volume ls -q --filter "label=$NZU_PROJECT_LABEL"
      } 2>/dev/null | sort -u
      ;;
    network)
      {
        docker network ls -q --filter "label=$NZU_LABEL"
        docker network ls -q --filter "label=$NZU_PROJECT_LABEL"
      } 2>/dev/null | sort -u
      ;;
    image)
      docker image ls -q --filter "label=$NZU_LABEL" 2>/dev/null | sort -u
      ;;
  esac
}

nzu_anything_installed() {
  local path
  for path in "$NZU_DIR" "$NZU_ETC" "$NZU_BIN" "$NZU_RUNNER_BIN" "$NZU_RUNNER_STATE_DIR" "$NZU_LIB_DIR"; do
    [ -e "$path" ] && return 0
  done
  if nzu_docker; then
    [ -n "$(nzu_ids container)$(nzu_ids volume)$(nzu_ids network)" ] && return 0
  fi
  return 1
}

nzu_confirm() {
  local answer
  if ! (exec 3</dev/tty) 2>/dev/null; then
    nzu_die "No terminal to confirm on, so nothing was removed." \
      "To remove Nearzero without the question, run: $NZU_COMMAND_URL -s -- --yes"
  fi
  printf '%s\n' \
    "This deletes Nearzero and everything it deployed on this server: the control plane and its" \
    "database, the router, monitoring and DNS, every app, Compose project and database with their" \
    "volumes and data, and $NZU_DIR. This cannot be undone." >/dev/tty
  printf 'Remove Nearzero? [y/N] ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  case "$answer" in
    y | Y | yes | Yes | YES) return 0 ;;
  esac
  nzu_say "Nothing was removed."
  exit 1
}

# What of Nearzero 0.1.x is still on this server, in words, or nothing (spec 29.5; R4-02): a move
# that isn't finalized, a 0.1.x settings file, or a container or Swarm service named nearzero…
# without 1.0's labels (1.0's containers, and every one its runner creates, carry them).
nzu_legacy_install() {
  local state version name managed component
  state=$(cut -d' ' -f1 "$NZU_DIR/migration/state" 2>/dev/null)
  # After `migrate rollback` the server runs 0.1.x again, with its own command back; finalize and
  # rollback can't run any more (C2-19), so 0.1.x is named as itself.
  if [ "$state" = rolled-back ]; then
    printf 'Nearzero 0.1.x, which this server went back to with migrate rollback\n'
    return 0
  fi
  if [ -n "$state" ] && [ "$state" != finalized ]; then
    printf 'a move from 0.1.x that is not finalized (%s)\n' "$state"
    return 0
  fi
  version=$(sed -n 's/^[[:space:]]*NEARZERO_VERSION=//p' "$NZU_DIR/.env" 2>/dev/null | tail -n 1 | tr -d '\r"'"'")
  case "$version" in
    0.1.*)
      printf 'Nearzero %s\n' "$version"
      return 0
      ;;
  esac
  nzu_has docker || return 0
  while IFS='|' read -r name managed component; do
    case "$name" in nearzero*) ;; *) continue ;; esac
    if [ -z "$managed" ] && [ -z "$component" ]; then
      printf 'the container %s\n' "$name"
      return 0
    fi
  done < <(docker ps -a --format '{{.Names}}|{{.Label "dev.nearzero.managed"}}|{{.Label "dev.nearzero.component"}}' 2>/dev/null)
  while read -r name; do
    case "$name" in
      nearzero*)
        printf 'the Swarm service %s\n' "$name"
        return 0
        ;;
    esac
  done < <(docker service ls --format '{{.Name}}' 2>/dev/null)
  return 0
}

nzu_stop_runner() {
  if nzu_has systemctl && [ -d /run/systemd/system ]; then
    if systemctl list-unit-files nearzero-runner.service >/dev/null 2>&1 &&
      systemctl cat nearzero-runner.service >/dev/null 2>&1; then
      systemctl disable --now nearzero-runner.service >/dev/null 2>&1
    fi
    if [ -f /etc/systemd/system/nearzero-runner.service ]; then
      rm -f /etc/systemd/system/nearzero-runner.service
      systemctl daemon-reload >/dev/null 2>&1
    fi
  fi
  if [ -f /etc/init.d/nearzero-runner ]; then
    rc-service nearzero-runner stop >/dev/null 2>&1
    rc-update del nearzero-runner >/dev/null 2>&1
    rm -f /etc/init.d/nearzero-runner
  fi
  # A server with no init system: setup started the runner with nohup and kept its pid (B2-12).
  # It is stopped before anything else goes, or it would put the router and network back.
  nzu_stop_pid "$(cat "$NZU_RUNNER_PID" 2>/dev/null)"
  rm -f "$NZU_RUNNER_PID"
  local pid args
  while read -r pid args; do
    case "$args" in
      "$NZU_RUNNER_BIN"* | *" $NZU_RUNNER_BIN"* | "$NZU_LIB_DIR/runner-launch"* | *" $NZU_LIB_DIR/runner-launch"*)
        nzu_stop_pid "$pid"
        ;;
    esac
  done < <(ps -e -o pid= -o args= 2>/dev/null)
  rm -f "$NZU_RUNNER_BIN"
}

# Stops one process: TERM, then KILL after 10 seconds.
nzu_stop_pid() {
  local pid="$1" waited=0
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  [ "$pid" != "$$" ] || return 0
  kill "$pid" 2>/dev/null || return 0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null
  return 0
}

# Moves the database dumps `nearzero backup-db` left in $NZU_DIR out of the way (B2-08).
NZU_KEPT_BACKUPS=""

nzu_keep_backups() {
  local dump
  for dump in "$NZU_DIR"/nearzero-db-*.sql; do
    [ -f "$dump" ] || continue
    if [ -z "$NZU_KEPT_BACKUPS" ]; then
      mkdir -p "$NZU_KEEP_DIR" && chmod 0700 "$NZU_KEEP_DIR" || return 1
    fi
    mv -f "$dump" "$NZU_KEEP_DIR/" || return 1
    NZU_KEPT_BACKUPS="$NZU_KEPT_BACKUPS $NZU_KEEP_DIR/${dump##*/}"
  done
  return 0
}

# Nearzero's files, on the host and on servers set up from it (B2-23).
nzu_remove_files() {
  rm -rf "$NZU_DIR" "$NZU_ETC" "$NZU_RUNNER_STATE_DIR" "$NZU_SETUP_DIR" "$NZU_LIB_DIR"
  rm -f "$NZU_BIN" "$NZU_RUNNER_BIN" "$NZU_RUNNER_LOG" "$NZU_RUNNER_PID"
  if [ -L "$NZU_BIN_LINK" ] && [ "$(readlink "$NZU_BIN_LINK")" = "$NZU_BIN" ]; then
    rm -f "$NZU_BIN_LINK"
  fi
}

# The Compose projects of the stacks Nearzero deployed here, from its labelled containers and
# volumes: their networks (<project>_default and any a stack declares) carry only Compose's own
# labels, so they are found by project (C2-13). Read before the containers go.
nzu_stack_projects() {
  {
    docker ps -a --filter "label=$NZU_LABEL" --format '{{.Label "com.docker.compose.project"}}'
    docker volume ls --filter "label=$NZU_LABEL" --format '{{.Label "com.docker.compose.project"}}'
  } 2>/dev/null | sed '/^$/d' | grep -vx 'nearzero1' | sort -u
}

nzu_remove_docker_objects() {
  local ids projects project
  projects=$(nzu_stack_projects)
  if [ -f "$NZU_DIR/compose.yml" ] && [ -f "$NZU_DIR/.env" ]; then
    docker compose --project-directory "$NZU_DIR" --file "$NZU_DIR/compose.yml" \
      --env-file "$NZU_DIR/.env" --profile '*' down --volumes --timeout 30 >/dev/null 2>&1
  fi
  ids=$(nzu_ids container)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker rm --force --volumes $ids >/dev/null 2>&1
  ids=$(nzu_ids volume)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker volume rm --force $ids >/dev/null 2>&1
  ids=$(nzu_ids network)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1
  # The stacks' own networks; Docker refuses one something else still uses, which stays.
  for project in $projects; do
    ids=$(docker network ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null)
    # shellcheck disable=SC2086
    [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1
  done
  if docker buildx inspect "$NZU_BUILDER" >/dev/null 2>&1; then
    docker buildx rm --force "$NZU_BUILDER" >/dev/null 2>&1
  fi
}

# Docker's own builder keeps the cache of Dockerfile, Nixpacks and static builds without any
# label saying whose builds they were, so it can't be told from the person's own: it is left, and
# said so with its size and the command that empties it (spec 03 3.3 "lists anything else it
# left", C2-12). Railpack's builder, which is Nearzero's own, is removed above.
nzu_build_cache_note() {
  local size
  nzu_docker || return 0
  size=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | sed -n 's/^Build Cache //p' | head -n 1)
  case "$size" in '' | 0 | 0B) return 0 ;; esac
  nzu_say "Docker's build cache ($size) was kept: it holds the cache of Nearzero's Dockerfile and"
  nzu_say "Nixpacks builds together with any of your own, which can't be told apart. Empty it with:"
  nzu_say "  docker builder prune"
}

# Images the host's runner pulled for builds that can't carry Nearzero's label (the buildpacks'
# builder and run images, which pack uses by name). The runner lists them in pulled-images in
# its work folder, inside its state volume; read before the volumes go.
NZU_RUNNER_STATE_VOLUME="nearzero-runner-state"
NZU_RUNNER_PULLED=""

nzu_read_runner_pulled() {
  local mount file
  mount=$(docker volume inspect --format '{{.Mountpoint}}' "$NZU_RUNNER_STATE_VOLUME" 2>/dev/null)
  # On the host, the runner's work folder is in its volume; on a server, in its state folder.
  for file in "${mount:+$mount/work/pulled-images}" "$NZU_RUNNER_STATE_DIR/work/pulled-images"; do
    [ -n "$file" ] && [ -r "$file" ] || continue
    NZU_RUNNER_PULLED="$NZU_RUNNER_PULLED
$(grep -v '^[[:space:]]*$' "$file" 2>/dev/null)"
  done
  return 0
}

# Removes images Nearzero built or downloaded, unless another container uses them.
NZU_KEPT_IMAGES=""

nzu_remove_pulled_image() {
  local ref="$1"
  [ -n "$ref" ] || return 0
  docker image inspect "$ref" >/dev/null 2>&1 || return 0
  if [ -n "$(docker ps -aq --filter "ancestor=$ref" 2>/dev/null)" ]; then
    NZU_KEPT_IMAGES="$NZU_KEPT_IMAGES $ref"
    return 0
  fi
  docker image rm "$ref" >/dev/null 2>&1 || NZU_KEPT_IMAGES="$NZU_KEPT_IMAGES $ref"
}

nzu_remove_images() {
  local id ref
  for id in $(nzu_ids image); do
    if [ -z "$(docker ps -aq --filter "ancestor=$id" 2>/dev/null)" ]; then
      docker image rm --force "$id" >/dev/null 2>&1
    fi
  done
  if [ -f "$NZU_DIR/.pulled-images" ]; then
    while IFS= read -r ref; do
      nzu_remove_pulled_image "$ref"
    done <"$NZU_DIR/.pulled-images"
  fi
  while IFS= read -r ref; do
    nzu_remove_pulled_image "$ref"
  done <<<"$NZU_RUNNER_PULLED"
}

# Images the stack used that the installer found already on the server: left, and listed.
nzu_images_found_before() {
  [ -f "$NZU_DIR/.env" ] || return 0
  local key value pulled="$NZU_DIR/.pulled-images"
  for key in NEARZERO_IMAGE NEARZERO_POSTGRES_IMAGE NEARZERO_ROUTER_IMAGE NEARZERO_DNS_IMAGE; do
    value=$(grep -m 1 "^$key=" "$NZU_DIR/.env" 2>/dev/null | cut -d= -f2-)
    [ -n "$value" ] || continue
    grep -qxF "$value" "$pulled" 2>/dev/null && continue
    docker image inspect "$value" >/dev/null 2>&1 && printf '%s\n' "$value"
  done
}

main() {
  local yes=0 argument
  case "${NEARZERO_UNINSTALL_YES:-}" in true | 1 | yes) yes=1 ;; esac
  for argument in "$@"; do
    case "$argument" in
      --yes | -y) yes=1 ;;
      -h | --help)
        nzu_say "Usage: $NZU_COMMAND_URL [-s -- --yes]"
        exit 0
        ;;
      *) nzu_die "Unknown option: $argument. The only option is --yes." ;;
    esac
  done
  [ "$(id -u)" = 0 ] || nzu_die "Run the uninstaller as root: $NZU_COMMAND_URL"
  nzu_choose_dir

  if ! nzu_anything_installed; then
    nzu_say "Nearzero isn't installed on this server, so nothing was removed."
    exit 0
  fi
  # Docker installed but stopped: its containers (restart policies) would come back when it
  # starts, with their files gone. Nothing is removed until it runs.
  if nzu_has docker && ! nzu_docker; then
    nzu_die "Docker is installed but isn't running, so Nearzero's containers, volumes and images can't be removed, and nothing was." \
      "Start Docker (for example: sudo systemctl start docker), then run this uninstaller again."
  fi
  local legacy
  legacy=$(nzu_legacy_install)
  if [ -n "$legacy" ]; then
    case "$legacy" in
      "a move from 0.1.x"*)
        nzu_die "Nearzero 0.1.x is still on this server: $legacy. This uninstaller removes only 1.0, so nothing was removed." \
          "To keep 1.0 and delete 0.1.x's data, run: sudo nearzero migrate finalize" \
          "To go back to 0.1.x instead, run: sudo nearzero migrate rollback" \
          "Then run this uninstaller again."
        ;;
      *)
        nzu_die "Nearzero 0.1.x is still on this server: $legacy. This uninstaller removes only 1.0, so nothing was removed." \
          "Remove 0.1.x with its own uninstaller first: $NZU_LEGACY_UNINSTALL" \
          "That uninstaller's SHA-256 checksum is published beside it: $NZU_LEGACY_RELEASE_URL/uninstall.sh.sha256" \
          "Then run this uninstaller again."
        ;;
    esac
  fi
  [ "$yes" = 1 ] || nzu_confirm

  local docker_ok=0 left_before=""
  nzu_docker && docker_ok=1
  nzu_say ""
  if [ "$docker_ok" = 1 ]; then
    left_before=$(nzu_images_found_before)
    printf '  Removing Nearzero and what it deployed...\n'
    nzu_read_runner_pulled
    nzu_stop_runner
    nzu_remove_docker_objects
    nzu_remove_images
    # Files stay while containers that use them remain (R4-02).
    local remaining
    remaining=$(nzu_ids container)$(nzu_ids volume)$(nzu_ids network)
    [ -z "$remaining" ] || nzu_die "Some of Nearzero's Docker objects couldn't be removed, so its files were kept. List them with:" \
      "  docker ps -a --filter label=$NZU_LABEL; docker volume ls --filter label=$NZU_LABEL" \
      "Remove them, then run this uninstaller again."
  else
    nzu_stop_runner
  fi
  nzu_keep_backups || nzu_die "The database dumps in $NZU_DIR couldn't be moved to $NZU_KEEP_DIR, so Nearzero's files were kept. Copy them somewhere safe, then run this uninstaller again."
  nzu_remove_files
  printf '%s Removed Nearzero\n' "$NZU_MARK_OK"

  if [ -n "$NZU_KEPT_BACKUPS" ]; then
    nzu_say ""
    nzu_say "Your database backups were kept in $NZU_KEEP_DIR:"
    # shellcheck disable=SC2086
    printf '  %s\n' $NZU_KEPT_BACKUPS
  fi
  nzu_say ""
  nzu_say "Left in place: Docker, and what server setup may have added (a swap file, rclone, SSH"
  nzu_say "hardening). External databases weren't touched. Run this uninstaller on each of your other"
  nzu_say "servers too, or delete them in Nearzero first, which removes Nearzero from them."
  nzu_build_cache_note
  local leftover
  # shellcheck disable=SC2086
  leftover=$(printf '%s\n' $left_before $NZU_KEPT_IMAGES | sed '/^$/d' | sort -u)
  if [ -n "$leftover" ]; then
    nzu_say "These images were kept because they were on this server before Nearzero, or something"
    nzu_say "else still uses them:"
    printf '%s\n' "$leftover" | sed 's/^/  /'
  fi
}

main "$@"
