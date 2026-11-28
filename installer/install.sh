#!/usr/bin/env bash
# NZ_FINAL_<KEY> settings are read by name (nz_get), which shellcheck can't follow.
# shellcheck disable=SC2034
#
# Nearzero installer. Installs Nearzero on this server, or upgrades it when it is already here
# (spec 03 3.1 and 3.2).
#
#   curl -fsSL https://cdn.nearzero.dev/install.sh | sudo bash
#
# To pin a release and check it before running it:
#
#   curl -fsSLO https://cdn.nearzero.dev/v1.0.0/install.sh
#   curl -fsSLO https://cdn.nearzero.dev/v1.0.0/install.sh.sha256
#   sha256sum -c install.sh.sha256 && sudo bash install.sh
#
# Settings are environment variables; installer/README.md lists them. Every question is asked
# before anything is downloaded, and answers are read from the terminal, so piping works.
#
# Nothing runs until the last line calls main, so a download cut short runs nothing.

set -o pipefail

# --- Release constants (the release script stamps the first two) ------------------------------

NZ_VERSION="1.0.0-dev"
NZ_IMAGE_REPOSITORY="ghcr.io/nearzero-systems/nearzero"

NZ_INSTALL_COMMAND="curl -fsSL https://cdn.nearzero.dev/install.sh | sudo bash"
NZ_DEFAULT_POSTGRES_IMAGE="postgres:18.6-alpine"
NZ_DEFAULT_ROUTER_IMAGE="traefik:v3.7.18"
NZ_DEFAULT_DNS_IMAGE="coredns/coredns:1.15.0"
NZ_COMPOSE_VERSION="v5.7.0"
NZ_COMPOSE_SHA256_X86_64="7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2"
NZ_COMPOSE_SHA256_AARCH64="15861535d14e26555736b49376c95e14bfd94285366c8446bfac7156a972e76f"
# Oldest Compose plugin that understands this compose file (optional depends_on, env_file path).
NZ_COMPOSE_MIN_VERSION="2.24.0"
NZ_COMPOSE_PLUGIN_DIR="/usr/local/lib/docker/cli-plugins"
NZ_DOCKER_GUIDE="https://docs.docker.com/engine/install/"
NZ_COMMAND_PATH="/usr/local/bin/nearzero"
# sudo's secure_path leaves /usr/local/bin out on the RHEL family and Amazon Linux, so the
# command is also linked here, and every printed `sudo nearzero …` works there too (B2-11).
NZ_COMMAND_LINK="/usr/bin/nearzero"
# The final 0.1.x release: the only one with `nearzero export` (spec 29.2a). Older ones update first.
NZ_LEGACY_FINAL_VERSION="0.1.80"
# Where 0.1.x publishes its versioned installer and uninstaller, each with a .sha256 beside it
# (spec 31 "0.1.x's own scripts", 31d G4-02, R4-02): 1.0 owns the root addresses.
NZ_LEGACY_RELEASE_URL="https://cdn.nearzero.dev/releases/$NZ_LEGACY_FINAL_VERSION"
NZ_LOG_TAIL_LINES=25
NZ_START_LOG_LINES=60

# Settings the installer writes to .env. Any other KEY=value line there is the person's own and
# is carried forward untouched.
NZ_KNOWN_KEYS="NEARZERO_VERSION NEARZERO_IMAGE NEARZERO_POSTGRES_IMAGE NEARZERO_ROUTER_IMAGE
NEARZERO_PUBLIC_IP_DETECTED
NEARZERO_DNS_IMAGE NEARZERO_DATA_MODE NEARZERO_DATABASE_PASSWORD DATABASE_URL NEARZERO_AUTH_SECRET
NEARZERO_METRICS_TOKEN NEARZERO_PUBLIC_IP NEARZERO_MANAGEMENT_BIND_ADDRESS NEARZERO_CONSOLE_PORT
NEARZERO_API_PORT NEARZERO_HTTP_PORT NEARZERO_HTTPS_PORT NEARZERO_PLATFORM_DOMAIN
NEARZERO_MANAGEMENT_HOSTNAME NEARZERO_ACME_EMAIL NEARZERO_MANAGED_DNS_ZONE NEARZERO_ENABLE_MANAGED_DNS
NEARZERO_MANAGED_DNS_SOA_EMAIL NEARZERO_DNS_BIND_ADDRESS NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE
NEARZERO_SSH_STRICT_HOST_KEY_CHECKING NEARZERO_METRICS_RETENTION_DAYS NEARZERO_STARTUP_TIMEOUT
NEARZERO_TIME_ZONE NEARZERO_CONSOLE_URL NEARZERO_TRUSTED_PROXIES NEARZERO_EMAIL_FROM NEARZERO_RESEND_API_KEY
NEARZERO_SMTP_URL NEARZERO_TRUSTED_ORIGINS NEARZERO_REGISTRATION_MODE NEARZERO_HEROKU_BUILDER_IMAGE
NEARZERO_PAKETO_BUILDER_IMAGE NEARZERO_RAILPACK_FRONTEND_IMAGE NEARZERO_STATIC_NGINX_IMAGE
NEARZERO_METRICS_REFRESH_SECONDS NEARZERO_DNS_PORT COMPOSE_PROFILES NEARZERO_EDITION
NEARZERO_MIGRATION_ATTEMPT NEARZERO_RUNNER_LINK_PORT NEARZERO_RUNNER_LINK_BIND_ADDRESS NEARZERO_GIT_PUBLIC_URL"

# Settings read from the environment for this run only; never written to disk.
NZ_RUN_KEYS="NEARZERO_ADMIN_EMAIL NEARZERO_ADMIN_PASSWORD NEARZERO_VERBOSE NEARZERO_DRY_RUN
NEARZERO_UNATTENDED NEARZERO_INSTALL_DIR NEARZERO_CONFIRM_ADDRESS_CHANGE REDIS_URL
NEARZERO_MIGRATE NEARZERO_MIGRATION_PASSPHRASE"

# 0.1.x setting names 1.0 reads as the 1.0 setting they stand for (spec 03 3.5), as OLD=NEW pairs.
# The 1.0 name wins when both are given. The same table renames them in a 0.1.x settings file on
# a move (NZ_SETTING_RENAMES), and apps/control/src/migration/install.ts keeps a copy.
NZ_SETTING_ALIASES="NEARZERO_NONINTERACTIVE=NEARZERO_UNATTENDED
NEARZERO_STARTUP_TIMEOUT_SECONDS=NEARZERO_STARTUP_TIMEOUT NEARZERO_PLATFORM_PORT=NEARZERO_API_PORT
CONSOLE_URL=NEARZERO_CONSOLE_URL PUBLIC_BACKEND_URL=NEARZERO_CONSOLE_URL BETTER_AUTH_URL=NEARZERO_CONSOLE_URL
PUBLIC_GIT_PROVIDER_BASE_URL=NEARZERO_GIT_PUBLIC_URL TRAEFIK_IMAGE=NEARZERO_ROUTER_IMAGE
TRAEFIK_PORT=NEARZERO_HTTP_PORT TRAEFIK_SSL_PORT=NEARZERO_HTTPS_PORT DRY_RUN=NEARZERO_DRY_RUN
INSTALL_DIR=NEARZERO_INSTALL_DIR RESEND_API_KEY=NEARZERO_RESEND_API_KEY
NEARZERO_AUTH_FROM_EMAIL=NEARZERO_EMAIL_FROM RESEND_FROM_EMAIL=NEARZERO_EMAIL_FROM"
# 0.1.x settings accepted and ignored, as 1.0 has nothing they set (spec 03 3.5, 31d G4-19); each
# is named once, with why (nz_ignored_reason). packages/shared/src/config.ts keeps the same table.
NZ_IGNORED_SETTINGS="NEARZERO_METRICS_PORT NEARZERO_METRICS_CRON NEARZERO_MONITORING_IMAGE
NEARZERO_ALLOW_MONITORING_DOCKER_METADATA NEARZERO_SCHEDULE_IMAGE JOBS_URL API_KEY
TRAEFIK_SOCKET_PROXY_IMAGE TRAEFIK_HTTP3_PORT POSTGRES_USER POSTGRES_DB"
# Other 0.1.x names without the NEARZERO_ prefix that keep their meaning; sudo keeps them too.
NZ_PLAIN_LEGACY_NAMES="CONSOLE_URL PUBLIC_BACKEND_URL BETTER_AUTH_URL PUBLIC_GIT_PROVIDER_BASE_URL TRAEFIK_IMAGE
TRAEFIK_PORT TRAEFIK_SSL_PORT TRAEFIK_HTTP3_PORT TRAEFIK_SOCKET_PROXY_IMAGE JOBS_URL API_KEY POSTGRES_USER
POSTGRES_DB DRY_RUN INSTALL_DIR SKIP_DOCKER_INSTALL NO_COLOR
EXTERNAL_SERVICES RESEND_API_KEY RESEND_FROM_EMAIL"

# --- Output ------------------------------------------------------------------------------------

NZ_MARK_OK="✓"
NZ_MARK_FAIL="✗"
NZ_LIVE=0        # 1 when progress lines can be redrawn in place
NZ_STEP_OPEN=0   # 1 while a step line is waiting for its result
NZ_STEP_TEXT=""
NZ_LOG=""
NZ_VERBOSE=0
NZ_DRY_RUN=0
NZ_INTERACTIVE=0
NZ_TTY_OK=0

nz_say() { printf '%s\n' "$*"; }

nz_log() {
  [ -n "$NZ_LOG" ] && printf '%s\n' "$*" >>"$NZ_LOG"
  return 0
}

nz_step_start() {
  NZ_STEP_TEXT="$1"
  NZ_STEP_OPEN=1
  nz_log "--- $1"
  if [ "$NZ_LIVE" = 1 ]; then
    printf '  %s...' "$1"
  else
    printf '  %s...\n' "$1"
  fi
}

nz_step_done() {
  NZ_STEP_OPEN=0
  nz_log "--- done: $1"
  if [ "$NZ_LIVE" = 1 ]; then
    printf '\r\033[K%s %s\n' "$NZ_MARK_OK" "$1"
  else
    printf '%s %s\n' "$NZ_MARK_OK" "$1"
  fi
}

# Ends an open step line with a failure mark, then prints the message lines.
nz_step_fail() {
  if [ "$NZ_STEP_OPEN" = 1 ]; then
    NZ_STEP_OPEN=0
    if [ "$NZ_LIVE" = 1 ]; then
      printf '\r\033[K%s %s\n' "$NZ_MARK_FAIL" "$NZ_STEP_TEXT"
    else
      printf '%s %s\n' "$NZ_MARK_FAIL" "$NZ_STEP_TEXT"
    fi
  fi
}

# Stops before anything changed: a setting or an answer is wrong.
nz_stop() {
  nz_step_fail
  local line
  for line in "$@"; do printf '%s\n' "$line" >&2; done
  nz_log "stopped: $1"
  exit 1
}

# Stops after a step failed: shows the end of the log and how to continue (spec 03 3.1).
nz_fail() {
  nz_step_fail
  local line
  for line in "$@"; do printf '%s\n' "$line" >&2; done
  if [ -n "$NZ_LOG" ] && [ -s "$NZ_LOG" ] && [ "$NZ_VERBOSE" = 0 ]; then
    printf '\nThe last lines of %s:\n' "$NZ_LOG" >&2
    tail -n "$NZ_LOG_TAIL_LINES" "$NZ_LOG" | sed 's/^/  | /' >&2
  fi
  printf '\nFix the problem above, then run the same install command again.\n' >&2
  exit 1
}

# Runs a command with its output in the log (and on screen with NEARZERO_VERBOSE=true).
# Arguments must never hold a secret: they are written to the log.
nz_run() {
  nz_log "\$ $*"
  if [ "$NZ_VERBOSE" = 1 ]; then
    "$@" 2>&1 | tee -a "$NZ_LOG"
    return "${PIPESTATUS[0]}"
  fi
  "$@" >>"$NZ_LOG" 2>&1
}

nz_has() { command -v "$1" >/dev/null 2>&1; }

nz_lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

nz_random_hex() {
  od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'
}

# A password people can read and type: letters and digits only.
nz_random_password() {
  local out="" chunk
  while [ "${#out}" -lt 24 ]; do
    chunk=$(od -An -tu1 -N64 /dev/urandom | tr -s ' \n' '\n')
    local byte
    for byte in $chunk; do
      [ "$byte" -lt 224 ] || continue
      out="$out$(printf '%s' 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789' | cut -c $((byte % 56 + 1)))"
      [ "${#out}" -ge 24 ] && break
    done
  done
  printf '%s' "$out"
}

nz_random_label() {
  local hex
  hex=$(nz_random_hex 4)
  # Generated labels never look like a number (spec 10.1).
  case "$hex" in
    [0-9]*) hex="a${hex#?}" ;;
  esac
  printf '%s' "$hex"
}

nz_elapsed() {
  local seconds=$(($(date +%s) - $1))
  printf '%dm %02ds' $((seconds / 60)) $((seconds % 60))
}

# --- Terminal input ----------------------------------------------------------------------------

NZ_STTY_SAVED=""

nz_restore_terminal() {
  if [ -n "$NZ_STTY_SAVED" ]; then
    stty "$NZ_STTY_SAVED" </dev/tty 2>/dev/null
    NZ_STTY_SAVED=""
  fi
}

nz_interrupted() {
  nz_restore_terminal
  printf '\n' >&2
  nz_step_fail
  printf 'Stopped. Run the same install command again to continue.\n' >&2
  exit 130
}

# Asks a question on the terminal and puts the answer in NZ_ANSWER.
nz_ask() {
  printf '%s' "$1" >&4
  if ! IFS= read -r NZ_ANSWER <&3; then
    printf '\n' >&4
    nz_stop "No answer was given, so nothing was installed. Run the install command again."
  fi
  NZ_ANSWER="${NZ_ANSWER%$'\r'}"
}

# Asks for a secret without echoing it. Echo goes off before the prompt shows, so nothing typed
# the moment the prompt appears can be echoed.
nz_ask_secret() {
  NZ_STTY_SAVED=$(stty -g </dev/tty 2>/dev/null)
  stty -echo </dev/tty 2>/dev/null
  printf '%s' "$1" >&4
  local status=0
  IFS= read -r NZ_ANSWER <&3 || status=1
  nz_restore_terminal
  printf '\n' >&4
  [ "$status" = 0 ] || nz_stop "No answer was given, so nothing was installed. Run the install command again."
  NZ_ANSWER="${NZ_ANSWER%$'\r'}"
}

# --- Checks on values --------------------------------------------------------------------------

# Values may not contain whitespace, quotes, #, $ or backslashes (spec 03 3.1).
nz_value_is_plain() {
  case "$1" in
    *[[:space:]]* | *\"* | *\'* | *'#'* | *'$'* | *\\*) return 1 ;;
  esac
  return 0
}

nz_is_port() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

nz_is_ipv4() {
  local IFS=. part count=0
  case "$1" in *[!0-9.]* | .* | *. | *..*) return 1 ;; esac
  for part in $1; do
    count=$((count + 1))
    [ -n "$part" ] && [ "${#part}" -le 3 ] && [ "$part" -le 255 ] || return 1
  done
  [ "$count" = 4 ]
}

# Publicly routable IPv4: not private, shared, loopback, link-local, documentation, benchmark,
# multicast or reserved (spec 03 3.1). The same blocks as the control plane's isPublicIPv4 (IANA's
# IPv4 special-purpose registry, with the AS112 and AMT anycast blocks).
nz_is_public_ipv4() {
  nz_is_ipv4 "$1" || return 1
  local IFS=. a b c d
  # shellcheck disable=SC2086
  set -- $1
  a=$((10#$1)) b=$((10#$2)) c=$((10#$3)) d=$((10#$4))
  local n=$(((a << 24) | (b << 16) | (c << 8) | d))
  local range base bits
  for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
    192.0.0.0/24 192.0.2.0/24 192.31.196.0/24 192.52.193.0/24 192.88.99.0/24 192.168.0.0/16 \
    192.175.48.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
    base=${range%/*} bits=${range#*/}
    local IFS=.
    # shellcheck disable=SC2086
    set -- $base
    local m=$((((10#$1) << 24) | ((10#$2) << 16) | ((10#$3) << 8) | (10#$4)))
    local mask=$(((0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF))
    [ $((n & mask)) = $((m & mask)) ] && return 1
  done
  return 0
}

# A DNS name with at least one dot, made of letters, digits and hyphens.
nz_is_hostname() {
  local name="$1" label IFS=.
  [ "${#name}" -le 253 ] || return 1
  case "$name" in *.*) ;; *) return 1 ;; esac
  case "$name" in .* | *. | *..*) return 1 ;; esac
  for label in $name; do
    [ "${#label}" -le 63 ] || return 1
    case "$label" in
      -* | *- | *[!a-z0-9-]*) return 1 ;;
    esac
  done
  # The last label is never all digits.
  case "${name##*.}" in *[!0-9]*) return 0 ;; esac
  return 1
}

# A time zone name like Europe/Berlin or UTC: its shape only (the control plane checks that the
# zone exists, and uses UTC for one it doesn't know).
nz_is_time_zone() {
  [ "${#1}" -le 64 ] && [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$ ]]
}

# The zone named by an /etc/localtime link target, like ../usr/share/zoneinfo/Europe/Berlin.
nz_zone_from_link() {
  case "$1" in
    */zoneinfo/*) ;;
    *) return 1 ;;
  esac
  local zone="${1##*/zoneinfo/}"
  zone="${zone#posix/}"
  zone="${zone#right/}"
  nz_is_time_zone "$zone" && printf '%s' "$zone"
}

# This server's time zone name, which the host's runner reports so backup times follow the
# host's clock through daylight saving (spec 08 8.3); empty when the system doesn't say, and the
# runner then uses the clock's current offset.
nz_host_time_zone() {
  local zone=""
  if nz_has timedatectl; then
    zone=$(timedatectl show --property=Timezone --value 2>/dev/null) || zone=""
  fi
  if ! nz_is_time_zone "$zone" && [ -r /etc/timezone ]; then
    zone=$(head -n 1 /etc/timezone 2>/dev/null | tr -d '[:space:]')
  fi
  if ! nz_is_time_zone "$zone" && [ -L /etc/localtime ]; then
    zone=$(nz_zone_from_link "$(readlink /etc/localtime)") || zone=""
  fi
  if nz_is_time_zone "$zone"; then printf '%s' "$zone"; fi
  return 0
}

nz_is_email() {
  case "$1" in
    *[[:space:]]* | *@*@* | @* | *@) return 1 ;;
    *@*.*) ;;
    *) return 1 ;;
  esac
  local domain="${1#*@}"
  case "$domain" in .* | *. | *..*) return 1 ;; esac
  [ "${#1}" -le 254 ]
}

nz_bool() {
  case "$(nz_lower "$1")" in
    true | 1 | yes | on) printf 'true' ;;
    false | 0 | no | off) printf 'false' ;;
    *) return 1 ;;
  esac
}

# Compares release versions like 1.2.3 and 1.2.3-rc.1. Succeeds when $1 is newer than $2.
nz_version_newer() {
  local a="${1#v}" b="${2#v}"
  local a_core="${a%%-*}" b_core="${b%%-*}" a_pre="" b_pre=""
  case "$a" in *-*) a_pre="${a#*-}" ;; esac
  case "$b" in *-*) b_pre="${b#*-}" ;; esac
  local IFS=. i x y
  # shellcheck disable=SC2206
  local -a ap=($a_core) bp=($b_core)
  for i in 0 1 2; do
    x="${ap[$i]:-0}" y="${bp[$i]:-0}"
    case "$x$y" in *[!0-9]*) return 1 ;; esac
    [ "$((10#$x))" -gt "$((10#$y))" ] && return 0
    [ "$((10#$x))" -lt "$((10#$y))" ] && return 1
  done
  [ -z "$a_pre" ] && [ -n "$b_pre" ] && return 0
  [ -n "$a_pre" ] && [ -z "$b_pre" ] && return 1
  [[ "$a_pre" > "$b_pre" ]]
}

# --- Settings ----------------------------------------------------------------------------------

nz_is_known_key() {
  case " $(printf '%s' "$NZ_KNOWN_KEYS" | tr '\n' ' ') " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

nz_get() {
  local name="$1"
  printf '%s' "${!name}"
}

nz_set() {
  printf -v "$1" '%s' "$2"
}

# Reads install settings from the environment into NZ_ENV_<KEY>. Values with characters that
# can't be stored are left out and reported with the other problems by nz_check_settings.
NZ_PROBLEMS=""

nz_read_environment() {
  local key value
  for key in $NZ_KNOWN_KEYS $NZ_RUN_KEYS; do
    value="${!key}"
    [ -n "$value" ] || continue
    if [ "$key" != NEARZERO_ADMIN_PASSWORD ] && [ "$key" != NEARZERO_MIGRATION_PASSPHRASE ] &&
      ! nz_value_is_plain "$value"; then
      NZ_PROBLEMS="$NZ_PROBLEMS
  - $key contains a space, a quote, #, \$ or a backslash. Remove it; percent-encode them inside URLs."
      continue
    fi
    nz_set "NZ_ENV_$key" "$value"
  done
  nz_read_legacy_names
}

# 0.1.x names (spec 03 3.5): aliases fill the 1.0 setting they stand for when it isn't given,
# EXTERNAL_SERVICES=true is external data mode, and the metrics port and schedule are ignored
# with one note.
NZ_IGNORED_NOTE=""

nz_read_legacy_names() {
  local pair old new value key ignored=""
  for pair in $NZ_SETTING_ALIASES; do
    old="${pair%%=*}" new="${pair#*=}"
    value="${!old}"
    [ -n "$value" ] || continue
    [ -z "$(nz_get "NZ_ENV_$new")" ] || continue
    if ! nz_value_is_plain "$value"; then
      NZ_PROBLEMS="$NZ_PROBLEMS
  - $old contains a space, a quote, #, \$ or a backslash. Remove it; percent-encode them inside URLs."
      continue
    fi
    nz_set "NZ_ENV_$new" "$value"
  done
  if [ -n "${EXTERNAL_SERVICES:-}" ] && [ -z "$NZ_ENV_NEARZERO_DATA_MODE" ]; then
    case "$(nz_bool "$EXTERNAL_SERVICES" 2>/dev/null)" in
      true) NZ_ENV_NEARZERO_DATA_MODE=external ;;
      false) ;;
      *) NZ_PROBLEMS="$NZ_PROBLEMS
  - EXTERNAL_SERVICES must be true or false (true means NEARZERO_DATA_MODE=external)." ;;
    esac
  fi
  # One note per reason, naming each setting given once.
  local reason reasons="" names
  for key in $NZ_IGNORED_SETTINGS; do
    [ -n "${!key:-}" ] || continue
    reason=$(nz_ignored_reason "$key")
    case "$reasons" in *"|$reason|"*) ;; *) reasons="$reasons|$reason|" ;; esac
  done
  while [ -n "$reasons" ]; do
    reasons="${reasons#|}"
    reason="${reasons%%|*}"
    reasons="${reasons#*|}"
    names=""
    for key in $NZ_IGNORED_SETTINGS; do
      [ -n "${!key:-}" ] && [ "$(nz_ignored_reason "$key")" = "$reason" ] && names="${names:+$names and }$key"
    done
    ignored="${ignored:+$ignored
}Note: $names $( [[ "$names" == *" and "* ]] && printf 'are' || printf 'is') ignored: $reason."
  done
  NZ_IGNORED_NOTE="$ignored"
}

# Why a 0.1.x setting is ignored: 1.0 has nothing it sets.
nz_ignored_reason() {
  case "$1" in
    NEARZERO_METRICS_PORT | NEARZERO_METRICS_CRON) printf "Nearzero 1.0's runner collects metrics itself" ;;
    NEARZERO_MONITORING_IMAGE | NEARZERO_ALLOW_MONITORING_DOCKER_METADATA) printf '1.0 has no separate monitoring service' ;;
    NEARZERO_SCHEDULE_IMAGE) printf 'the control plane runs schedules itself' ;;
    JOBS_URL | API_KEY) printf 'the control plane runs jobs itself' ;;
    TRAEFIK_SOCKET_PROXY_IMAGE) printf 'the router reads files, not the Docker socket' ;;
    TRAEFIK_HTTP3_PORT) printf 'HTTP/3 uses the HTTPS port (UDP)' ;;
    POSTGRES_USER | POSTGRES_DB) printf "the bundled database's user and name are fixed; an external database is given by DATABASE_URL" ;;
  esac
}

# Reads an existing .env strictly: blank lines and comments are skipped; every other line must be
# KEY=value with a KEY that appears once. Values are never evaluated or printed (spec 03 3.2).
NZ_EXTRA_LINES=""
NZ_HAVE_SAVED=0

nz_read_saved_settings() {
  local file="$1" line key value number=0 first
  [ -f "$file" ] || return 0
  [ -r "$file" ] || nz_stop "Nearzero can't read $file. Run the installer as root: $NZ_INSTALL_COMMAND"
  NZ_HAVE_SAVED=1
  while IFS= read -r line || [ -n "$line" ]; do
    number=$((number + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if ! [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      nz_stop "Line $number of $file isn't a KEY=value line." \
        "Fix or remove it, then run the install command again."
    fi
    key="${line%%=*}"
    value="${line#*=}"
    first=$(nz_get "NZ_LINE_$key")
    if [ -n "$first" ]; then
      nz_stop "$key is set twice in $file (lines $first and $number)." \
        "Keep one of them, then run the install command again."
    fi
    nz_set "NZ_LINE_$key" "$number"
    if nz_is_known_key "$key"; then
      if ! nz_value_is_plain "$value"; then
        nz_stop "$key on line $number of $file contains a space, a quote, #, \$ or a backslash." \
          "Fix the value (percent-encode them inside URLs), then run the install command again."
      fi
      nz_set "NZ_SAVED_$key" "$value"
    else
      NZ_EXTRA_LINES="$NZ_EXTRA_LINES$line
"
    fi
  done <"$file"
}

# The value for a setting: this run's environment first, then the saved file.
nz_pick() {
  local env saved
  env=$(nz_get "NZ_ENV_$1")
  saved=$(nz_get "NZ_SAVED_$1")
  if [ -n "$env" ]; then printf '%s' "$env"; else printf '%s' "$saved"; fi
}

# --- System facts ------------------------------------------------------------------------------

NZ_OS_ID=""
NZ_OS_LIKE=""
NZ_OS_NAME=""
NZ_ARCH=""

nz_detect_platform() {
  if [ -r /etc/os-release ]; then
    NZ_OS_ID=$(. /etc/os-release && printf '%s' "${ID:-}")
    NZ_OS_LIKE=$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")
    NZ_OS_NAME=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}")
  fi
  case "$(uname -m)" in
    x86_64 | amd64) NZ_ARCH=amd64 ;;
    aarch64 | arm64) NZ_ARCH=arm64 ;;
    *) NZ_ARCH=unsupported ;;
  esac
}

# The address of the interface that holds the default route.
nz_local_ipv4() {
  local address=""
  if nz_has ip; then
    address=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
  fi
  if [ -z "$address" ] && nz_has hostname; then
    address=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | head -n 1)
  fi
  printf '%s' "$address"
}

# Asks public DNS which address this server's requests come from (a DNS lookup for checks,
# spec 23.9). The address echo over HTTPS is asked only when no DNS tool is installed, never
# because a DNS tool got no answer (spec 03 3.1, B2-32).
nz_lookup_public_ipv4() {
  local address=""
  if nz_has dig; then
    address=$(dig +short +time=3 +tries=1 -4 myip.opendns.com A @resolver1.opendns.com 2>/dev/null | tail -n 1)
  fi
  if ! nz_is_ipv4 "$address" && nz_has nslookup; then
    address=$(nslookup myip.opendns.com resolver1.opendns.com 2>/dev/null |
      awk '/^Name:/ {found=1; next} found && /^Address/ {sub(/^Address[^:]*:[ \t]*/, ""); print; exit}')
  fi
  if ! nz_has dig && ! nz_has nslookup && nz_has curl; then
    address=$(curl -4 -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
  fi
  nz_is_ipv4 "$address" && printf '%s' "$address"
}

# The public resolvers the domain check asks, the control plane's own defaults
# (DEFAULT_DNS_RESOLVERS in packages/shared/src/config.ts).
NZ_PUBLIC_RESOLVERS="1.1.1.1 8.8.8.8"

# Resolves a name to its IPv4 addresses, one per line, as public DNS answers it (spec 23.9, a
# public DNS lookup for checks): never /etc/hosts or the machine's own resolver, which on Debian
# and Ubuntu maps the machine's hostname to 127.0.1.1 (B2-28). The next resolver is asked when one
# gives no address (it may be unreachable from here). Without dig or nslookup the same resolver
# answers over HTTPS (its DNS JSON API), and with no curl either the system's lookup is all there
# is; it skips loopback addresses, which only this machine's own files give.
nz_resolve() {
  local name="$1" resolver answer
  if nz_has dig || nz_has nslookup; then
    for resolver in $NZ_PUBLIC_RESOLVERS; do
      if nz_has dig; then
        answer=$(dig +short +time=3 +tries=1 A "$name" "@$resolver" 2>/dev/null)
      else
        answer=$(nslookup "$name" "$resolver" 2>/dev/null |
          awk '/^Name:/ {found=1; next} found && /^Address/ {sub(/^Address[^:]*:[ \t]*/, ""); print}')
      fi
      answer=$(printf '%s\n' "$answer" | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u)
      if [ -n "$answer" ]; then
        printf '%s\n' "$answer"
        return 0
      fi
    done
    return 0
  fi
  if nz_has curl; then
    curl -fsS -m 5 -H 'accept: application/dns-json' \
      "https://cloudflare-dns.com/dns-query?name=$name&type=A" 2>/dev/null |
      grep -oE '"data": ?"[0-9]+(\.[0-9]+){3}"' | grep -oE '[0-9]+(\.[0-9]+){3}' | sort -u
    return 0
  fi
  if nz_has getent; then
    getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | grep -v '^127\.' | sort -u
  fi
}

# What holds a TCP or UDP port, in words (spec 03 3.1 "naming the process that holds one",
# B2-30): the programs listening there as ss or netstat name them for root, and for Docker's
# proxy the container that published the port. Empty when neither can tell.
nz_port_holders() {
  local port="$1" proto="$2" flag=-t names name container out=""
  [ "$proto" = udp ] && flag=-u
  if nz_has ss; then
    names=$(ss -H -lnp "$flag" "sport = :$port" 2>/dev/null | grep -o '("[^"]*",pid=' | sed 's/^("//; s/",pid=$//')
  elif nz_has netstat; then
    names=$(netstat -lnp "$flag" 2>/dev/null |
      awk -v port="$port" '$4 ~ (":" port "$") { name = $NF; sub(/^[0-9]+\//, "", name); print name }')
  fi
  while IFS= read -r name; do
    if [ "$name" = docker-proxy ] && nz_has docker; then
      container=$(docker ps --filter "publish=$port/$proto" --format '{{.Names}}' 2>/dev/null | head -n 1)
      [ -n "$container" ] && name="the container $container"
    fi
    out="${out:+$out, }$name"
  done <<<"$(printf '%s\n' "$names" | sed '/^-\{0,1\}$/d' | sort -u)"
  printf '%s' "$out"
}

# Lists listening sockets as "proto address:port" lines.
nz_listeners() {
  if nz_has ss; then
    ss -H -lntu 2>/dev/null | awk '{print $1, $5}'
  elif nz_has netstat; then
    netstat -lntu 2>/dev/null | awk 'NR > 2 {print $1, $4}'
  fi
}

# Succeeds when something listens on the TCP (or UDP) port on an address that would clash. The
# listeners are read whole first: a pipe that stopped reading early would break the listing
# command, and under pipefail a busy port would read as free (B2-29).
nz_port_busy() {
  local port="$1" proto="$2" ignore_loopback="${3:-0}" listeners kind address
  listeners=$(nz_listeners)
  while read -r kind address; do
    case "$kind" in "$proto"*) ;; *) continue ;; esac
    case "$address" in *:"$port") ;; *) continue ;; esac
    if [ "$ignore_loopback" = 1 ]; then
      case "$address" in 127.* | '[::1]'* | ::1*) continue ;; esac
    fi
    return 0
  done <<<"$listeners"
  return 1
}

nz_docker_running() { docker info >/dev/null 2>&1; }

# --- 1.0's own names (spec 29.5 "No shared names with 0.1.x") -----------------------------------

# Fixed for every 1.0 install, moved or fresh, and never 0.1.x's: its Compose project, containers,
# networks and volumes. The router, its certificates volume and the edge network are the runner's.
NZ_PROJECT="nearzero1"
NZ_DATABASE_CONTAINER="nearzero1-postgres"
NZ_DNS_CONTAINER="nearzero1-dns"
NZ_OWN_CONTAINERS="nearzero-control nearzero-runner $NZ_DATABASE_CONTAINER $NZ_DNS_CONTAINER nearzero-router"
NZ_OWN_NETWORKS="nearzero-internal nearzero-edge"
NZ_OWN_VOLUMES="nearzero-postgres-data nearzero-runner-state nearzero-runner-handoff nearzero-runner-link nearzero-router-certificates"
# The volumes the installer creates (the runner makes the router's certificates volume). The
# runner link's volume keeps the certificate every server pins, across reruns and upgrades.
NZ_CREATED_VOLUMES="nearzero-postgres-data nearzero-runner-state nearzero-runner-handoff nearzero-runner-link"

# The labels of one Docker object, or nothing when there is none by that name.
nz_object_labels() {
  local field=.Labels
  [ "$1" = container ] && field=.Config.Labels
  docker "$1" inspect --format "{{range \$k, \$v := $field}}{{\$k}}={{\$v}} {{end}}" "$2" 2>/dev/null
}

# True when an existing object is 1.0's: it carries dev.nearzero.edition=1, or (rerunning a 1.0
# install made before that label existed) dev.nearzero.managed=true.
nz_object_is_ours() {
  case " $1 " in *" dev.nearzero.edition=1 "*) return 0 ;; esac
  [ "$NZ_HAVE_SAVED" = 1 ] && [ "$NZ_MIGRATING" != 1 ] &&
    case " $1 " in *" dev.nearzero.managed=true "*) return 0 ;; esac
  return 1
}

# Before anything starts: a 1.0 name already taken by something 1.0 didn't create stops the run,
# naming it, so starting 1.0 can never replace, adopt or delete it.
nz_check_name_collisions() {
  # A dry run away from a Linux server (a laptop checking settings) asks no Docker at all.
  [ "$NZ_DRY_RUN" = 1 ] && [ "$(uname -s)" != Linux ] && return 0
  nz_has docker && nz_docker_running || return 0
  local kind name names labels found=""
  for kind in container network volume; do
    case "$kind" in
      container) names="$NZ_OWN_CONTAINERS" ;;
      network) names="$NZ_OWN_NETWORKS" ;;
      volume) names="$NZ_OWN_VOLUMES" ;;
    esac
    for name in $names; do
      docker "$kind" inspect "$name" >/dev/null 2>&1 || continue
      labels=$(nz_object_labels "$kind" "$name")
      nz_object_is_ours "$labels" || found="$found
  - the $kind $name"
    done
  done
  if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$NZ_PROJECT" --filter "label=dev.nearzero.edition=1" 2>/dev/null)" ]; then
    :
  elif [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$NZ_PROJECT" 2>/dev/null)" ]; then
    found="$found
  - the Compose project $NZ_PROJECT"
  fi
  [ -z "$found" ] && return 0
  nz_stop "Nearzero 1.0 needs these names, and this server already has them without Nearzero 1.0's label, so nothing was changed:$found" \
    "Rename or remove them (they aren't Nearzero 1.0's), then run the install command again."
}

# Spec 03 3.4 "Data without its settings": 1.0's database volume (or any volume with 1.0's label)
# on a server with no settings file. Going on would make new secrets and start Nearzero over the
# old database, which then refuses them, so the run stops before anything is written or started.
nz_check_data_without_settings() {
  [ "$NZ_HAVE_SAVED" = 1 ] && return 0
  [ "$NZ_MIGRATING" = 1 ] && return 0
  [ "$NZ_DRY_RUN" = 1 ] && [ "$(uname -s)" != Linux ] && return 0
  local found=""
  if nz_has docker && nz_docker_running; then
    case " $(nz_object_labels volume nearzero-postgres-data) " in
      *" dev.nearzero.edition=1 "* | *" dev.nearzero.managed=true "*) found=nearzero-postgres-data ;;
    esac
    [ -n "$found" ] ||
      found=$(docker volume ls -q --filter label=dev.nearzero.edition=1 2>/dev/null | head -n 1)
  elif [ -d /var/lib/docker/volumes/nearzero-postgres-data ]; then
    # Docker is installed but stopped: its default data folder still shows the volume.
    found=nearzero-postgres-data
  fi
  [ -z "$found" ] && return 0
  nz_stop "Found Nearzero's data ($found) but not its settings file $NZ_ENV_FILE. Put the settings file back and run this command again, or run the uninstall command to remove the old data and start fresh."
}

# Creates the networks and volumes the compose file uses (external there), with 1.0's labels and
# the move attempt; existing ones are kept as they are.
nz_ensure_shared_objects() {
  local name labels=(--label dev.nearzero.managed=true --label dev.nearzero.edition=1)
  [ -n "$NZ_FINAL_NEARZERO_MIGRATION_ATTEMPT" ] &&
    labels+=(--label "dev.nearzero.migration-attempt=$NZ_FINAL_NEARZERO_MIGRATION_ATTEMPT")
  for name in $NZ_OWN_NETWORKS; do
    docker network inspect "$name" >/dev/null 2>&1 ||
      nz_run docker network create "${labels[@]}" "$name" || return 1
  done
  for name in $NZ_CREATED_VOLUMES; do
    docker volume inspect "$name" >/dev/null 2>&1 ||
      nz_run docker volume create "${labels[@]}" "$name" || return 1
  done
}

# Rerunning a 1.0 install made before its names were its own: its containers in the old project
# (nearzero) go, so the new ones don't run beside them on the same volumes. Only containers that
# carry 1.0's component label, and never while moving from 0.1.x.
nz_retire_old_names() {
  [ "$NZ_HAVE_SAVED" = 1 ] && [ "$NZ_MIGRATING" != 1 ] || return 0
  local id labels
  # shellcheck disable=SC2046
  for id in $(printf '%s\n' $(docker ps -aq --filter "label=com.docker.compose.project=nearzero" --filter "label=dev.nearzero.managed=true" 2>/dev/null) \
    $(docker ps -aq --filter "name=^nearzero-dns$" --filter "label=dev.nearzero.managed=true" 2>/dev/null) | sort -u); do
    labels=$(nz_object_labels container "$id")
    case " $labels " in *" dev.nearzero.component="* | *" dev.nearzero.dns-owner="*) nz_run docker rm -fv "$id" ;; esac
  done
}

nz_container_running() {
  [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = true ]
}

# --- Paths -------------------------------------------------------------------------------------

NZ_DIR="/opt/nearzero"
NZ_DEFAULT_DIR="/opt/nearzero"
NZ_ENV_FILE=""

# The folder the installed nearzero command was written for, or nothing (the command keeps it on
# its NZC_DIR line; a 0.1.x command has no such line).
nz_installed_dir() {
  [ -f "$NZ_COMMAND_PATH" ] || return 0
  sed -n 's/^NZC_DIR="\${NEARZERO_INSTALL_DIR:-\(\/[^"}]*\)}"$/\1/p' "$NZ_COMMAND_PATH" 2>/dev/null | head -n 1
}

# The install folder (spec 03 3.5: INSTALL_DIR and NEARZERO_INSTALL_DIR keep their 0.1.x meaning
# on real runs too, B2-26). Without the setting a rerun uses the folder the installed command was
# written for, so an install kept elsewhere is found again. The folder is Nearzero's alone, since
# uninstalling deletes it: a folder that already holds other files is refused unless Nearzero's
# settings file is in it (a rerun, or 0.1.x kept there).
nz_choose_install_dir() {
  local dir="$NZ_ENV_NEARZERO_INSTALL_DIR" name="NEARZERO_INSTALL_DIR"
  if [ -z "$dir" ]; then
    dir=$(nz_installed_dir)
    name="The folder the installed nearzero command names"
  fi
  [ -n "$dir" ] || return 0
  while [ "${#dir}" -gt 1 ] && [ "${dir%/}" != "$dir" ]; do dir="${dir%/}"; done
  case "$dir" in
    /[!/]*) ;;
    *) nz_stop "$name must be an absolute folder path such as $NZ_DEFAULT_DIR, not \"$dir\"." ;;
  esac
  case "$dir/" in
    */./* | */../* | *//* | *[!A-Za-z0-9._/-]*)
      nz_stop "$name must be a plain absolute folder path (letters, digits, '.', '_', '-' and '/'), such as $NZ_DEFAULT_DIR; \"$dir\" isn't."
      ;;
  esac
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    nz_stop "$name is $dir, which is a file, not a folder."
  fi
  # A folder of Nearzero's own whose settings file is gone (its compose file is there) isn't
  # someone else's: the data check that follows says what to do (spec 03 3.2, C2-18).
  if [ -d "$dir" ] && [ ! -f "$dir/.env" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ] &&
    ! grep -qx 'name: nearzero1' "$dir/compose.yml" 2>/dev/null; then
    nz_stop "$name is $dir, which already holds other files. Nearzero needs a folder of its own (uninstalling deletes it): name a new or empty folder, such as $dir/nearzero."
  fi
  NZ_DIR="$dir"
}

nz_compose() {
  docker compose --project-directory "$NZ_DIR" --file "$NZ_DIR/compose.yml" --env-file "$NZ_ENV_FILE" "$@"
}

# --- Decisions ---------------------------------------------------------------------------------

NZ_ADMIN_EMAIL=""
NZ_ADMIN_PASSWORD=""
NZ_PASSWORD_GENERATED=0
NZ_OWNER_STATE="unknown"   # unknown, exists, missing
NZ_OWNER_EMAIL=""
NZ_PUBLIC_IP=""
NZ_DOMAIN_NOTE=""
# The console's hostname saved under About Nearzero (in the database), read from the running
# control plane on a rerun (G4-20).
NZ_CONSOLE_SAVED_HOSTNAME=""

nz_decide_mode() {
  if [ "$(nz_bool "${NZ_ENV_NEARZERO_UNATTENDED:-false}" 2>/dev/null)" = true ]; then
    NZ_INTERACTIVE=0
  elif [ "$NZ_TTY_OK" = 1 ]; then
    NZ_INTERACTIVE=1
  else
    NZ_INTERACTIVE=0
  fi
}

nz_decide_public_ip() {
  local given
  # A saved address that was only detected is detected again (it may have changed); one the
  # person set, here or before, wins (B2-25).
  given=$(nz_get NZ_ENV_NEARZERO_PUBLIC_IP)
  if [ -z "$given" ] && [ "$(nz_get NZ_SAVED_NEARZERO_PUBLIC_IP_DETECTED)" != true ]; then
    given=$(nz_get NZ_SAVED_NEARZERO_PUBLIC_IP)
  fi
  NZ_FINAL_NEARZERO_PUBLIC_IP_DETECTED=""
  if [ -n "$given" ]; then
    nz_is_ipv4 "$given" || nz_stop "NEARZERO_PUBLIC_IP must be an IPv4 address, like 203.0.113.7."
    NZ_PUBLIC_IP="$given"
    return
  fi
  NZ_FINAL_NEARZERO_PUBLIC_IP_DETECTED=true
  local local_ip
  local_ip=$(nz_local_ipv4)
  if nz_is_public_ipv4 "$local_ip"; then
    NZ_PUBLIC_IP="$local_ip"
    return
  fi
  NZ_PUBLIC_IP=$(nz_lookup_public_ipv4)
  # A rerun keeps the public address it detected before when detecting it again fails or finds
  # only a private one, rather than stopping an upgrade over a passing DNS failure (C2-15).
  local saved
  saved=$(nz_get NZ_SAVED_NEARZERO_PUBLIC_IP)
  if ! nz_is_public_ipv4 "$NZ_PUBLIC_IP" && [ -n "$saved" ] && nz_is_public_ipv4 "$saved"; then
    nz_log "couldn't detect the public address again (got: ${NZ_PUBLIC_IP:-nothing}); keeping the saved $saved"
    NZ_PUBLIC_IP="$saved"
  fi
  [ -n "$NZ_PUBLIC_IP" ] || NZ_PUBLIC_IP="$local_ip"
  [ -n "$NZ_PUBLIC_IP" ] || nz_stop "Nearzero couldn't find this server's IPv4 address." \
    "Set it with NEARZERO_PUBLIC_IP, like: NEARZERO_PUBLIC_IP=203.0.113.7, and run the install command again."
}

# Checks every setting on its own; rules that span settings come after the questions.
nz_check_settings() {
  local key value problems="$NZ_PROBLEMS"
  for key in NEARZERO_CONSOLE_PORT NEARZERO_API_PORT NEARZERO_HTTP_PORT NEARZERO_HTTPS_PORT \
    NEARZERO_RUNNER_LINK_PORT; do
    value=$(nz_pick "$key")
    [ -z "$value" ] || nz_is_port "$value" ||
      problems="$problems
  - $key must be a port from 1 to 65535."
  done
  for key in NEARZERO_ENABLE_MANAGED_DNS NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE \
    NEARZERO_SSH_STRICT_HOST_KEY_CHECKING NEARZERO_VERBOSE NEARZERO_DRY_RUN NEARZERO_UNATTENDED \
    NEARZERO_CONFIRM_ADDRESS_CHANGE; do
    value=$(nz_pick "$key")
    [ -z "$value" ] || nz_bool "$value" >/dev/null ||
      problems="$problems
  - $key must be true or false."
  done
  for key in NEARZERO_MANAGEMENT_BIND_ADDRESS NEARZERO_DNS_BIND_ADDRESS NEARZERO_RUNNER_LINK_BIND_ADDRESS; do
    value=$(nz_pick "$key")
    [ -z "$value" ] || nz_is_ipv4 "$value" ||
      problems="$problems
  - $key must be an IPv4 address, like 0.0.0.0 (all interfaces) or 127.0.0.1."
  done
  for key in NEARZERO_PLATFORM_DOMAIN NEARZERO_MANAGEMENT_HOSTNAME NEARZERO_MANAGED_DNS_ZONE; do
    value=$(nz_lower "$(nz_pick "$key")")
    value="${value#\*.}"
    value="${value%.}"
    if [ -n "$value" ] && ! nz_is_hostname "$value"; then
      problems="$problems
  - $key must be a domain name with a dot, like example.com."
    fi
  done
  for key in NEARZERO_ADMIN_EMAIL NEARZERO_ACME_EMAIL NEARZERO_MANAGED_DNS_SOA_EMAIL; do
    value=$(nz_pick "$key")
    [ -z "$value" ] || nz_is_email "$value" ||
      problems="$problems
  - $key must be an email address, like you@company.com."
  done
  for key in NEARZERO_IMAGE NEARZERO_POSTGRES_IMAGE NEARZERO_ROUTER_IMAGE NEARZERO_DNS_IMAGE; do
    value=$(nz_pick "$key")
    case "$value" in
      '' | *:*) ;;
      *) problems="$problems
  - $key must name a tag, like registry.example.com/name:1.0.0." ;;
    esac
  done
  value=$(nz_pick NEARZERO_STARTUP_TIMEOUT)
  case "$value" in
    '') ;;
    *[!0-9]*) problems="$problems
  - NEARZERO_STARTUP_TIMEOUT must be a number of seconds from 30 to 3600." ;;
    *) [ "$value" -ge 30 ] && [ "$value" -le 3600 ] || problems="$problems
  - NEARZERO_STARTUP_TIMEOUT must be a number of seconds from 30 to 3600." ;;
  esac
  value=$(nz_pick NEARZERO_METRICS_REFRESH_SECONDS)
  case "$value" in
    '') ;;
    *[!0-9]*) problems="$problems
  - NEARZERO_METRICS_REFRESH_SECONDS must be a number of seconds from 1 to 3600." ;;
    *) [ "$value" -ge 1 ] && [ "$value" -le 3600 ] || problems="$problems
  - NEARZERO_METRICS_REFRESH_SECONDS must be a number of seconds from 1 to 3600." ;;
  esac
  value=$(nz_pick NEARZERO_DNS_PORT)
  [ -z "$value" ] || nz_is_port "$value" ||
    problems="$problems
  - NEARZERO_DNS_PORT must be a port from 1 to 65535."
  value=$(nz_lower "$(nz_pick NEARZERO_REGISTRATION_MODE)")
  case "$value" in
    # 0.1.x wrote invite_only; it means the same as invite-only (30a R1-03).
    '' | bootstrap | invite-only | invite_only | open) ;;
    *) problems="$problems
  - NEARZERO_REGISTRATION_MODE must be bootstrap or invite-only." ;;
  esac
  value=$(nz_pick NEARZERO_TRUSTED_ORIGINS)
  if [ -n "$value" ] && ! [[ "$value" =~ ^https?://[^,/[:space:]]+(,https?://[^,/[:space:]]+)*$ ]]; then
    problems="$problems
  - NEARZERO_TRUSTED_ORIGINS must list addresses separated by commas, like https://nearzero.example.com,http://203.0.113.7:4321."
  fi
  for key in NEARZERO_HEROKU_BUILDER_IMAGE NEARZERO_PAKETO_BUILDER_IMAGE \
    NEARZERO_RAILPACK_FRONTEND_IMAGE NEARZERO_STATIC_NGINX_IMAGE; do
    value=$(nz_pick "$key")
    [ -z "$value" ] || [[ "$value" =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]] ||
      problems="$problems
  - $key must be pinned by digest, like registry.example.com/builder@sha256:<64 hex digits>."
  done
  value=$(nz_pick NEARZERO_METRICS_RETENTION_DAYS)
  case "$value" in
    '') ;;
    *[!0-9]*) problems="$problems
  - NEARZERO_METRICS_RETENTION_DAYS must be a number of days from 1 to 365." ;;
    *) [ "$value" -ge 1 ] && [ "$value" -le 365 ] || problems="$problems
  - NEARZERO_METRICS_RETENTION_DAYS must be a number of days from 1 to 365." ;;
  esac
  value=$(nz_pick NEARZERO_TIME_ZONE)
  [ -z "$value" ] || nz_is_time_zone "$value" ||
    problems="$problems
  - NEARZERO_TIME_ZONE must be a time zone name, like Europe/Berlin or UTC."
  value=$(nz_pick NEARZERO_DATA_MODE)
  case "$value" in
    '' | local | external) ;;
    *) problems="$problems
  - NEARZERO_DATA_MODE must be local (the bundled database) or external." ;;
  esac
  value=$(nz_pick DATABASE_URL)
  case "$value" in
    '' | postgres://* | postgresql://*) ;;
    *) problems="$problems
  - DATABASE_URL must start with postgres:// or postgresql://." ;;
  esac
  value=$(nz_pick NEARZERO_CONSOLE_URL)
  case "$value" in
    '' | http://?* | https://?*) ;;
    *) problems="$problems
  - NEARZERO_CONSOLE_URL must be the console's address, like https://nearzero.example.com." ;;
  esac
  value=$(nz_pick NEARZERO_TRUSTED_PROXIES)
  if [ -n "$value" ] && ! [[ "$value" =~ ^[0-9A-Fa-f.:]+(/[0-9]{1,3})?(,[0-9A-Fa-f.:]+(/[0-9]{1,3})?)*$ ]]; then
    problems="$problems
  - NEARZERO_TRUSTED_PROXIES must list IP addresses or ranges separated by commas, like 127.0.0.1,10.0.0.0/8."
  fi
  value=$(nz_pick NEARZERO_EMAIL_FROM)
  [ -z "$value" ] || nz_is_email "$value" ||
    problems="$problems
  - NEARZERO_EMAIL_FROM must be an email address, like nearzero@company.com."
  value=$(nz_pick NEARZERO_SMTP_URL)
  case "$value" in
    '' | smtp://?* | smtps://?*) ;;
    *) problems="$problems
  - NEARZERO_SMTP_URL must start with smtp:// or smtps://, like smtp://user:password@smtp.example.com:587." ;;
  esac
  if [ -n "$(nz_pick NEARZERO_SMTP_URL)" ] && [ -n "$(nz_pick NEARZERO_RESEND_API_KEY)" ]; then
    problems="$problems
  - NEARZERO_RESEND_API_KEY and NEARZERO_SMTP_URL are both set. Keep the one this server should send email with."
  fi
  value="${NZ_ENV_NEARZERO_ADMIN_PASSWORD}"
  if [ -n "$value" ]; then
    case "$value" in
      *$'\n'* | *$'\r'*) problems="$problems
  - NEARZERO_ADMIN_PASSWORD must be one line." ;;
    esac
    if [ "${#value}" -lt 8 ] || [ "${#value}" -gt 128 ]; then
      problems="$problems
  - NEARZERO_ADMIN_PASSWORD must be 8 to 128 characters."
    fi
    [ -n "$NZ_ENV_NEARZERO_ADMIN_EMAIL" ] || problems="$problems
  - NEARZERO_ADMIN_PASSWORD needs NEARZERO_ADMIN_EMAIL too: set the admin's email with it."
  fi
  [ -z "$problems" ] || nz_stop "These install settings can't be used:$problems"
}

# One string field of the one-line JSON answer the control plane's commands give with --json
# (owner-status, create-owner). Emails never hold quotes, so a plain match is enough.
nz_json_field() {
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -n 1
}

# The JSON line in a command's output (people's messages never start with "{").
nz_json_line() {
  printf '%s\n' "$1" | grep '^{' | tail -n 1
}

# Asks whether an owner exists, through the running control plane (reruns only). The answer is
# the machine-readable one of `owner-status --json`, never the wording of a message.
nz_probe_owner() {
  NZ_OWNER_STATE="unknown"
  [ "$NZ_HAVE_SAVED" = 1 ] && [ "$NZ_DRY_RUN" = 0 ] || return 0
  # A first install that stopped before Nearzero ever started (its settings are saved first):
  # with the bundled database and no database volume, or no Docker at all, no account can exist
  # yet, so the account is asked for as on a first install (B2-27).
  if [ "$(nz_pick NEARZERO_DATA_MODE)" != external ]; then
    if ! nz_has docker; then
      NZ_OWNER_STATE="missing"
      return 0
    fi
    if nz_docker_running && ! docker volume inspect nearzero-postgres-data >/dev/null 2>&1; then
      NZ_OWNER_STATE="missing"
      return 0
    fi
  fi
  nz_has docker && nz_docker_running && nz_container_running nearzero-control || return 0
  local answer
  answer=$(nz_json_line "$(nz_compose exec -T control nearzero-control owner-status --json </dev/null 2>/dev/null)")
  case "$(nz_json_field "$answer" owner)" in
    exists)
      NZ_OWNER_STATE="exists"
      NZ_OWNER_EMAIL=$(nz_json_field "$answer" email)
      ;;
    missing) NZ_OWNER_STATE="missing" ;;
  esac
  # A hostname saved under About Nearzero is the console's too (G4-20).
  answer=$(nz_json_line "$(nz_compose exec -T control nearzero-control console-hostname --json </dev/null 2>/dev/null)")
  NZ_CONSOLE_SAVED_HOSTNAME=$(nz_lower "$(nz_json_field "$answer" hostname)")
  nz_is_hostname "$NZ_CONSOLE_SAVED_HOSTNAME" || NZ_CONSOLE_SAVED_HOSTNAME=""
}

# The domain question is offered until a domain is set, unless the console already has a
# hostname saved, in the settings or under About Nearzero (spec 3.2, G4-20).
nz_offer_domain() {
  if [ "$NZ_INTERACTIVE" = 1 ] && nz_is_public_ipv4 "$NZ_PUBLIC_IP" &&
    [ -z "$(nz_pick NEARZERO_PLATFORM_DOMAIN)$(nz_pick NEARZERO_MANAGEMENT_HOSTNAME)$NZ_CONSOLE_SAVED_HOSTNAME" ]; then
    nz_ask_domain
  fi
  return 0
}

# Asks for the admin account at the terminal. An email given in NEARZERO_ADMIN_EMAIL is offered
# as the answer (Enter keeps it), and the password is asked for all the same (G4-22).
nz_ask_account() {
  local given="${1:-}"
  nz_say ""
  nz_say "Create your admin account"
  while :; do
    if [ -n "$given" ]; then nz_ask "  Email [$given]: "; else nz_ask "  Email: "; fi
    NZ_ANSWER=$(printf '%s' "$NZ_ANSWER" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -z "$NZ_ANSWER" ] && [ -n "$given" ] && NZ_ANSWER="$given"
    if nz_is_email "$NZ_ANSWER"; then
      NZ_ADMIN_EMAIL="$NZ_ANSWER"
      break
    fi
    nz_say "  Enter a valid email address, like you@company.com."
  done
  local first
  while :; do
    nz_ask_secret "  Password (8+ characters): "
    first="$NZ_ANSWER"
    if [ "${#first}" -lt 8 ] || [ "${#first}" -gt 128 ]; then
      nz_say "  Use 8 to 128 characters."
      continue
    fi
    nz_ask_secret "  Confirm password: "
    if [ "$NZ_ANSWER" != "$first" ]; then
      nz_say "  The passwords don't match. Try again."
      continue
    fi
    NZ_ADMIN_PASSWORD="$first"
    break
  done
  first=""
  NZ_ANSWER=""
}

# The admin account: given, asked for at the terminal, or (unattended) a generated password.
nz_decide_account() {
  NZ_ADMIN_EMAIL="$NZ_ENV_NEARZERO_ADMIN_EMAIL"
  NZ_ADMIN_PASSWORD="$NZ_ENV_NEARZERO_ADMIN_PASSWORD"
  nz_probe_owner
  # A move brings its accounts along, so no admin account is asked for.
  [ "$NZ_MIGRATING" = 1 ] && NZ_ADMIN_EMAIL="" && NZ_ADMIN_PASSWORD="" && NZ_OWNER_STATE="exists"
  # At a terminal the account is asked for, with the email offered when only it was given
  # (G4-22): a password is generated only without a terminal, by spec 3.1's unattended rules.
  if [ -z "$NZ_ADMIN_PASSWORD" ] && [ "$NZ_INTERACTIVE" = 1 ] && [ "$NZ_OWNER_STATE" != exists ] &&
    { [ "$NZ_HAVE_SAVED" = 0 ] || [ "$NZ_OWNER_STATE" = missing ]; }; then
    nz_ask_account "$NZ_ADMIN_EMAIL"
  fi
  if [ -n "$NZ_ADMIN_EMAIL" ] && [ -z "$NZ_ADMIN_PASSWORD" ] && [ "$NZ_OWNER_STATE" != exists ]; then
    NZ_ADMIN_PASSWORD=$(nz_random_password)
    NZ_PASSWORD_GENERATED=1
  fi
  return 0
}

# Prints the DNS records the domain needs.
nz_print_records() {
  local domain="$1" dashboard="$2"
  nz_say ""
  nz_say "  Create these DNS records at your DNS provider:"
  printf '    %-34s %-3s %s\n' "*.$domain" A "$NZ_PUBLIC_IP"
  if [ -n "$dashboard" ] && [ "${dashboard#*.}" != "$domain" ]; then
    printf '    %-34s %-3s %s\n' "$dashboard" A "$NZ_PUBLIC_IP"
  fi
  nz_say "  and allow inbound TCP 80 and 443, and UDP 443 for HTTP/3, to this server."
}

# Checks that a random name under the domain and the dashboard address point here.
# Prints one line per name that doesn't, and fails if any doesn't.
nz_check_dns() {
  local domain="$1" dashboard="$2" name addresses shown ok=0
  for name in "$(nz_random_label).$domain" "$dashboard"; do
    [ -n "$name" ] || continue
    addresses=$(nz_resolve "$name")
    if [ "$(printf '%s\n' "$addresses" | grep -c .)" = 1 ] && [ "$addresses" = "$NZ_PUBLIC_IP" ]; then
      continue
    fi
    ok=1
    if [ -z "$addresses" ]; then
      shown="nothing yet"
    else
      shown=$(printf '%s\n' "$addresses" | paste -sd, - | sed 's/,/, /g')
    fi
    nz_say "  $name points at $shown, not $NZ_PUBLIC_IP."
  done
  return "$ok"
}

NZ_CHOSEN_DOMAIN=""
NZ_CHOSEN_HOSTNAME=""

nz_ask_domain() {
  local answer domain dashboard
  nz_say ""
  while :; do
    nz_ask "Add a domain for HTTPS on the dashboard and your apps? [y/N] "
    answer=$(nz_lower "$NZ_ANSWER" | tr -d '[:space:]')
    case "$answer" in
      '' | n | no)
        # Every way of skipping says how to add one later (spec 3.1, G4-24).
        nz_say "Skipped. Run this install command again to add one."
        return 0
        ;;
      y | yes) break ;;
      *) nz_say "Answer y or n." ;;
    esac
  done
  while :; do
    nz_ask "Domain, like example.com or apps.example.com (Enter to skip): "
    domain=$(nz_lower "$NZ_ANSWER" | tr -d '[:space:]')
    domain="${domain#\*.}"
    domain="${domain%.}"
    if [ -z "$domain" ]; then
      nz_say "Skipped. Run this install command again to add one."
      return 0
    fi
    if nz_is_ipv4 "$domain" || ! nz_is_hostname "$domain"; then
      nz_say "Enter a domain name only, like example.com."
      continue
    fi
    break
  done
  while :; do
    nz_ask "Dashboard address [nearzero.$domain]: "
    dashboard=$(nz_lower "$NZ_ANSWER" | tr -d '[:space:]')
    dashboard="${dashboard%.}"
    [ -n "$dashboard" ] || dashboard="nearzero.$domain"
    if nz_is_hostname "$dashboard" && ! nz_is_ipv4 "$dashboard"; then
      break
    fi
    nz_say "Enter a hostname with a dot, like nearzero.$domain."
  done
  nz_print_records "$domain" "$dashboard"
  nz_ask "  Press Enter once they exist, or \"skip\": "
  answer=$(nz_lower "$NZ_ANSWER" | tr -d '[:space:]')
  while :; do
    case "$answer" in
      skip)
        nz_say "Skipped. Run this install command again to add one."
        return 0
        ;;
      use)
        nz_say "  Using $domain as it is."
        break
        ;;
    esac
    if nz_check_dns "$domain" "$dashboard"; then
      nz_say "$NZ_MARK_OK DNS for $domain and $dashboard points at this server"
      break
    fi
    nz_say "  Once a domain is set you sign in there, so DNS has to be right first."
    nz_ask "  Press Enter to check again, \"skip\" to go on without a domain, or \"use\" to keep it anyway: "
    answer=$(nz_lower "$NZ_ANSWER" | tr -d '[:space:]')
  done
  NZ_CHOSEN_DOMAIN="$domain"
  NZ_CHOSEN_HOSTNAME="$dashboard"
}

# --- The final settings ------------------------------------------------------------------------

# Fills NZ_FINAL_<KEY> for every known key. Secrets are kept when saved, generated otherwise.
nz_decide_settings() {
  local key value saved
  local confirm_change
  confirm_change=$(nz_bool "${NZ_ENV_NEARZERO_CONFIRM_ADDRESS_CHANGE:-false}")

  # Addresses: a saved hostname, domain or zone never changes without the migration steps.
  for key in NEARZERO_MANAGEMENT_HOSTNAME NEARZERO_PLATFORM_DOMAIN NEARZERO_MANAGED_DNS_ZONE; do
    saved=$(nz_lower "$(nz_get "NZ_SAVED_$key")")
    # The hostname saved under About Nearzero counts as a saved one (G4-20).
    [ "$key" = NEARZERO_MANAGEMENT_HOSTNAME ] && [ -z "$saved" ] && saved="$NZ_CONSOLE_SAVED_HOSTNAME"
    value=$(nz_lower "$(nz_get "NZ_ENV_$key")")
    value="${value#\*.}"
    value="${value%.}"
    case "$key" in
      NEARZERO_MANAGEMENT_HOSTNAME) [ -n "$value" ] || value="$NZ_CHOSEN_HOSTNAME" ;;
      NEARZERO_PLATFORM_DOMAIN) [ -n "$value" ] || value="$NZ_CHOSEN_DOMAIN" ;;
    esac
    if [ -n "$saved" ] && [ -n "$value" ] && [ "$saved" != "$value" ] && [ "$confirm_change" != true ]; then
      nz_stop "This server's $key is $saved. Changing it to $value requires a migration, so nothing was changed." \
        "Sign-in, invitation links, Git provider callbacks and app hostnames use it. To move it:" \
        "  1. Point the new name at this server ($NZ_PUBLIC_IP) and wait until it resolves." \
        "  2. Update the callback addresses of connected Git providers to the new name." \
        "  3. Run the install command again with $key=$value NEARZERO_CONFIRM_ADDRESS_CHANGE=true." \
        "Existing app hostnames keep their names until you change them on the Domains page."
    fi
    [ -n "$value" ] || value="$saved"
    nz_set "NZ_FINAL_$key" "$value"
  done

  # Data mode and the database.
  local mode saved_mode url
  saved_mode=$(nz_get NZ_SAVED_NEARZERO_DATA_MODE)
  mode=$(nz_pick NEARZERO_DATA_MODE)
  url=$(nz_pick DATABASE_URL)
  [ -n "$mode" ] || mode=local
  if [ -n "$saved_mode" ] && [ "$mode" != "$saved_mode" ]; then
    nz_stop "This server keeps Nearzero's data in the $saved_mode database. Moving it to the $mode one requires a migration, so nothing was changed." \
      "Back it up first with: sudo nearzero backup-db, then follow the external database steps in the install guide."
  fi
  if [ "$mode" = external ]; then
    [ -n "$(nz_get NZ_ENV_DATABASE_URL)$(nz_get NZ_SAVED_DATABASE_URL)" ] ||
      nz_stop "NEARZERO_DATA_MODE=external needs DATABASE_URL too, like postgres://user:password@db.example.com:5432/nearzero."
    NZ_FINAL_NEARZERO_DATABASE_PASSWORD=""
    NZ_FINAL_DATABASE_URL="$url"
  else
    if [ -n "$NZ_ENV_DATABASE_URL" ]; then
      nz_stop "DATABASE_URL is set, but NEARZERO_DATA_MODE isn't external." \
        "To use your own PostgreSQL, set NEARZERO_DATA_MODE=external with DATABASE_URL; otherwise leave DATABASE_URL out."
    fi
    NZ_FINAL_NEARZERO_DATABASE_PASSWORD=$(nz_get NZ_SAVED_NEARZERO_DATABASE_PASSWORD)
    [ -n "$NZ_FINAL_NEARZERO_DATABASE_PASSWORD" ] || NZ_FINAL_NEARZERO_DATABASE_PASSWORD=$(nz_random_hex 24)
    NZ_FINAL_DATABASE_URL="postgres://nearzero:$NZ_FINAL_NEARZERO_DATABASE_PASSWORD@$NZ_DATABASE_CONTAINER:5432/nearzero"
  fi
  NZ_FINAL_NEARZERO_DATA_MODE="$mode"
  if [ -n "$NZ_ENV_REDIS_URL" ]; then
    NZ_DOMAIN_NOTE="$NZ_DOMAIN_NOTE
REDIS_URL isn't needed: Nearzero 1.0 keeps its jobs in PostgreSQL, so it was left out."
  fi

  # Per-install secrets, generated once and kept (spec 23.4, item 5).
  NZ_FINAL_NEARZERO_AUTH_SECRET=$(nz_get NZ_SAVED_NEARZERO_AUTH_SECRET)
  [ -n "$NZ_FINAL_NEARZERO_AUTH_SECRET" ] || NZ_FINAL_NEARZERO_AUTH_SECRET=$(nz_random_hex 32)
  NZ_FINAL_NEARZERO_METRICS_TOKEN=$(nz_get NZ_SAVED_NEARZERO_METRICS_TOKEN)
  [ -n "$NZ_FINAL_NEARZERO_METRICS_TOKEN" ] || NZ_FINAL_NEARZERO_METRICS_TOKEN=$(nz_random_hex 32)

  # Images: official ones move to this installer's version only when it is newer (spec 03 3.2).
  local image
  image=$(nz_get NZ_ENV_NEARZERO_IMAGE)
  if [ -z "$image" ]; then
    saved=$(nz_get NZ_SAVED_NEARZERO_IMAGE)
    image="$NZ_IMAGE_REPOSITORY:$NZ_VERSION"
    if [ -n "$saved" ]; then
      case "$saved" in
        "$NZ_IMAGE_REPOSITORY":*)
          nz_version_newer "$NZ_VERSION" "${saved##*:}" || image="$saved"
          ;;
        *) image="$saved" ;;
      esac
    fi
  fi
  NZ_FINAL_NEARZERO_IMAGE="$image"
  NZ_FINAL_NEARZERO_POSTGRES_IMAGE=$(nz_newer_official_image NEARZERO_POSTGRES_IMAGE "$NZ_DEFAULT_POSTGRES_IMAGE" postgres)
  NZ_FINAL_NEARZERO_DNS_IMAGE=$(nz_newer_official_image NEARZERO_DNS_IMAGE "$NZ_DEFAULT_DNS_IMAGE" coredns/coredns)
  # The router's official image moves forward like the others (B2-24: a newer Traefik pin,
  # security fixes included, used to never reach an install); the runner replaces the router
  # only when this changes, keeping the old one until the new one runs.
  NZ_FINAL_NEARZERO_ROUTER_IMAGE=$(nz_newer_official_image NEARZERO_ROUTER_IMAGE "$NZ_DEFAULT_ROUTER_IMAGE" traefik)

  # Plain settings with defaults.
  nz_final_default NEARZERO_MANAGEMENT_BIND_ADDRESS 0.0.0.0
  nz_final_default NEARZERO_CONSOLE_PORT 4321
  nz_final_default NEARZERO_API_PORT 3000
  # The runner link's own TLS port: servers reach Nearzero there, encrypted, when it has no
  # domain (spec 31 "Remote runners are always encrypted"). Only runners connect there, so it
  # listens on every address even when the console is kept on this server.
  nz_final_default NEARZERO_RUNNER_LINK_PORT 3443
  nz_final_default NEARZERO_RUNNER_LINK_BIND_ADDRESS 0.0.0.0
  nz_final_default NEARZERO_HTTP_PORT 80
  nz_final_default NEARZERO_HTTPS_PORT 443
  nz_final_default NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE false
  nz_final_default NEARZERO_SSH_STRICT_HOST_KEY_CHECKING false
  nz_final_default NEARZERO_METRICS_RETENTION_DAYS 2
  nz_final_default NEARZERO_STARTUP_TIMEOUT 300
  # Optional control-plane settings, passed through as given (or as saved).
  for key in NEARZERO_CONSOLE_URL NEARZERO_TRUSTED_PROXIES NEARZERO_EMAIL_FROM \
    NEARZERO_RESEND_API_KEY NEARZERO_SMTP_URL NEARZERO_TRUSTED_ORIGINS NEARZERO_HEROKU_BUILDER_IMAGE \
    NEARZERO_PAKETO_BUILDER_IMAGE NEARZERO_RAILPACK_FRONTEND_IMAGE NEARZERO_STATIC_NGINX_IMAGE \
    NEARZERO_METRICS_REFRESH_SECONDS NEARZERO_DNS_PORT NEARZERO_GIT_PUBLIC_URL; do
    nz_final_default "$key" ""
  done
  # "open" sign-up isn't offered for self-hosted installs; it behaves as bootstrap (spec 04 4.2).
  NZ_FINAL_NEARZERO_REGISTRATION_MODE=$(nz_lower "$(nz_pick NEARZERO_REGISTRATION_MODE)")
  [ "$NZ_FINAL_NEARZERO_REGISTRATION_MODE" = open ] && NZ_FINAL_NEARZERO_REGISTRATION_MODE=bootstrap
  [ "$NZ_FINAL_NEARZERO_REGISTRATION_MODE" = invite_only ] && NZ_FINAL_NEARZERO_REGISTRATION_MODE=invite-only
  for key in NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE NEARZERO_SSH_STRICT_HOST_KEY_CHECKING; do
    nz_set "NZ_FINAL_$key" "$(nz_bool "$(nz_get "NZ_FINAL_$key")")"
  done
  NZ_FINAL_NEARZERO_PUBLIC_IP="$NZ_PUBLIC_IP"
  NZ_FINAL_NEARZERO_VERSION="$NZ_VERSION"
  # 1.0's marker, so a later run never takes this install for 0.1.x (spec 29.2 step 2).
  NZ_FINAL_NEARZERO_EDITION=1
  # A move from 0.1.x labels what this attempt creates, so rollback removes exactly that.
  NZ_FINAL_NEARZERO_MIGRATION_ATTEMPT=""
  if [ "$NZ_MIGRATING" = 1 ]; then
    NZ_FINAL_NEARZERO_MIGRATION_ATTEMPT="move-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  # The host's time zone for its runner (spec 08 8.3, 12.2): given, saved, or this system's.
  NZ_FINAL_NEARZERO_TIME_ZONE=$(nz_pick NEARZERO_TIME_ZONE)
  [ -n "$NZ_FINAL_NEARZERO_TIME_ZONE" ] || NZ_FINAL_NEARZERO_TIME_ZONE=$(nz_host_time_zone)

  # Certificate contact: saved, given, the admin's email, or asked when a hostname needs one.
  NZ_FINAL_NEARZERO_ACME_EMAIL=$(nz_pick NEARZERO_ACME_EMAIL)
  [ -n "$NZ_FINAL_NEARZERO_ACME_EMAIL" ] || NZ_FINAL_NEARZERO_ACME_EMAIL="$NZ_ADMIN_EMAIL"
  if [ -n "$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME" ] && [ -z "$NZ_FINAL_NEARZERO_ACME_EMAIL" ] &&
    [ "$NZ_INTERACTIVE" = 1 ]; then
    while :; do
      nz_ask "Email for HTTPS certificates: "
      NZ_ANSWER=$(printf '%s' "$NZ_ANSWER" | tr -d '[:space:]')
      nz_is_email "$NZ_ANSWER" && break
      nz_say "Enter a valid email address, like you@company.com."
    done
    NZ_FINAL_NEARZERO_ACME_EMAIL="$NZ_ANSWER"
  fi

  # Managed DNS: the built-in DNS server runs only with a zone (spec 03 3.1, note on DNS).
  # A saved value counts only when a zone was saved with it; without a zone it is no choice.
  local enable
  enable=$(nz_get NZ_ENV_NEARZERO_ENABLE_MANAGED_DNS)
  if [ -z "$enable" ] && [ -n "$(nz_get NZ_SAVED_NEARZERO_MANAGED_DNS_ZONE)" ]; then
    enable=$(nz_get NZ_SAVED_NEARZERO_ENABLE_MANAGED_DNS)
  fi
  if [ -n "$NZ_FINAL_NEARZERO_MANAGED_DNS_ZONE" ]; then
    if [ -n "$enable" ]; then enable=$(nz_bool "$enable"); else enable=true; fi
    NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS="$enable"
  else
    if [ "$(nz_bool "${enable:-false}")" = true ]; then
      NZ_DOMAIN_NOTE="$NZ_DOMAIN_NOTE
The built-in DNS server starts only once NEARZERO_MANAGED_DNS_ZONE names a zone, so it isn't running."
    fi
    enable=false
    NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS=""
  fi
  NZ_FINAL_NEARZERO_MANAGED_DNS_SOA_EMAIL=$(nz_pick NEARZERO_MANAGED_DNS_SOA_EMAIL)
  if [ -n "$NZ_FINAL_NEARZERO_MANAGED_DNS_ZONE" ] && [ -z "$NZ_FINAL_NEARZERO_MANAGED_DNS_SOA_EMAIL" ]; then
    NZ_FINAL_NEARZERO_MANAGED_DNS_SOA_EMAIL="${NZ_ADMIN_EMAIL:-$NZ_FINAL_NEARZERO_ACME_EMAIL}"
    [ -n "$NZ_FINAL_NEARZERO_MANAGED_DNS_SOA_EMAIL" ] ||
      NZ_FINAL_NEARZERO_MANAGED_DNS_SOA_EMAIL="hostmaster@$NZ_FINAL_NEARZERO_MANAGED_DNS_ZONE"
  fi
  NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS=$(nz_pick NEARZERO_DNS_BIND_ADDRESS)

  # A hostname or zone needs a public address (spec 03 3.1).
  if [ -n "$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME$NZ_FINAL_NEARZERO_MANAGED_DNS_ZONE" ] &&
    ! nz_is_public_ipv4 "$NZ_PUBLIC_IP"; then
    nz_stop "This server's address, $NZ_PUBLIC_IP, isn't publicly routable, so a dashboard hostname or DNS zone can't point at it." \
      "Set NEARZERO_PUBLIC_IP to the server's public IPv4 address, or leave out the hostname and zone."
  fi

  # Which services run.
  local profiles=""
  [ "$mode" = local ] && profiles="database"
  profiles="${profiles:+$profiles,}router"
  [ "$enable" = true ] && profiles="$profiles,dns"
  NZ_FINAL_COMPOSE_PROFILES="$profiles"
}

nz_final_default() {
  local value
  value=$(nz_pick "$1")
  [ -n "$value" ] || value="$2"
  nz_set "NZ_FINAL_$1" "$value"
}

# Keeps a custom image; moves an official one (same repository, same major version, same variant)
# forward to this installer's default when that is newer. Another variant of the same release
# (postgres:18.1, Debian, against the default's -alpine) is a custom choice and stays (C2-16): its
# data may depend on its C library's collation. A digest is always a custom choice.
nz_newer_official_image() {
  local key="$1" default="$2" repository="$3" given saved
  given=$(nz_get "NZ_ENV_$key")
  if [ -n "$given" ]; then printf '%s' "$given"; return; fi
  saved=$(nz_get "NZ_SAVED_$key")
  if [ -z "$saved" ]; then printf '%s' "$default"; return; fi
  case "$saved" in
    *@*) printf '%s' "$saved"; return ;;
    "$repository":*) ;;
    *) printf '%s' "$saved"; return ;;
  esac
  local saved_tag="${saved##*:}" default_tag="${default##*:}"
  local saved_variant="${saved_tag#"${saved_tag%%-*}"}" default_variant="${default_tag#"${default_tag%%-*}"}"
  if [ "${saved_tag%%.*}" = "${default_tag%%.*}" ] && [ "$saved_variant" = "$default_variant" ] &&
    nz_version_newer "${default_tag%%-*}" "${saved_tag%%-*}"; then
    printf '%s' "$default"
  else
    printf '%s' "$saved"
  fi
}

# Port checks before anything changes, on a first install or when the DNS server is added.
# True when every holder named (nz_port_holders) is one of Nearzero's own containers: a router or
# control plane of this install isn't in the way of its own rerun (C2-14).
nz_held_by_own() {
  local holder name
  [ -n "$1" ] || return 1
  while IFS= read -r holder; do
    holder="${holder# }"
    [ -n "$holder" ] || continue
    name="${holder#the container }"
    [ "$name" != "$holder" ] || return 1
    case " $NZ_OWN_CONTAINERS " in *" $name "*) ;; *) return 1 ;; esac
  done <<<"$(printf '%s\n' "$1" | tr ',' '\n')"
  return 0
}

nz_check_ports() {
  [ "$NZ_DRY_RUN" = 1 ] && return 0
  # A first install has neither saved settings nor a running control plane. A rerun whose control
  # plane is stopped (docker stop, compose down, an interrupted restore-db) still has its runner
  # keeping the router on 80 and 443: those are Nearzero's own, not a clash (C2-14).
  local first_install=1 port busy="" holders shown=""
  [ "$NZ_HAVE_SAVED" = 1 ] && first_install=0
  nz_has docker && nz_docker_running && nz_container_running nearzero-control && first_install=0
  if [ -n "$(nz_listeners)" ]; then
    local ports="$NZ_FINAL_NEARZERO_RUNNER_LINK_PORT"
    [ "$first_install" = 1 ] && ports="$NZ_FINAL_NEARZERO_HTTP_PORT $NZ_FINAL_NEARZERO_HTTPS_PORT $NZ_FINAL_NEARZERO_CONSOLE_PORT $NZ_FINAL_NEARZERO_API_PORT $ports"
    for port in $ports; do
      nz_port_busy "$port" tcp || continue
      holders=$(nz_port_holders "$port" tcp)
      nz_held_by_own "$holders" && continue
      busy="$busy $port"
      shown="${shown:+$shown, }$port${holders:+ ($holders)}"
    done
    if [ -n "$busy" ] && [ "$first_install" = 1 ]; then
      nz_stop "Nearzero needs TCP ports $NZ_FINAL_NEARZERO_HTTP_PORT, $NZ_FINAL_NEARZERO_HTTPS_PORT, $NZ_FINAL_NEARZERO_CONSOLE_PORT, $NZ_FINAL_NEARZERO_API_PORT and $NZ_FINAL_NEARZERO_RUNNER_LINK_PORT, and these are already in use on this server: $shown." \
        "Stop what uses them (see: ss -ltnp), or choose other ports with NEARZERO_HTTP_PORT, NEARZERO_HTTPS_PORT, NEARZERO_CONSOLE_PORT, NEARZERO_API_PORT and NEARZERO_RUNNER_LINK_PORT."
    elif [ -n "$busy" ]; then
      # An upgrade that adds the runner link's port (spec 31 "Remote runners are always
      # encrypted"): the rest of the install already has its ports.
      nz_stop "Nearzero now gives servers an encrypted link on TCP port $NZ_FINAL_NEARZERO_RUNNER_LINK_PORT, and it is already in use on this server: $shown." \
        "Stop what uses it (see: ss -ltnp), or choose another port with NEARZERO_RUNNER_LINK_PORT, then run the install command again."
    fi
  fi
  if [ "$NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS" != true ]; then
    # No zone yet, but one may be connected in the console later: when a resolver stub holds
    # port 53 on loopback only (systemd-resolved), the server's own address is saved for the
    # DNS server now, so it can start then (B2-13).
    if [ -z "$NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS" ] && nz_port_busy 53 udp &&
      ! nz_port_busy 53 udp 1 && ! nz_port_busy 53 tcp 1; then
      NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS=$(nz_local_ipv4)
    fi
    return 0
  fi
  if nz_has docker && nz_docker_running && nz_container_running "$NZ_DNS_CONTAINER"; then
    return 0
  fi
  [ -n "$(nz_listeners)" ] || return 0
  # A resolver stub on loopback (systemd-resolved) is fine when the DNS server binds the
  # server's own address instead of every address.
  local bind="$NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS"
  if [ -z "$bind" ] && nz_port_busy 53 udp; then
    if ! nz_port_busy 53 udp 1 && ! nz_port_busy 53 tcp 1; then
      bind=$(nz_local_ipv4)
      NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS="$bind"
    fi
  fi
  if [ -n "$bind" ] && [ "$bind" != 0.0.0.0 ]; then
    if nz_listeners | grep -Eq "(^| )(udp|tcp)[^ ]* ($bind|0\.0\.0\.0|\*|\[::\]|::):53$"; then
      nz_stop_port_53
    fi
    return 0
  fi
  if nz_port_busy 53 udp || nz_port_busy 53 tcp; then
    nz_stop_port_53
  fi
}

nz_stop_port_53() {
  local who
  who=$(printf '%s\n%s\n' "$(nz_port_holders 53 udp)" "$(nz_port_holders 53 tcp)" | tr ',' '\n' |
    sed 's/^ *//; /^$/d' | sort -u | paste -sd, - | sed 's/,/, /g')
  nz_stop "The built-in DNS server needs TCP and UDP port 53, and ${who:-another program} already listens there." \
    "Stop it (see: ss -lntup 'sport = :53'), or set NEARZERO_DNS_BIND_ADDRESS to an address of this server that is free on port 53, then run the install command again."
}

# --- Writing files -----------------------------------------------------------------------------

nz_write_env_file() {
  local target="$NZ_ENV_FILE" tmp key value
  tmp="$NZ_DIR/.env.writing.$$"
  (
    umask 077
    {
      printf '# Nearzero settings for this server, written by the installer %s.\n' "$NZ_VERSION"
      printf '# Run the install command again to change them. It keeps every value here and any\n'
      printf '# KEY=value lines you add below the last one (comments are not kept).\n'
      for key in $NZ_KNOWN_KEYS; do
        value=$(nz_get "NZ_FINAL_$key")
        [ -n "$value" ] || continue
        printf '%s=%s\n' "$key" "$value"
      done
      if [ -n "$NZ_EXTRA_LINES" ]; then
        printf '# Your own settings, carried forward:\n'
        printf '%s' "$NZ_EXTRA_LINES"
      fi
    } >"$tmp"
  ) || return 1
  chmod 0600 "$tmp" && mv -f "$tmp" "$target"
}

nz_write_router_files() {
  mkdir -p "$NZ_DIR/router" && chmod 0755 "$NZ_DIR/router" || return 1
  local file="$NZ_DIR/router/console.yml" host="$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME"
  if [ -z "$host" ]; then
    rm -f "$file"
    return 0
  fi
  cat >"$file.tmp" <<EOF
# Written by the Nearzero installer: the console at https://$host.
# Its requests stay out of the request log, so Analytics counts only apps (spec 13.1).
http:
  routers:
    nearzero-console:
      rule: Host(\`$host\`)
      entryPoints: [websecure]
      service: nearzero-console
      tls:
        certResolver: letsencrypt
      observability:
        accessLogs: false
    nearzero-console-http:
      rule: Host(\`$host\`)
      entryPoints: [web]
      middlewares: [nearzero-console-https]
      service: nearzero-console
      observability:
        accessLogs: false
    # Runners on other servers connect here (a WebSocket straight to the API, spec 25 D1).
    nearzero-runner-gateway:
      rule: Host(\`$host\`) && PathPrefix(\`/api/v1/runner/\`)
      entryPoints: [websecure]
      service: nearzero-api
      tls:
        certResolver: letsencrypt
      observability:
        accessLogs: false
  middlewares:
    nearzero-console-https:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    nearzero-console:
      loadBalancer:
        servers:
          - url: http://nearzero-control:4321
    nearzero-api:
      loadBalancer:
        servers:
          - url: http://nearzero-control:3000
EOF
  chmod 0644 "$file.tmp" && mv -f "$file.tmp" "$file"
}

nz_write_dns_files() {
  local zone="$NZ_FINAL_NEARZERO_MANAGED_DNS_ZONE"
  [ "$NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS" = true ] && [ -n "$zone" ] || return 0
  mkdir -p "$NZ_DIR/dns/zones" && chmod 0755 "$NZ_DIR/dns" "$NZ_DIR/dns/zones" || return 1
  local corefile="$NZ_DIR/dns/Corefile"
  local block="$zone:1053 {
    file /etc/nearzero/dns/zones/$zone.zone
    reload 10s
    errors
}"
  # Once Nearzero publishes zones, the Corefile is its own and lists the zones connected in the
  # console too; a rerun keeps it, adding only the install's zone when it isn't there (B2-10).
  if [ -s "$corefile" ]; then
    if ! grep -q "^$(printf '%s' "$zone" | sed 's/\./\\./g'):1053 {" "$corefile"; then
      printf '\n%s\n' "$block" >>"$corefile" || return 1
    fi
  else
    printf '%s\n%s\n' "# Written by the Nearzero installer. Nearzero manages the zone files under zones/." \
      "$block" >"$corefile" || return 1
  fi
  local zone_file="$NZ_DIR/dns/zones/$zone.zone"
  [ -f "$zone_file" ] && return 0
  local contact="$NZ_FINAL_NEARZERO_MANAGED_DNS_SOA_EMAIL"
  local mailbox="${contact%@*}" maildomain="${contact#*@}"
  mailbox=$(printf '%s' "$mailbox" | sed 's/\./\\./g')
  cat >"$zone_file" <<EOF
\$ORIGIN $zone.
\$TTL 300
@    IN SOA ns1.$zone. $mailbox.$maildomain. ( $(date +%Y%m%d)01 3600 600 604800 300 )
@    IN NS  ns1.$zone.
@    IN NS  ns2.$zone.
ns1  IN A   $NZ_PUBLIC_IP
ns2  IN A   $NZ_PUBLIC_IP
EOF
  chmod 0644 "$NZ_DIR/dns/Corefile" "$zone_file"
}

# --- Docker ------------------------------------------------------------------------------------

nz_start_docker_service() {
  if nz_has systemctl && [ -d /run/systemd/system ]; then
    nz_run systemctl enable --now docker
  elif nz_has rc-service; then
    nz_run rc-update add docker default
    nz_run rc-service docker start
  elif nz_has service; then
    nz_run service docker start
  fi
  local waited=0
  while ! nz_docker_running; do
    [ "$waited" -ge 60 ] && return 1
    sleep 2
    waited=$((waited + 2))
  done
}

# True when the running kernel's modules are gone while others are installed: a full upgrade
# (Arch's pacman -Syu) replaced the kernel under the running system, which can't load the overlay,
# bridge and netfilter modules Docker needs until it reboots (C2-22). A container, whose image has
# no modules for the host's kernel, never counts: only a folder left with others beside it does.
nz_kernel_modules_gone() {
  local running
  running=$(uname -r 2>/dev/null)
  [ -n "$running" ] && [ ! -d "${NZ_ROOT:-}/usr/lib/modules/$running" ] && [ ! -d "${NZ_ROOT:-}/lib/modules/$running" ] &&
    [ -n "$(ls -A "${NZ_ROOT:-}/usr/lib/modules" 2>/dev/null)" ]
}

nz_install_docker_packages() {
  local family="$NZ_OS_ID"
  case "$NZ_OS_ID" in
    ubuntu | debian | raspbian | linuxmint | pop | elementary | zorin | kali | neon | devuan) family=debian ;;
    alpine) family=alpine ;;
    arch | manjaro | endeavouros) family=arch ;;
    amzn) family=amazon ;;
    fedora) family=fedora ;;
    rhel | centos | rocky | almalinux | ol | cloudlinux | eurolinux | virtuozzo) family=rhel ;;
    opensuse* | sles | sled | suse) family=suse ;;
    *)
      case " $NZ_OS_LIKE " in
        *" debian "* | *" ubuntu "*) family=debian ;;
        *" rhel "* | *" centos "*) family=rhel ;;
        *" fedora "*) family=fedora ;;
        *" suse "* | *" opensuse "*) family=suse ;;
        *" arch "*) family=arch ;;
        *) family=unknown ;;
      esac
      ;;
  esac
  case "$family" in
    debian)
      export DEBIAN_FRONTEND=noninteractive
      nz_run apt-get update -q && nz_run apt-get install -y -q docker.io ca-certificates curl
      ;;
    alpine)
      nz_run apk add --no-cache docker ca-certificates curl
      ;;
    arch)
      nz_run pacman -Syu --noconfirm --needed docker
      ;;
    amazon)
      if nz_has dnf; then nz_run dnf install -y docker; else nz_run yum install -y docker; fi
      ;;
    fedora)
      nz_run dnf install -y moby-engine
      ;;
    rhel)
      # These distributions don't package Docker; Docker's own repository for them is used.
      local tool=yum
      nz_has dnf && tool=dnf
      nz_run curl -fsSL -o /etc/yum.repos.d/docker-ce.repo https://download.docker.com/linux/centos/docker-ce.repo &&
        nz_run "$tool" install -y docker-ce docker-ce-cli containerd.io
      ;;
    suse)
      nz_run zypper --non-interactive install docker
      ;;
    *)
      nz_fail "Nearzero can't install Docker on ${NZ_OS_NAME:-this system} by itself." \
        "Install Docker with its guide, $NZ_DOCKER_GUIDE, then run the install command again."
      ;;
  esac
}

nz_ensure_docker() {
  nz_step_start "Checking Docker"
  if ! nz_has docker; then
    if [ "$(nz_bool "${SKIP_DOCKER_INSTALL:-false}" 2>/dev/null)" = true ]; then
      nz_fail "Docker isn't installed, and SKIP_DOCKER_INSTALL says not to install it." \
        "Install Docker with its guide, $NZ_DOCKER_GUIDE, then run the install command again."
    fi
    NZ_STEP_TEXT="Installing Docker"
    nz_install_docker_packages || nz_fail "Docker could not be installed with the system's packages."
    nz_has docker || nz_fail "Docker was installed but its command isn't on the PATH."
  fi
  if ! nz_docker_running; then
    if ! nz_start_docker_service; then
      nz_kernel_modules_gone && nz_fail "Docker is installed but can't start until this server reboots: the package upgrade installed a new kernel and removed the running kernel's modules ($(uname -r)), which Docker needs." \
        "Reboot the server, then run the install command again."
      nz_fail "Docker is installed but isn't running, and it couldn't be started."
    fi
  fi
  nz_ensure_compose_plugin
  nz_step_done "Docker is installed"
}

nz_compose_version() {
  docker compose version --short 2>/dev/null | tr -d 'v[:space:]'
}

nz_ensure_compose_plugin() {
  local current
  current=$(nz_compose_version)
  if [ -n "$current" ] && ! nz_version_newer "$NZ_COMPOSE_MIN_VERSION" "$current"; then
    return 0
  fi
  local arch expected
  case "$NZ_ARCH" in
    amd64) arch=x86_64 expected="$NZ_COMPOSE_SHA256_X86_64" ;;
    arm64) arch=aarch64 expected="$NZ_COMPOSE_SHA256_AARCH64" ;;
    *) nz_fail "Nearzero runs on amd64 and arm64 servers; this one is $(uname -m)." ;;
  esac
  local url="https://github.com/docker/compose/releases/download/$NZ_COMPOSE_VERSION/docker-compose-linux-$arch"
  local target="$NZ_COMPOSE_PLUGIN_DIR/docker-compose" tmp
  tmp="$NZ_COMPOSE_PLUGIN_DIR/.docker-compose.download"
  mkdir -p "$NZ_COMPOSE_PLUGIN_DIR" || nz_fail "Couldn't create $NZ_COMPOSE_PLUGIN_DIR."
  if nz_has curl; then
    nz_run curl -fsSL --retry 3 -o "$tmp" "$url"
  else
    nz_run wget -q -O "$tmp" "$url"
  fi || {
    rm -f "$tmp"
    nz_fail "Downloading the Docker Compose plugin $NZ_COMPOSE_VERSION failed."
  }
  local actual
  actual=$(nz_sha256 "$tmp")
  if [ "$actual" != "$expected" ]; then
    rm -f "$tmp"
    nz_log "compose plugin checksum: expected $expected, got $actual"
    nz_fail "The Docker Compose plugin download didn't match its checksum, so it wasn't installed."
  fi
  chmod 0755 "$tmp" && mv -f "$tmp" "$target" || nz_fail "Couldn't install the Docker Compose plugin."
  nz_log "installed the Docker Compose plugin $NZ_COMPOSE_VERSION"
  [ -n "$(nz_compose_version)" ] || nz_fail "The Docker Compose plugin was installed but doesn't run."
}

nz_sha256() {
  if nz_has sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif nz_has shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# --- Download ----------------------------------------------------------------------------------

NZ_IMAGES=""

nz_images_for_profiles() {
  NZ_IMAGES="$NZ_FINAL_NEARZERO_IMAGE"
  case ",$NZ_FINAL_COMPOSE_PROFILES," in *,database,*) NZ_IMAGES="$NZ_IMAGES $NZ_FINAL_NEARZERO_POSTGRES_IMAGE" ;; esac
  case ",$NZ_FINAL_COMPOSE_PROFILES," in *,router,*) NZ_IMAGES="$NZ_IMAGES $NZ_FINAL_NEARZERO_ROUTER_IMAGE" ;; esac
  case ",$NZ_FINAL_COMPOSE_PROFILES," in *,dns,*) NZ_IMAGES="$NZ_IMAGES $NZ_FINAL_NEARZERO_DNS_IMAGE" ;; esac
}

nz_urlencode_ref() {
  printf '%s' "$1" | sed 's/%/%25/g; s/\//%2F/g; s/:/%3A/g; s/@/%40/g'
}

nz_docker_socket() {
  case "${DOCKER_HOST:-}" in
    '') [ -S /var/run/docker.sock ] && printf '/var/run/docker.sock' ;;
    unix://*) printf '%s' "${DOCKER_HOST#unix://}" ;;
  esac
}

# The registry an image reference names: its first part when that is a host (a dot, a port or
# localhost), else Docker Hub.
nz_registry_of() {
  local first="${1%%/*}"
  if [ "$first" != "$1" ] && { [[ "$first" == *.* ]] || [[ "$first" == *:* ]] || [ "$first" = localhost ]; }; then
    printf '%s' "$first"
  else
    printf 'docker.io'
  fi
}

# The Docker CLI settings folder holding a login for an image's registry (docker login, as root
# or as the person who ran sudo), or nothing (C2-17). The Engine API never reads these, so an
# image from a registry someone logged in to is pulled with the CLI, which does.
nz_login_config_for() {
  local registry dir file keys
  registry=$(nz_registry_of "$1")
  if [ "$registry" = docker.io ]; then
    keys='"(https://)?(index\.)?docker\.io(/v1/?)?"'
  else
    keys="\"(https?://)?$(printf '%s' "$registry" | sed 's/[.]/\\./g')/?\""
  fi
  for dir in "${DOCKER_CONFIG:-${HOME:-/root}/.docker}" ${SUDO_USER:+"$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)/.docker"}; do
    file="$dir/config.json"
    [ -r "$file" ] || continue
    # A credential store or helper keeps logins out of the file: the CLI asks it.
    if grep -Eq '"(credsStore|credHelpers)"' "$file" || grep -Eq "$keys" "$file"; then
      printf '%s' "$dir"
      return 0
    fi
  done
  return 1
}

# Sums the pull streams: prints "percent done_images". Each image counts equally; a finished one
# is 100%, one still downloading is the share of its known layers' bytes (at most 99%).
nz_pull_progress() {
  # Files are matched to images by name (1.json, 2.json, ...), since empty ones have no lines.
  awk -v files="$#" '
    FNR == 1 { file = FILENAME; sub(/^.*\//, "", file); sub(/\.json$/, "", file); file += 0 }
    {
      id = ""; status = ""; current = -1; total = -1
      if (match($0, /"id":"[^"]*"/)) id = substr($0, RSTART + 6, RLENGTH - 7)
      if (match($0, /"status":"[^"]*"/)) status = substr($0, RSTART + 10, RLENGTH - 11)
      if (match($0, /"current":[0-9]+/)) current = substr($0, RSTART + 10, RLENGTH - 10) + 0
      if (match($0, /"total":[0-9]+/)) total = substr($0, RSTART + 8, RLENGTH - 8) + 0
      if (status ~ /^(Digest|Status): / && !(file in done)) { done[file] = 1; images++ }
      if (id == "") next
      key = file ":" id
      owner[key] = file
      if (status == "Downloading" && total > 0) { size[key] = total; got[key] = current }
      else if (status == "Download complete" || status == "Pull complete" || status == "Extracting" || status == "Verifying Checksum") {
        if (key in size) got[key] = size[key]
      }
    }
    END {
      for (k in size) { all[owner[k]] += size[k]; have[owner[k]] += got[k] }
      sum = 0
      for (f = 1; f <= files; f++) {
        if (f in done) { sum += 100; continue }
        p = (all[f] > 0) ? int(have[f] * 100 / all[f]) : 0
        sum += (p > 99) ? 99 : p
      }
      pct = (files > 0) ? int(sum / files) : 0
      printf "%d %d\n", pct, images + 0
    }
  ' "$@" 2>/dev/null
}

nz_pull_images() {
  nz_images_for_profiles
  local work="$NZ_DIR/.pull" socket count=0 ref
  rm -rf "$work" && mkdir -p "$work" && chmod 0700 "$work" || nz_fail "Couldn't create $work."
  for ref in $NZ_IMAGES; do count=$((count + 1)); done
  # Remember which images this installer brought onto the server, so uninstall removes only those.
  for ref in $NZ_IMAGES; do
    if ! docker image inspect "$ref" >/dev/null 2>&1 && ! grep -qxF "$ref" "$NZ_DIR/.pulled-images" 2>/dev/null; then
      printf '%s\n' "$ref" >>"$NZ_DIR/.pulled-images"
    fi
  done
  socket=$(nz_docker_socket)
  local started pids="" index=0 files=""
  started=$(date +%s)
  local label="Downloading Nearzero"
  NZ_STEP_TEXT="$label"
  NZ_STEP_OPEN=1
  nz_log "--- $label: $NZ_IMAGES"
  for ref in $NZ_IMAGES; do
    index=$((index + 1))
    files="$files $work/$index.json"
    local login=""
    login=$(nz_login_config_for "$ref") || login=""
    if [ -z "$login" ] && [ -n "$socket" ] && nz_has curl; then
      curl -sS -N --unix-socket "$socket" -X POST \
        "http://localhost/images/create?fromImage=$(nz_urlencode_ref "$ref")" \
        >"$work/$index.json" 2>"$work/$index.err" &
    else
      # With the CLI and its login for that registry (a private registry, or Docker Hub's own
      # limits for a logged-in account), C2-17.
      (docker ${login:+--config "$login"} pull "$ref" >"$work/$index.log" 2>&1 && printf '{"status":"Status: pulled"}\n' >"$work/$index.json") &
    fi
    pids="$pids $!"
  done
  local pct=0 done_images=0 last_print=0 now progress
  # shellcheck disable=SC2086
  while :; do
    local running=0 pid
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && running=1; done
    # shellcheck disable=SC2086
    progress=$(nz_pull_progress $files)
    # Never step backwards: more layers become known as each download starts.
    [ "${progress%% *}" -gt "${pct:-0}" ] 2>/dev/null && pct=${progress%% *}
    done_images=${progress##* }
    now=$(date +%s)
    if [ "$NZ_LIVE" = 1 ]; then
      printf '\r\033[K  %s: %s%% · %s of %s images · %s' "$label" "${pct:-0}" "${done_images:-0}" "$count" "$(nz_elapsed "$started")"
    elif [ $((now - last_print)) -ge 10 ] || [ "$running" = 0 ]; then
      printf '  %s: %s%% · %s of %s images · %s\n' "$label" "${pct:-0}" "${done_images:-0}" "$count" "$(nz_elapsed "$started")"
      last_print=$now
    fi
    [ "$running" = 1 ] || break
    sleep 0.5 2>/dev/null || sleep 1
  done
  local failed="" pid status file
  index=0
  for pid in $pids; do
    index=$((index + 1))
    wait "$pid"
    status=$?
    file="$work/$index.json"
    cat "$file" "$work/$index.err" "$work/$index.log" >>"$NZ_LOG" 2>/dev/null
    if [ "$status" != 0 ] || grep -q '"error"' "$file" 2>/dev/null || ! grep -q '"status":"\(Status\|Digest\)' "$file" 2>/dev/null; then
      ref=$(printf '%s\n' $NZ_IMAGES | sed -n "${index}p")
      # Already on this server (pulled by hand from a registry this installer can't reach or
      # log in to): that copy is used (C2-17).
      if docker image inspect "$ref" >/dev/null 2>&1; then
        nz_log "couldn't download $ref; using the copy already on this server"
        continue
      fi
      failed="$failed $ref"
    fi
  done
  rm -rf "$work"
  if [ -n "$failed" ]; then
    nz_fail "These images couldn't be downloaded:$failed" \
      "Check that this server can reach their registries (and that the names are right)."
  fi
  nz_step_done "Downloaded Nearzero"
}

# --- Start -------------------------------------------------------------------------------------

nz_start() {
  nz_step_start "Starting Nearzero"
  local services="control runner"
  case ",$NZ_FINAL_COMPOSE_PROFILES," in *,database,*) services="postgres $services" ;; esac
  case ",$NZ_FINAL_COMPOSE_PROFILES," in *,dns,*) services="$services dns" ;; esac
  # The router isn't started here: the runner owns it, keeps it through upgrades, and recreates
  # it only when its settings change (spec 25 D1, 23.2).
  # shellcheck disable=SC2086
  # A DNS server the runner started for a zone connected in the console gives way to this one.
  case ",$NZ_FINAL_COMPOSE_PROFILES," in *,dns,*)
    if [ "$(docker inspect -f '{{index .Config.Labels "dev.nearzero.dns-owner"}}' "$NZ_DNS_CONTAINER" 2>/dev/null)" = runner ]; then
      nz_run docker rm -fv "$NZ_DNS_CONTAINER"
    fi ;;
  esac
  nz_retire_old_names
  nz_ensure_shared_objects || nz_fail "Nearzero's networks and volumes couldn't be created." \
    "See $NZ_LOG for Docker's answer."
  # On a rerun the host's runner may be replaced (a newer image, other settings), which stops the
  # task runs, backups and restores it runs on this server. The control plane is updated first,
  # and the runner once that work is done (C2-10); a first install starts them together.
  local first="$services" later=""
  if [ "$NZ_HAVE_SAVED" = 1 ] && nz_container_running nearzero-runner; then
    first="${services/runner/}"
    later=runner
  fi
  # shellcheck disable=SC2086
  nz_run nz_compose up -d --no-build $first || nz_fail_start
  if [ "$NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS" != true ] && nz_container_running "$NZ_DNS_CONTAINER"; then
    nz_run nz_compose --profile dns stop dns
    nz_run nz_compose --profile dns rm -f dns
  fi
  local timeout="$NZ_FINAL_NEARZERO_STARTUP_TIMEOUT" started health restarts
  started=$(date +%s)
  while :; do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' nearzero-control 2>/dev/null)
    [ "$health" = healthy ] && break
    restarts=$(docker inspect --format '{{.RestartCount}}' nearzero-control 2>/dev/null)
    if [ "${restarts:-0}" -ge 5 ] || [ $(($(date +%s) - started)) -ge "$timeout" ]; then
      nz_fail_start
    fi
    sleep 2
  done
  if [ -n "$later" ]; then
    nz_wait_host_work
    nz_run nz_compose up -d --no-build "$later" || nz_fail_start
  fi
  # The runner starts the router within seconds of starting itself.
  while ! nz_container_running nearzero-router; do
    if [ $(($(date +%s) - started)) -ge "$timeout" ]; then
      nz_fail_start
    fi
    sleep 2
  done
  nz_step_done "Nearzero is running"
}

# How long a rerun waits for the host's long work before it replaces the runner anyway.
NZ_HOST_WORK_WAIT=1800
NZ_HOST_WORK_NOTE=""

# A number field of a JSON line, or nothing.
nz_json_number() {
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p" | head -n 1
}

# Waits until the control plane counts no task run, backup or restore running on this server, up
# to NZ_HOST_WORK_WAIT seconds, saying what it waits for (C2-10). A control plane too old to
# count, or one that doesn't answer, isn't waited for.
nz_wait_host_work() {
  local started answer runs backups restores what shown=""
  started=$(date +%s)
  while :; do
    answer=$(nz_json_line "$(nz_compose exec -T control nearzero-control host-work --json </dev/null 2>/dev/null)")
    runs=$(nz_json_number "$answer" taskRuns)
    backups=$(nz_json_number "$answer" backups)
    restores=$(nz_json_number "$answer" restores)
    [ -n "$runs" ] && [ -n "$backups" ] && [ -n "$restores" ] || return 0
    [ $((runs + backups + restores)) -eq 0 ] && return 0
    what=""
    [ "$runs" -gt 0 ] && what="$runs task run$([ "$runs" -gt 1 ] && echo s)"
    [ "$backups" -gt 0 ] && what="${what:+$what, }$backups backup$([ "$backups" -gt 1 ] && echo s)"
    [ "$restores" -gt 0 ] && what="${what:+$what, }$restores restore$([ "$restores" -gt 1 ] && echo s)"
    if [ $(($(date +%s) - started)) -ge "$NZ_HOST_WORK_WAIT" ]; then
      NZ_HOST_WORK_NOTE="The host's runner was updated while $what still ran on this server; they stopped there, and their runs say so."
      nz_log "$NZ_HOST_WORK_NOTE"
      return 0
    fi
    if [ "$what" != "$shown" ]; then
      shown="$what"
      NZ_STEP_TEXT="Starting Nearzero (waiting for $what on this server to finish before updating its runner, up to $((NZ_HOST_WORK_WAIT / 60)) minutes)"
      if [ "$NZ_LIVE" = 1 ]; then printf '\r\033[K  %s...' "$NZ_STEP_TEXT"; else printf '  %s...\n' "$NZ_STEP_TEXT"; fi
      nz_log "waiting for $what before updating the host's runner"
    fi
    sleep 10
  done
}

# A failed start shows the service states and the last 60 log lines (spec 03 3.1).
nz_fail_start() {
  nz_step_fail
  {
    printf '\nNearzero services:\n'
    nz_compose --profile '*' ps --all 2>&1 | sed 's/^/  /'
    printf '\nThe last %s lines of the Nearzero logs:\n' "$NZ_START_LOG_LINES"
    nz_compose --profile '*' logs --no-color --tail "$NZ_START_LOG_LINES" 2>&1 | tail -n "$NZ_START_LOG_LINES" | sed 's/^/  | /'
    if docker inspect nearzero-router >/dev/null 2>&1; then
      printf '\nThe router (started by the runner):\n'
      docker logs --tail 20 nearzero-router 2>&1 | sed 's/^/  | /'
    fi
  } | tee -a "$NZ_LOG" >&2
  printf '\nNearzero did not start within %s seconds. Fix the problem above, then run the same install command again.\n' \
    "$NZ_FINAL_NEARZERO_STARTUP_TIMEOUT" >&2
  exit 1
}

# --- Admin account -----------------------------------------------------------------------------

nz_owner_step() {
  nz_step_start "Checking your admin account"
  nz_create_owner
  # Nearzero wasn't running when the questions were asked, so whether an account existed wasn't
  # known then: now that it runs and has none, the account is asked for here (B2-27).
  if [ "$NZ_OWNER_STATE" = missing ] && [ -z "$NZ_ADMIN_EMAIL" ] && [ "$NZ_INTERACTIVE" = 1 ]; then
    nz_ask_account
    nz_step_start "Creating your admin account"
    nz_create_owner
  fi
  [ "$NZ_OWNER_STATE" = missing ] && printf '%s No admin account yet\n' '-'
  return 0
}

# One create-owner through the running control plane; sets NZ_OWNER_STATE (created, exists or
# missing) and closes the step line.
nz_create_owner() {
  local output status answer
  if [ -n "$NZ_ADMIN_EMAIL" ] && [ -n "$NZ_ADMIN_PASSWORD" ]; then
    # Credentials go through standard input only: never arguments, files or the log.
    output=$(printf '%s\n%s\n' "$NZ_ADMIN_EMAIL" "$NZ_ADMIN_PASSWORD" |
      nz_compose exec -T control nearzero-control create-owner --json 2>&1)
    status=$?
  else
    output=$(nz_compose exec -T control nearzero-control create-owner --json </dev/null 2>&1)
    status=$?
  fi
  [ -n "$NZ_ADMIN_PASSWORD" ] && output="${output//"$NZ_ADMIN_PASSWORD"/********}"
  nz_log "$output"
  answer=$(nz_json_line "$output")
  NZ_OWNER_STATE="unknown"
  # create-owner --json exits 0 (created), 2 (no or bad input), 3 (an owner exists) or 4 (the
  # email has an account), with the same result in its JSON line.
  case "$status:$(nz_json_field "$answer" result)" in
    0:created)
      NZ_OWNER_STATE="created"
      NZ_OWNER_EMAIL="$NZ_ADMIN_EMAIL"
      nz_step_done "Created your admin account"
      ;;
    3:owner_exists)
      NZ_OWNER_STATE="exists"
      NZ_OWNER_EMAIL=$(nz_json_field "$answer" email)
      NZ_PASSWORD_GENERATED=0
      nz_step_done "Kept your admin account"
      ;;
    *)
      if [ -n "$NZ_ADMIN_EMAIL" ]; then
        nz_fail "Your admin account couldn't be created:" "$(printf '%s\n' "$output" | grep -v '^{' | tail -n 5 | sed 's/^/  /')"
      fi
      NZ_STEP_OPEN=0
      if [ "$NZ_LIVE" = 1 ]; then printf '\r\033[K'; fi
      NZ_OWNER_STATE="missing"
      ;;
  esac
}

# --- Summary -----------------------------------------------------------------------------------

nz_console_address() {
  if [ -n "$NZ_FINAL_NEARZERO_CONSOLE_URL" ]; then
    printf '%s' "${NZ_FINAL_NEARZERO_CONSOLE_URL%/}"
  elif [ -n "$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME" ]; then
    printf 'https://%s' "$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME"
  elif [ "$NZ_FINAL_NEARZERO_MANAGEMENT_BIND_ADDRESS" = 127.0.0.1 ]; then
    printf 'http://localhost:%s' "$NZ_FINAL_NEARZERO_CONSOLE_PORT"
  elif [ "$NZ_FINAL_NEARZERO_MANAGEMENT_BIND_ADDRESS" != 0.0.0.0 ]; then
    printf 'http://%s:%s' "$NZ_FINAL_NEARZERO_MANAGEMENT_BIND_ADDRESS" "$NZ_FINAL_NEARZERO_CONSOLE_PORT"
  else
    printf 'http://%s:%s' "$NZ_PUBLIC_IP" "$NZ_FINAL_NEARZERO_CONSOLE_PORT"
  fi
}

nz_summary() {
  local address
  address=$(nz_console_address)
  nz_say ""
  nz_say "Nearzero is ready."
  nz_say ""
  printf '  %-9s %s\n' Open "$address"
  if [ "$NZ_OWNER_STATE" = missing ]; then
    printf '  %-9s %s\n' "Sign in" "after creating your admin account with: sudo nearzero create-owner"
  elif [ -n "$NZ_OWNER_EMAIL" ] && [ "$NZ_OWNER_STATE" = exists ]; then
    # A rerun keeps the account: which one, and what to do about a forgotten password (G4-24).
    printf '  %-9s %s  (the existing account and its password)\n' "Sign in" "$NZ_OWNER_EMAIL"
    nz_say "  Forgot that password? Run: sudo nearzero reset-password"
  elif [ -n "$NZ_OWNER_EMAIL" ]; then
    printf '  %-9s %s\n' "Sign in" "$NZ_OWNER_EMAIL"
  fi
  if [ "$NZ_PASSWORD_GENERATED" = 1 ] && [ "$NZ_OWNER_STATE" = created ]; then
    printf '  %-9s %s (shown once; change it after you sign in)\n' Password "$NZ_ADMIN_PASSWORD"
  fi
  if [ -n "$NZ_FINAL_NEARZERO_PLATFORM_DOMAIN" ]; then
    # Plainly an example: no app is live at any address yet (G4-24).
    nz_say "  Apps get addresses like https://<label>.$NZ_FINAL_NEARZERO_PLATFORM_DOMAIN"
  fi
  nz_say ""
  if [ "$NZ_OWNER_STATE" = created ]; then
    nz_say "Then add your name and your workspace name when you first sign in."
    nz_say ""
  fi
  if [ -n "$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME" ]; then
    nz_say "Firewall: allow TCP 80 and 443, and UDP 443 for HTTP/3. The first visit can take a minute while the HTTPS certificate is issued."
    nz_say "Ports $NZ_FINAL_NEARZERO_API_PORT and $NZ_FINAL_NEARZERO_CONSOLE_PORT are plain HTTP: block them at your firewall now that the dashboard has HTTPS."
  elif [ "$NZ_FINAL_NEARZERO_MANAGEMENT_BIND_ADDRESS" = 127.0.0.1 ]; then
    nz_say "The console only listens on this server. Reach it through an SSH tunnel from your computer:"
    nz_say "  ssh -N -L $NZ_FINAL_NEARZERO_CONSOLE_PORT:127.0.0.1:$NZ_FINAL_NEARZERO_CONSOLE_PORT <user>@$NZ_PUBLIC_IP"
    nz_say "then open http://localhost:$NZ_FINAL_NEARZERO_CONSOLE_PORT."
  else
    nz_say "Firewall: allow TCP $NZ_FINAL_NEARZERO_CONSOLE_PORT to reach the console."
    nz_say "Ports $NZ_FINAL_NEARZERO_API_PORT and $NZ_FINAL_NEARZERO_CONSOLE_PORT are plain HTTP: once a domain serves the dashboard over HTTPS, block them at your firewall."
  fi
  nz_runner_link_note
  if [ "$NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS" = true ]; then
    local zone="$NZ_FINAL_NEARZERO_MANAGED_DNS_ZONE"
    nz_say "Delegate $zone to ns1.$zone and ns2.$zone (glue $NZ_PUBLIC_IP) and allow TCP and UDP 53."
  fi
  if [ -n "$NZ_DOMAIN_NOTE" ]; then
    printf '%s\n' "$NZ_DOMAIN_NOTE" | sed '/^$/d'
  fi
  if [ -z "$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME" ]; then
    nz_say "Add a domain with HTTPS any time: run this install command again."
  fi
  [ -z "$NZ_HOST_WORK_NOTE" ] || nz_say "$NZ_HOST_WORK_NOTE"
  return 0
}

# Servers reach Nearzero over its encrypted link (spec 31 "Remote runners are always
# encrypted"): its own TLS port with the certificate made at the first start, until the console's
# domain has its certificate, when they move to the domain by themselves (C2-07, C2-09).
nz_runner_link_fingerprint() {
  docker exec nearzero-control cat /var/lib/nearzero/runner-link/fingerprint 2>/dev/null |
    tr -d '[:space:]' | grep -E '^[0-9a-f]{64}$'
}

nz_runner_link_note() {
  local port="$NZ_FINAL_NEARZERO_RUNNER_LINK_PORT" fingerprint
  fingerprint=$(nz_runner_link_fingerprint)
  if [ -n "$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME" ]; then
    nz_say "Servers you add reach Nearzero through https://$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME once its certificate is issued, and through TCP $port (encrypted) until then: allow TCP $port from your servers."
  else
    nz_say "Servers you add reach Nearzero over an encrypted link on TCP $port: allow it from them."
  fi
  [ -n "$fingerprint" ] && nz_say "  Its certificate's SHA-256 fingerprint: $fingerprint (setup and join commands carry it)."
  return 0
}

# --- Moving a 0.1.x install (spec 29, decision D3) ----------------------------------------------
#
# A 0.1.x install keeps its settings in the same $NZ_DIR/.env. When this installer finds one, it
# runs the final 0.1.x release's `nearzero export` (spec 29.2a), checks the export with a dry-run
# import against a fresh database and shows the report, stops the 0.1.x control plane (apps keep
# running), sets its files aside under $NZ_DIR/migration/0.1, installs 1.0, imports, and follows
# the move of every service onto the 1.0 runner. `sudo nearzero migrate rollback` brings 0.1.x
# back until `sudo nearzero migrate finalize` deletes its data.

NZ_MIGRATING=0
NZ_LEGACY_VERSION=""
NZ_MIGRATION_DIR=""
NZ_MIGRATION_BUNDLE=""
NZ_MIGRATION_PASSPHRASE=""
NZ_MIGRATION_PASSPHRASE_SHOWN=0
NZ_MIGRATION_PULLED=0
NZ_MIGRATION_FAILED=0
# Settings the 0.1.x settings file holds that 1.0 reads under the same name (spec 03 3.1: the
# public settings keep their names). Internal ones (database, secrets, images) are made fresh.
NZ_LEGACY_CARRIED_KEYS="NEARZERO_PUBLIC_IP NEARZERO_MANAGEMENT_BIND_ADDRESS NEARZERO_CONSOLE_PORT
NEARZERO_API_PORT NEARZERO_HTTP_PORT NEARZERO_HTTPS_PORT NEARZERO_PLATFORM_DOMAIN
NEARZERO_MANAGEMENT_HOSTNAME NEARZERO_ACME_EMAIL NEARZERO_MANAGED_DNS_ZONE NEARZERO_MANAGED_DNS_SOA_EMAIL
NEARZERO_SSH_STRICT_HOST_KEY_CHECKING NEARZERO_METRICS_RETENTION_DAYS NEARZERO_TIME_ZONE
NEARZERO_TRUSTED_PROXIES NEARZERO_CONSOLE_URL NEARZERO_EMAIL_FROM NEARZERO_RESEND_API_KEY NEARZERO_SMTP_URL
NEARZERO_DNS_BIND_ADDRESS NEARZERO_DNS_PORT NEARZERO_TRUSTED_ORIGINS NEARZERO_REGISTRATION_MODE
NEARZERO_HEROKU_BUILDER_IMAGE NEARZERO_PAKETO_BUILDER_IMAGE NEARZERO_RAILPACK_FRONTEND_IMAGE
NEARZERO_STATIC_NGINX_IMAGE NEARZERO_METRICS_REFRESH_SECONDS"
# 0.1.x setting names 1.0 reads under a 1.0 name, as OLD=NEW pairs (spec 03 3.5): the aliases
# above (apps/control/src/migration/install.ts keeps the same table).
NZ_SETTING_RENAMES="$NZ_SETTING_ALIASES"

# An older 0.1.x moves to the final 0.1.x release first, with that release's own installer, from
# the versioned address 0.1.x publishes it at (G4-02).
nz_stop_legacy_update() {
  nz_stop "This server runs Nearzero $1. Update it to $NZ_LEGACY_FINAL_VERSION first: curl -fsSL $NZ_LEGACY_RELEASE_URL/install.sh | sudo bash. Then run this install command again." \
    "That installer's SHA-256 checksum is published beside it: $NZ_LEGACY_RELEASE_URL/install.sh.sha256"
}

# The 0.1.x version its settings file names, or nothing.
nz_legacy_version_of() {
  sed -n 's/^[[:space:]]*NEARZERO_VERSION=//p' "$1" 2>/dev/null | tail -n 1 | tr -d '\r"'"'"
}

# True when a settings file belongs to a 0.1.x install (spec 29.2 step 2): its version is
# 0.1.something; or, for releases before the final one (which don't write a version), it has no
# 1.0 marker (NEARZERO_EDITION=1, which every 1.0 install writes) and a 0.1.x control-plane
# container is running or present.
nz_is_legacy_settings() {
  local file="$1" version
  [ -f "$file" ] || return 1
  version=$(nz_legacy_version_of "$file")
  case "$version" in
    0.1.*) return 0 ;;
    "") ;;
    *) return 1 ;;
  esac
  grep -q '^[[:space:]]*NEARZERO_EDITION=1[[:space:]]*$' "$file" 2>/dev/null && return 1
  nz_legacy_control_plane_present
}

# A container or Swarm service named nearzero… that isn't one of 1.0's own: 1.0's containers,
# and every container its runner creates, carry the dev.nearzero.managed or
# dev.nearzero.component label.
nz_legacy_control_plane_present() {
  nz_has docker || return 1
  local name managed component
  while IFS='|' read -r name managed component; do
    case "$name" in nearzero*) ;; *) continue ;; esac
    [ -z "$managed" ] && [ -z "$component" ] && return 0
  done < <(docker ps -a --format '{{.Names}}|{{.Label "dev.nearzero.managed"}}|{{.Label "dev.nearzero.component"}}' 2>/dev/null)
  while read -r name; do
    case "$name" in nearzero*) return 0 ;; esac
  done < <(docker service ls --format '{{.Name}}' 2>/dev/null)
  return 1
}

# Finds a 0.1.x install and checks it is on the final 0.1.x release (spec 29.2 step 2).
nz_migration_detect() {
  NZ_MIGRATION_DIR="$NZ_DIR/migration"
  # A move that stopped half way is undone before anything else runs.
  case "$(cut -d' ' -f1 "$NZ_MIGRATION_DIR/state" 2>/dev/null)" in
    moving)
      nz_stop "A move from Nearzero 0.1.x on this server didn't finish." \
        "Go back to 0.1.x with: sudo nearzero migrate rollback. Then run this install command again."
      ;;
  esac
  nz_is_legacy_settings "$NZ_ENV_FILE" || return 0
  NZ_LEGACY_VERSION=$(nz_legacy_version_of "$NZ_ENV_FILE")
  local shown="${NZ_LEGACY_VERSION:-an older 0.1.x release}"
  if [ -n "$NZ_LEGACY_VERSION" ] && nz_version_newer "$NZ_LEGACY_FINAL_VERSION" "$NZ_LEGACY_VERSION"; then
    nz_stop_legacy_update "$shown"
  fi
  [ "$NZ_DRY_RUN" = 1 ] && { NZ_MIGRATING=1; return 0; }
  # Only the final 0.1.x release has the export command (spec 29.2a).
  local format
  format=$("$NZ_COMMAND_PATH" export --version 2>/dev/null | tail -n 1)
  if [ "$format" != 1 ]; then
    nz_stop_legacy_update "$shown"
  fi
  NZ_MIGRATING=1
}

# 1.0 reads the 0.1.x public settings it shares, under their 1.0 names.
nz_read_legacy_settings() {
  local key value pair old new
  for key in $NZ_LEGACY_CARRIED_KEYS; do
    value=$(sed -n "s/^[[:space:]]*$key=//p" "$NZ_ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '\r')
    [ -n "$value" ] || continue
    nz_value_is_plain "$value" || continue
    nz_set "NZ_SAVED_$key" "$value"
  done
  for pair in $NZ_SETTING_RENAMES; do
    old="${pair%%=*}" new="${pair#*=}"
    value=$(sed -n "s/^[[:space:]]*$old=//p" "$NZ_ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '\r')
    [ -n "$value" ] && nz_value_is_plain "$value" && [ -z "$(nz_get "NZ_SAVED_$new")" ] &&
      nz_set "NZ_SAVED_$new" "$value"
  done
}

# Explains the move and asks (spec 29.2 step 2), or checks the unattended settings.
nz_migration_confirm() {
  local passphrase="$NZ_ENV_NEARZERO_MIGRATION_PASSPHRASE"
  if [ -n "$passphrase" ] && [ "${#passphrase}" -lt 16 ]; then
    nz_stop "NEARZERO_MIGRATION_PASSPHRASE must be at least 16 characters."
  fi
  NZ_MIGRATION_PASSPHRASE="$passphrase"
  if [ "$NZ_INTERACTIVE" = 0 ]; then
    if [ "$(nz_lower "$NZ_ENV_NEARZERO_MIGRATE")" != yes ] || [ -z "$passphrase" ]; then
      nz_stop "This server runs Nearzero ${NZ_LEGACY_VERSION:-0.1.x}. To move it to Nearzero 1.0 without a terminal, set NEARZERO_MIGRATE=yes and NEARZERO_MIGRATION_PASSPHRASE (at least 16 characters), then run the install command again."
    fi
    return 0
  fi
  nz_say ""
  nz_say "This server runs Nearzero ${NZ_LEGACY_VERSION:-0.1.x}. This install command moves it to Nearzero 1.0:"
  nz_say "  1. It exports accounts, workspaces, projects and settings to a file encrypted with a passphrase."
  nz_say "  2. It checks the export and shows what will move. Nothing changes before you confirm."
  nz_say "  3. It stops the 0.1.x console and API (your apps keep running), installs 1.0 and imports."
  nz_say "  4. It redeploys each app and database on 1.0 with its data, addresses and certificates."
  nz_say "The 0.1.x data stays on this server, stopped, until you run: sudo nearzero migrate finalize"
  while :; do
    nz_ask "Move this install to Nearzero 1.0? Your apps restart once, briefly; data, addresses and passwords are kept. [y/N] "
    case "$(nz_lower "$NZ_ANSWER")" in
      y | yes) return 0 ;;
      "" | n | no)
        nz_say "Nothing was changed. This server still runs Nearzero ${NZ_LEGACY_VERSION:-0.1.x}."
        exit 1
        ;;
      *) nz_say "Answer y or n." ;;
    esac
  done
}

# Stops, starts again or removes a 0.1.x workload: a Swarm service (scaled to zero and back to its
# earlier replica count), a container, or a Compose project. Volumes are never removed here.
# The lines of control-plane.txt that name a workload ("volume", "project", "folder" and "port"
# lines are read on their own).
nz_is_workload_kind() {
  case "$1" in container | swarm-service | swarm-stack | compose-project) return 0 ;; esac
  return 1
}

# A Swarm service's published ports as "published:target:protocol:mode" words (spec 29.5). Swarm
# holds them even at zero replicas, so stopping lets go of them (kept in the label
# dev.nearzero.migration.ports, which the runner reads and writes too) and starting adds them back.
nz_swarm_ports() {
  docker service inspect --format '{{range .Spec.EndpointSpec.Ports}}{{.PublishedPort}}:{{.TargetPort}}:{{.Protocol}}:{{.PublishMode}} {{end}}' "$1" 2>/dev/null
}

nz_swarm_stop() {
  local name="$1" mode="$2" ports word rest args=()
  ports=$(nz_swarm_ports "$name")
  ports="${ports% }"
  [ "$mode" = 0 ] && [ -z "$ports" ] && return 0
  [ "$mode" != 0 ] && args+=(--label-add "dev.nearzero.migration.replicas=$mode")
  if [ -n "$ports" ]; then
    args+=(--label-add "dev.nearzero.migration.ports=$ports")
    for word in $ports; do
      rest="${word#*:}"
      args+=(--publish-rm "${rest%%:*}/$(printf '%s' "$rest" | cut -d: -f2)")
    done
  fi
  docker service update --detach "${args[@]}" --replicas 0 "$name" >/dev/null
}

nz_swarm_start() {
  local name="$1" mode="$2" wanted kept word pub tgt proto pm args=()
  wanted=$(docker service inspect --format '{{index .Spec.Labels "dev.nearzero.migration.replicas"}}' "$name")
  case "$wanted" in '' | *[!0-9]*) wanted="" ;; esac
  kept=$(docker service inspect --format '{{index .Spec.Labels "dev.nearzero.migration.ports"}}' "$name")
  if [ -n "$wanted" ]; then
    args+=(--label-rm dev.nearzero.migration.replicas --replicas "$wanted")
  elif [ "$mode" = 0 ]; then
    args+=(--replicas 1)
  fi
  if [ -n "$kept" ]; then
    args+=(--label-rm dev.nearzero.migration.ports)
    for word in $kept; do
      case "$word" in *[!0-9a-z:]* | *:*:*:*:*) continue ;; esac
      IFS=: read -r pub tgt proto pm <<<"$word"
      args+=(--publish-add "published=$pub,target=$tgt,protocol=$proto,mode=$pm")
    done
  fi
  [ "${#args[@]}" -gt 0 ] || return 0
  docker service update --detach "${args[@]}" "$name" >/dev/null
}

nz_legacy_workload() {
  local action="$1" kind="$2" name="$3" mode ids id
  case "$name" in *[!A-Za-z0-9_.-]* | "") return 1 ;; esac
  case "$kind" in
    swarm-stack)
      for ids in $(docker service ls -q --filter "label=com.docker.stack.namespace=$name" 2>/dev/null); do
        nz_legacy_workload "$action" swarm-service "$ids" || return 1
      done
      ;;
    swarm-service)
      docker service inspect "$name" >/dev/null 2>&1 || return 0
      mode=$(docker service inspect --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}global{{end}}' "$name")
      case "$action" in
        stop)
          [ "$mode" = global ] && return 1
          nz_swarm_stop "$name" "$mode"
          ;;
        start) nz_swarm_start "$name" "$mode" ;;
        remove) docker service rm "$name" >/dev/null ;;
      esac
      ;;
    container)
      docker inspect "$name" >/dev/null 2>&1 || return 0
      # 1.0's own containers are never treated as 0.1.x's (spec 29.5).
      [ "$(docker inspect --format '{{index .Config.Labels "dev.nearzero.edition"}}' "$name" 2>/dev/null)" = 1 ] && return 0
      case "$action" in
        stop) docker stop -t 30 "$name" >/dev/null ;;
        start) docker start "$name" >/dev/null ;;
        remove) docker rm -fv "$name" >/dev/null ;;
      esac
      ;;
    compose-project)
      # The project's 0.1.x containers only, one by one.
      ids=""
      for id in $(docker ps -aq --filter "label=com.docker.compose.project=$name"); do
        [ "$(docker inspect --format '{{index .Config.Labels "dev.nearzero.edition"}}' "$id" 2>/dev/null)" = 1 ] ||
          ids="$ids $id"
      done
      [ -n "$ids" ] || return 0
      # shellcheck disable=SC2086
      case "$action" in
        stop) docker stop -t 30 $ids >/dev/null ;;
        start) docker start $ids >/dev/null ;;
        remove) docker rm -fv $ids >/dev/null ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

# Runs the 1.0 command line on a temporary database: the dry-run import (spec 29.2 step 4) and the
# list of the 0.1.x control plane's workloads. Secrets reach containers through the environment.
nz_migration_check() {
  local net="nearzero-migration-check" db="nearzero-migration-db" password secret ready=0
  password=$(nz_random_hex 16)
  secret=$(nz_random_hex 32)
  docker rm -fv "$db" >/dev/null 2>&1
  docker network rm "$net" >/dev/null 2>&1
  nz_run docker network create --label dev.nearzero.managed=true --label dev.nearzero.edition=1 "$net" || return 1
  if ! POSTGRES_PASSWORD="$password" docker run -d --name "$db" --network "$net" \
    --label dev.nearzero.managed=true --label dev.nearzero.edition=1 \
    -e POSTGRES_USER=nearzero -e POSTGRES_DB=nearzero \
    -e POSTGRES_PASSWORD "$NZ_FINAL_NEARZERO_POSTGRES_IMAGE" >>"$NZ_LOG" 2>&1; then
    docker network rm "$net" >/dev/null 2>&1
    return 1
  fi
  for _ in $(seq 1 90); do
    if docker exec "$db" pg_isready -U nearzero -d nearzero >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  local status=1
  if [ "$ready" = 1 ]; then
    # The database answers before its first start is over; wait for it to accept a query.
    sleep 3
    NZ_MIGRATION_REPORT=$(DATABASE_URL="postgres://nearzero:$password@$db:5432/nearzero" \
      NEARZERO_AUTH_SECRET="$secret" NEARZERO_MIGRATION_PASSPHRASE="$NZ_MIGRATION_PASSPHRASE" \
      NEARZERO_PLATFORM_DOMAIN="$NZ_FINAL_NEARZERO_PLATFORM_DOMAIN" \
      NEARZERO_MANAGEMENT_HOSTNAME="$NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME" \
      NEARZERO_PUBLIC_IP="$NZ_PUBLIC_IP" \
      docker run --rm -i --network "$net" --entrypoint nearzero-control \
      -e DATABASE_URL -e NEARZERO_AUTH_SECRET -e NEARZERO_MIGRATION_PASSPHRASE \
      -e NEARZERO_PLATFORM_DOMAIN -e NEARZERO_MANAGEMENT_HOSTNAME -e NEARZERO_PUBLIC_IP \
      "$NZ_FINAL_NEARZERO_IMAGE" import --dry-run - <"$NZ_MIGRATION_BUNDLE" 2>&1)
    status=$?
    if [ "$status" = 0 ]; then
      DATABASE_URL="postgres://nearzero:$password@$db:5432/nearzero" NEARZERO_AUTH_SECRET="$secret" \
        NEARZERO_MIGRATION_PASSPHRASE="$NZ_MIGRATION_PASSPHRASE" \
        docker run --rm -i --network "$net" --entrypoint nearzero-control \
        -e DATABASE_URL -e NEARZERO_AUTH_SECRET -e NEARZERO_MIGRATION_PASSPHRASE \
        "$NZ_FINAL_NEARZERO_IMAGE" migrate control-plane - <"$NZ_MIGRATION_BUNDLE" \
        >"$NZ_MIGRATION_DIR/control-plane.txt" 2>>"$NZ_LOG" || status=$?
    fi
  else
    NZ_MIGRATION_REPORT="The temporary database for the check didn't start."
  fi
  docker rm -fv "$db" >/dev/null 2>&1
  docker network rm "$net" >/dev/null 2>&1
  return "$status"
}

# Exports, checks, confirms, stops the 0.1.x control plane and sets its files aside (spec 29.2
# steps 3 to 5). Runs after the questions and before 1.0's files are written.
nz_migration_prepare() {
  (umask 077 && mkdir -p "$NZ_MIGRATION_DIR") && chmod 0700 "$NZ_MIGRATION_DIR" ||
    nz_fail "Couldn't create $NZ_MIGRATION_DIR."
  # What this attempt creates carries its name, so rollback removes exactly that (spec 29.5).
  printf '%s\n' "$NZ_FINAL_NEARZERO_MIGRATION_ATTEMPT" >"$NZ_MIGRATION_DIR/attempt"
  if [ -z "$NZ_MIGRATION_PASSPHRASE" ]; then
    NZ_MIGRATION_PASSPHRASE="$(nz_random_password)$(nz_random_password)"
    NZ_MIGRATION_PASSPHRASE_SHOWN=1
  fi

  nz_step_start "Exporting Nearzero ${NZ_LEGACY_VERSION:-0.1.x}"
  local output status line
  output=$(NEARZERO_MIGRATION_PASSPHRASE="$NZ_MIGRATION_PASSPHRASE" "$NZ_COMMAND_PATH" export </dev/null 2>&1)
  status=$?
  output="${output//"$NZ_MIGRATION_PASSPHRASE"/********}"
  nz_log "$output"
  if [ "$status" = 2 ]; then
    nz_step_fail
    nz_stop_legacy_update "${NZ_LEGACY_VERSION:-0.1.x}"
  fi
  line=$(printf '%s\n' "$output" | grep '^NEARZERO_EXPORT_OK ' | tail -n 1)
  [ "$status" = 0 ] && [ -n "$line" ] || nz_fail "The 0.1.x export failed:" "$(printf '%s\n' "$output" | tail -n 5 | sed 's/^/  /')"
  NZ_MIGRATION_BUNDLE=$(printf '%s' "$line" | cut -d' ' -f2)
  local expected actual
  expected=$(printf '%s' "$line" | cut -d' ' -f3)
  actual=$(sha256sum "$NZ_MIGRATION_BUNDLE" 2>/dev/null | cut -d' ' -f1)
  [ -n "$actual" ] && [ "$actual" = "$expected" ] ||
    nz_fail "The export at $NZ_MIGRATION_BUNDLE doesn't match the checksum the export printed."
  nz_step_done "Exported Nearzero ${NZ_LEGACY_VERSION:-0.1.x} to $NZ_MIGRATION_BUNDLE"
  if [ "$NZ_MIGRATION_PASSPHRASE_SHOWN" = 1 ]; then
    nz_say ""
    nz_say "Keep this passphrase: you need it to undo the move."
    printf '  %s\n' "$NZ_MIGRATION_PASSPHRASE"
    nz_say ""
  fi

  nz_ensure_docker
  nz_pull_images
  NZ_MIGRATION_PULLED=1

  nz_step_start "Checking the export"
  NZ_MIGRATION_REPORT=""
  nz_migration_check || nz_fail "The export can't be imported:" "$(printf '%s\n' "$NZ_MIGRATION_REPORT" | tail -n 8 | sed 's/^/  /')"
  nz_step_done "Checked the export"
  nz_say ""
  printf '%s\n' "$NZ_MIGRATION_REPORT" | sed 's/^/  /'
  nz_say ""
  if [ "$NZ_INTERACTIVE" = 1 ]; then
    while :; do
      nz_ask "Continue with the move? [y/N] "
      case "$(nz_lower "$NZ_ANSWER")" in
        y | yes) break ;;
        "" | n | no)
          nz_say "Nothing was changed. Nearzero ${NZ_LEGACY_VERSION:-0.1.x} keeps running; the export stays in $NZ_MIGRATION_BUNDLE."
          exit 1
          ;;
        *) nz_say "Answer y or n." ;;
      esac
    done
  fi

  nz_step_start "Stopping the 0.1.x console and API"
  local kind name
  while read -r kind name; do
    nz_is_workload_kind "$kind" && [ -n "$name" ] || continue
    nz_legacy_workload stop "$kind" "$name" >>"$NZ_LOG" 2>&1 ||
      nz_migration_undo "Couldn't stop $name of the 0.1.x control plane."
  done <"$NZ_MIGRATION_DIR/control-plane.txt"
  # Its files are set aside, never deleted, so rollback finds them as they were.
  mkdir -p "$NZ_MIGRATION_DIR/0.1/files" && chmod 0700 "$NZ_MIGRATION_DIR/0.1" || nz_migration_undo "Couldn't create $NZ_MIGRATION_DIR/0.1."
  printf '%s\n' "${NZ_LEGACY_VERSION:-0.1.x}" >"$NZ_MIGRATION_DIR/0.1/version"
  cp -p "$NZ_COMMAND_PATH" "$NZ_MIGRATION_DIR/0.1/nearzero" 2>/dev/null
  local path
  for path in compose.yml router dns; do
    [ -e "$NZ_DIR/$path" ] && mv -f "$NZ_DIR/$path" "$NZ_MIGRATION_DIR/0.1/files/"
  done
  mv -f "$NZ_ENV_FILE" "$NZ_MIGRATION_DIR/0.1/env" || nz_migration_undo "Couldn't set $NZ_ENV_FILE aside."
  printf 'moving %s\n' "$NZ_MIGRATION_BUNDLE" >"$NZ_MIGRATION_DIR/state"
  nz_step_done "Stopped the 0.1.x console and API; your apps keep running"

  nz_migration_ports_free
}

# The ports the 0.1.x control plane held are free once it stopped; what still holds one is named,
# as on a first install (C2-21), with the ports this install uses.
nz_migration_ports_free() {
  local port shown="" holders
  if [ -n "$(nz_listeners)" ]; then
    for port in "$NZ_FINAL_NEARZERO_HTTP_PORT" "$NZ_FINAL_NEARZERO_HTTPS_PORT" \
      "$NZ_FINAL_NEARZERO_CONSOLE_PORT" "$NZ_FINAL_NEARZERO_API_PORT" "$NZ_FINAL_NEARZERO_RUNNER_LINK_PORT"; do
      nz_port_busy "$port" tcp || continue
      holders=$(nz_port_holders "$port" tcp)
      shown="${shown:+$shown, }$port${holders:+ ($holders)}"
    done
  fi
  [ -z "$shown" ] || nz_migration_undo "Nearzero 1.0 needs TCP ports $NZ_FINAL_NEARZERO_HTTP_PORT, $NZ_FINAL_NEARZERO_HTTPS_PORT, $NZ_FINAL_NEARZERO_CONSOLE_PORT, $NZ_FINAL_NEARZERO_API_PORT and $NZ_FINAL_NEARZERO_RUNNER_LINK_PORT, and these are still in use after 0.1.x stopped: $shown. Stop what uses them (see: ss -ltnp)."
}

# Puts the 0.1.x install back as it was before nz_migration_prepare changed anything, then stops.
nz_migration_undo() {
  local kind name
  [ -f "$NZ_MIGRATION_DIR/0.1/env" ] && [ ! -f "$NZ_ENV_FILE" ] && mv -f "$NZ_MIGRATION_DIR/0.1/env" "$NZ_ENV_FILE"
  if [ -d "$NZ_MIGRATION_DIR/0.1/files" ]; then
    for name in compose.yml router dns; do
      [ -e "$NZ_MIGRATION_DIR/0.1/files/$name" ] && [ ! -e "$NZ_DIR/$name" ] && mv -f "$NZ_MIGRATION_DIR/0.1/files/$name" "$NZ_DIR/"
    done
  fi
  while read -r kind name; do
    nz_is_workload_kind "$kind" && [ -n "$name" ] || continue
    nz_legacy_workload start "$kind" "$name" >>"$NZ_LOG" 2>&1
  done <"$NZ_MIGRATION_DIR/control-plane.txt"
  rm -f "$NZ_MIGRATION_DIR/state"
  nz_fail "$1" "Nearzero ${NZ_LEGACY_VERSION:-0.1.x} was started again as it was."
}

# Imports into the running 1.0 control plane and follows the move (spec 29.2 step 5).
nz_migration_import() {
  nz_step_start "Importing Nearzero ${NZ_LEGACY_VERSION:-0.1.x}"
  local output status
  output=$(NEARZERO_MIGRATION_PASSPHRASE="$NZ_MIGRATION_PASSPHRASE" docker exec -i \
    -e NEARZERO_MIGRATION_PASSPHRASE nearzero-control nearzero-control import --in-place - \
    <"$NZ_MIGRATION_BUNDLE" 2>&1)
  status=$?
  nz_log "$output"
  if [ "$status" != 0 ]; then
    nz_step_fail
    printf '%s\n' "$output" | tail -n 8 | sed 's/^/  /' >&2
    nz_say ""
    nz_say "Nothing was imported. Go back to Nearzero ${NZ_LEGACY_VERSION:-0.1.x} with: sudo nearzero migrate rollback"
    exit 1
  fi
  nz_step_done "Imported Nearzero ${NZ_LEGACY_VERSION:-0.1.x}"
  printf 'imported %s\n' "$NZ_MIGRATION_BUNDLE" >"$NZ_MIGRATION_DIR/state"
  nz_say ""
  nz_say "Moving your apps and databases onto Nearzero 1.0, one at a time:"
  # One line per service as it finishes ("web on prod-1: moved").
  docker exec nearzero-control nearzero-control migrate status --wait 2>>"$NZ_LOG" | sed 's/^/  /'
  status=${PIPESTATUS[0]}
  [ "$status" = 0 ] || NZ_MIGRATION_FAILED=1
  printf 'moved %s\n' "$NZ_MIGRATION_BUNDLE" >"$NZ_MIGRATION_DIR/state"
  NZ_OWNER_STATE="imported"
}

nz_migration_summary() {
  nz_say ""
  nz_say "Moved from Nearzero ${NZ_LEGACY_VERSION:-0.1.x}. Everyone signs in with their old password."
  if [ "$NZ_MIGRATION_FAILED" = 1 ]; then
    nz_say "Some services didn't move and keep running on 0.1.x. See them with: sudo nearzero migrate status"
    nz_say "Fix the cause, then run: sudo nearzero migrate retry"
  fi
  nz_say "Go back to 0.1.x: sudo nearzero migrate rollback"
  nz_say "When everything works, delete the 0.1.x data: sudo nearzero migrate finalize"
}

# --- Dry run -----------------------------------------------------------------------------------

nz_dry_run_report() {
  local key value
  nz_say ""
  nz_say "Dry run: nothing was changed. This run would write $NZ_ENV_FILE with:"
  for key in $NZ_KNOWN_KEYS; do
    value=$(nz_get "NZ_FINAL_$key")
    [ -n "$value" ] || continue
    case "$key" in
      NEARZERO_AUTH_SECRET | NEARZERO_METRICS_TOKEN | NEARZERO_DATABASE_PASSWORD)
        if [ -n "$(nz_get "NZ_SAVED_$key")" ]; then value="(kept)"; else value="(generated)"; fi
        ;;
      NEARZERO_RESEND_API_KEY) value="(set)" ;;
      DATABASE_URL | NEARZERO_SMTP_URL) value=$(printf '%s' "$value" | sed 's#://\([^:/@]*\):[^@]*@#://\1:********@#') ;;
    esac
    printf '  %s=%s\n' "$key" "$value"
  done
  if [ -n "$NZ_EXTRA_LINES" ]; then
    printf '  and %s line(s) of your own, carried forward\n' "$(printf '%s' "$NZ_EXTRA_LINES" | grep -c .)"
  fi
  nz_images_for_profiles
  nz_say "Images: $NZ_IMAGES"
  if [ "$NZ_MIGRATING" = 1 ]; then
    nz_say "Accounts: from the 0.1.x export"
  elif [ -n "$NZ_ADMIN_EMAIL" ]; then
    if [ "$NZ_PASSWORD_GENERATED" = 1 ]; then
      nz_say "Admin account: $NZ_ADMIN_EMAIL with a generated password"
    else
      nz_say "Admin account: $NZ_ADMIN_EMAIL"
    fi
  else
    nz_say "Admin account: none given"
  fi
  nz_say "Console: $(nz_console_address)"
}

# --- Main --------------------------------------------------------------------------------------

nz_parse_arguments() {
  local argument
  for argument in "$@"; do
    case "$argument" in
      --dry-run) NZ_ENV_NEARZERO_DRY_RUN=true ;;
      --verbose) NZ_ENV_NEARZERO_VERBOSE=true ;;
      --unattended | --yes | -y) NZ_ENV_NEARZERO_UNATTENDED=true ;;
      -h | --help)
        nz_say "Usage: $NZ_INSTALL_COMMAND"
        nz_say "       ... | sudo bash -s -- [--unattended] [--verbose] [--dry-run]"
        nz_say "Install settings are environment variables; see https://nearzero.dev/docs/install."
        exit 0
        ;;
      *) nz_stop "Unknown option: $argument. Run with --help to see the options." ;;
    esac
  done
}

# Runs the installer as root, through sudo when needed (spec 03 3.1, preflight).
nz_require_root() {
  [ "$NZ_DRY_RUN" = 1 ] && return 0
  [ "$(id -u)" = 0 ] && return 0
  if ! nz_has sudo; then
    nz_stop "Run the installer as root: $NZ_INSTALL_COMMAND"
  fi
  # Re-run this same script through sudo, keeping the install settings. A piped script has no
  # file to re-run, so its functions are written to a private temporary file first.
  local self="$0" keep="" name
  if [ ! -f "$self" ] || ! grep -q 'nz_require_root' "$self" 2>/dev/null; then
    self=$(mktemp "${TMPDIR:-/tmp}/nearzero-install.XXXXXX") || nz_stop "Run the installer as root: $NZ_INSTALL_COMMAND"
    {
      # The copy removes itself once bash has opened it.
      # shellcheck disable=SC2016
      printf '#!/usr/bin/env bash\nrm -f -- "$0"\nset -o pipefail\n'
      # shellcheck disable=SC2046
      declare -p $(compgen -v | grep '^NZ_[A-Z0-9_]*$' | grep -v '^NZ_\(ENV\|SAVED\|FINAL\|LINE\)_')
      declare -f
      # shellcheck disable=SC2016
      printf 'main "$@"\n'
    } >"$self" 2>/dev/null
    chmod 0700 "$self"
  fi
  for name in $(compgen -e | grep -E '^(NEARZERO_[A-Z0-9_]+|DATABASE_URL|REDIS_URL)$') \
    $(for plain in $NZ_PLAIN_LEGACY_NAMES; do [ -n "${!plain+set}" ] && printf '%s\n' "$plain"; done); do
    keep="${keep:+$keep,}$name"
  done
  if [ -n "$keep" ]; then
    exec sudo --preserve-env="$keep" bash "$self" "$@"
  fi
  exec sudo bash "$self" "$@"
}

nz_open_terminal() {
  NZ_TTY_OK=0
  if (exec 3</dev/tty 4>/dev/tty) 2>/dev/null; then
    exec 3</dev/tty 4>/dev/tty
    NZ_TTY_OK=1
  fi
}

main() {
  nz_parse_arguments "$@"
  NZ_DRY_RUN=0
  [ "$(nz_bool "${NEARZERO_DRY_RUN:-${NZ_ENV_NEARZERO_DRY_RUN:-${DRY_RUN:-false}}}" 2>/dev/null)" = true ] && NZ_DRY_RUN=1
  nz_require_root "$@"
  trap nz_interrupted INT TERM
  trap nz_restore_terminal EXIT

  nz_read_environment
  [ "$(nz_bool "${NZ_ENV_NEARZERO_VERBOSE:-false}" 2>/dev/null)" = true ] && NZ_VERBOSE=1
  [ "$(nz_bool "${NZ_ENV_NEARZERO_DRY_RUN:-false}" 2>/dev/null)" = true ] && NZ_DRY_RUN=1
  nz_choose_install_dir
  NZ_ENV_FILE="$NZ_DIR/.env"
  [ -t 1 ] && [ "$NZ_VERBOSE" = 0 ] && NZ_LIVE=1

  nz_detect_platform
  if [ "$NZ_DRY_RUN" = 0 ]; then
    [ "$(uname -s)" = Linux ] || nz_stop "Nearzero installs on Linux servers; this is $(uname -s)."
    [ "$NZ_ARCH" != unsupported ] || nz_stop "Nearzero runs on amd64 and arm64 servers; this one is $(uname -m)."
  fi

  nz_say ""
  nz_say "Nearzero $NZ_VERSION"
  nz_say "Self-hosted Platform as a Service · Community Edition"
  [ -z "$NZ_IGNORED_NOTE" ] || nz_say "$NZ_IGNORED_NOTE"

  # A 0.1.x install in the same folder moves to 1.0 (spec 29); its settings file isn't 1.0's.
  nz_migration_detect
  if [ "$NZ_MIGRATING" = 1 ]; then
    nz_read_legacy_settings
  else
    nz_read_saved_settings "$NZ_ENV_FILE"
  fi
  # 1.0's data without its settings file: stop before any question, file or container.
  nz_check_data_without_settings
  nz_check_settings
  nz_open_terminal
  nz_decide_mode
  nz_decide_public_ip
  [ "$NZ_HAVE_SAVED" = 1 ] && nz_say "Found Nearzero in $NZ_DIR: this run upgrades it and keeps its settings."
  [ "$NZ_MIGRATING" = 1 ] && [ "$NZ_DRY_RUN" = 0 ] && nz_migration_confirm

  # Questions first: nothing is downloaded or changed before they are answered.
  nz_decide_account
  nz_offer_domain
  nz_decide_settings
  # Moving from 0.1.x: its control plane holds the ports until it stops (nz_migration_prepare).
  [ "$NZ_MIGRATING" = 1 ] || nz_check_ports
  nz_check_name_collisions

  if [ "$NZ_DRY_RUN" = 1 ]; then
    nz_dry_run_report
    [ "$NZ_MIGRATING" = 1 ] && nz_say "Nearzero ${NZ_LEGACY_VERSION:-0.1.x} was found: a real run would export it, check the export, and move it to 1.0."
    exit 0
  fi

  nz_say ""
  mkdir -p "$NZ_DIR" && chmod 0755 "$NZ_DIR" || nz_stop "Couldn't create $NZ_DIR."
  NZ_LOG="$NZ_DIR/install.log"
  (umask 077 && touch "$NZ_LOG") && chmod 0600 "$NZ_LOG" || nz_stop "Couldn't write $NZ_LOG."
  nz_log ""
  nz_log "=== Nearzero installer $NZ_VERSION, $(date -u '+%Y-%m-%d %H:%M:%S UTC'), ${NZ_OS_NAME:-unknown system}, $NZ_ARCH"
  if [ "$NZ_MIGRATING" = 1 ]; then
    nz_migration_prepare
    # From here on `sudo nearzero migrate rollback` can undo the move, whatever happens next.
    nz_install_command || nz_fail "Couldn't install the nearzero command at $NZ_COMMAND_PATH."
  fi

  nz_step_start "Saving the configuration"
  nz_write_env_file || nz_fail "Couldn't write $NZ_ENV_FILE."
  nz_write_compose_file || nz_fail "Couldn't write $NZ_DIR/compose.yml."
  nz_write_router_files || nz_fail "Couldn't write $NZ_DIR/router."
  nz_write_dns_files || nz_fail "Couldn't write $NZ_DIR/dns."
  nz_step_done "Saved the configuration in $NZ_DIR"

  nz_ensure_docker
  [ "$NZ_MIGRATION_PULLED" = 1 ] || nz_pull_images
  nz_start
  nz_install_command || nz_fail "Couldn't install the nearzero command at $NZ_COMMAND_PATH."
  if [ "$NZ_MIGRATING" = 1 ]; then
    nz_migration_import
  else
    nz_owner_step
  fi
  nz_summary
  [ "$NZ_MIGRATING" = 1 ] && nz_migration_summary
  NZ_ADMIN_PASSWORD=""
  NZ_MIGRATION_PASSPHRASE=""
}

nz_write_compose_file() {
  (umask 022 && nz_compose_file_contents >"$NZ_DIR/compose.yml.tmp") &&
    mv -f "$NZ_DIR/compose.yml.tmp" "$NZ_DIR/compose.yml"
}

nz_install_command() {
  # The command finds this install's folder without settings, since sudo drops them (B2-26).
  # nz_choose_install_dir allows no character sed would read in the replacement.
  (umask 022 && nz_command_file_contents |
    sed "s|^NZC_DIR=\"\\\${NEARZERO_INSTALL_DIR:-$NZ_DEFAULT_DIR}\"\$|NZC_DIR=\"\\\${NEARZERO_INSTALL_DIR:-$NZ_DIR}\"|" \
      >"$NZ_COMMAND_PATH.tmp") &&
    chmod 0755 "$NZ_COMMAND_PATH.tmp" && mv -f "$NZ_COMMAND_PATH.tmp" "$NZ_COMMAND_PATH" || return 1
  nz_link_command
}

# Links the command into /usr/bin unless something else of that name is there. A read-only /usr
# (an image-based system) keeps the command where it is; that never fails the install.
nz_link_command() {
  # A link already there (ours or someone's) and any other file of that name are left alone.
  [ -L "$NZ_COMMAND_LINK" ] || [ -e "$NZ_COMMAND_LINK" ] && return 0
  ln -s "$NZ_COMMAND_PATH" "$NZ_COMMAND_LINK" 2>/dev/null || true
  return 0
}

# --- Embedded files (kept in sync with installer/compose.yml and installer/nearzero by
# --- `bun installer/scripts/embed.ts`; a unit test checks they match) -------------------------

nz_compose_file_contents() {
  cat <<'NEARZERO_EMBEDDED_COMPOSE'
# Nearzero on this server (spec 03 3.1). The installer writes this file to /opt/nearzero/compose.yml
# and every setting it reads to /opt/nearzero/.env beside it. Don't edit either by hand: run the
# install command again to change settings, and use `sudo nearzero` to operate it.
#
# Services, each started only when its profile is listed in COMPOSE_PROFILES in .env:
#   control   the console (4321), the API (3000) and the runner link (3443, TLS)   always
#   runner    this server's runner: deploys here, keeps the router running         always
#   postgres  the bundled database, never published                                profile "database" (local data mode)
#   dns       the built-in DNS server on TCP and UDP 53, only with a managed zone  profile "dns"
#             (for a zone connected later in the console, the runner starts the same server)
#
# The router (Traefik on 80 and 443, container nearzero-router) isn't defined here: the runner owns
# it, as on every other server (spec 25 D1, 23.2). The runner creates it, recreates it only when its
# settings change, and restarts it when it stops. The "router" profile in COMPOSE_PROFILES still
# makes the installer download the router's image.
#
# The project, container, network and volume names are 1.0's own and never 0.1.x's (spec 29.5 "No
# shared names with 0.1.x"): the project is nearzero1, the database and DNS containers are
# nearzero1-postgres and nearzero1-dns. The networks and volumes are created by the installer
# (external here), so no compose run ever adopts, recreates or deletes them.
#
# Every container carries dev.nearzero.managed=true and dev.nearzero.edition=1, the label naming
# 1.0, plus the move attempt while a move from 0.1.x runs: rollback and the uninstaller remove
# only what carries it (spec 03 3.3, 29.5).

name: nearzero1

x-managed: &managed
  dev.nearzero.managed: "true"
  dev.nearzero.edition: "1"
  dev.nearzero.migration-attempt: ${NEARZERO_MIGRATION_ATTEMPT:-}

x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

services:
  control:
    image: ${NEARZERO_IMAGE:?NEARZERO_IMAGE is missing from /opt/nearzero/.env; rerun the installer}
    container_name: nearzero-control
    restart: unless-stopped
    init: true
    stop_grace_period: 30s
    # Every setting in .env reaches the control plane, including optional ones like
    # NEARZERO_CONSOLE_URL, NEARZERO_TRUSTED_PROXIES and the instance email settings.
    env_file:
      - path: .env
    environment:
      NEARZERO_ENV: production
      # A one-time join token for the runner below is left here at every start.
      NEARZERO_RUNNER_HANDOFF_DIR: /var/lib/nearzero/handoff
      # The runner link's certificate, made at the first start and kept in its own volume, so
      # every server that pins its fingerprint keeps connecting after restarts, upgrades and
      # reruns (spec 31 "Remote runners are always encrypted").
      NEARZERO_RUNNER_TLS_DIR: /var/lib/nearzero/runner-link
      NEARZERO_RUNNER_LINK_LISTEN_PORT: "3443"
    volumes:
      - runner-handoff:/var/lib/nearzero/handoff
      - runner-link:/var/lib/nearzero/runner-link
    ports:
      - "${NEARZERO_MANAGEMENT_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_CONSOLE_PORT:-4321}:4321"
      - "${NEARZERO_MANAGEMENT_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_API_PORT:-3000}:3000"
      # Only runners connect here, over TLS with the certificate above, so it listens on every
      # address even when the console is kept on this server.
      - "${NEARZERO_RUNNER_LINK_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_RUNNER_LINK_PORT:-3443}:3443"
    depends_on:
      postgres:
        condition: service_healthy
        required: false
    networks:
      - internal
      - edge
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    logging: *logging
    labels:
      <<: *managed
      dev.nearzero.component: control

  postgres:
    image: ${NEARZERO_POSTGRES_IMAGE:-postgres:18.6-alpine}
    container_name: nearzero1-postgres
    profiles:
      - database
    restart: unless-stopped
    shm_size: 128m
    environment:
      POSTGRES_USER: nearzero
      POSTGRES_DB: nearzero
      POSTGRES_PASSWORD: ${NEARZERO_DATABASE_PASSWORD:-}
    volumes:
      - postgres-data:/var/lib/postgresql
    networks:
      - internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nearzero -d nearzero"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 30s
    logging: *logging
    labels:
      <<: *managed
      dev.nearzero.component: database

  # The Nearzero host's runner (spec 25 D1): the same runner every server runs. It enrolls itself
  # with the token the control plane leaves in the shared handoff folder, talks to Docker through
  # its socket (root-equivalent, as on every server), writes the router's files in ./router and
  # keeps the router container running. Every capability is dropped; it reads the handoff token
  # through the control plane's group.
  runner:
    image: ${NEARZERO_IMAGE:?NEARZERO_IMAGE is missing from /opt/nearzero/.env; rerun the installer}
    container_name: nearzero-runner
    restart: unless-stopped
    init: true
    stop_grace_period: 20s
    entrypoint: ["bun", "--no-install", "/app/runner/main.js"]
    command: ["run"]
    user: "0:0"
    group_add:
      - "10001"
    environment:
      NEARZERO_CONTROL_URL: http://nearzero-control:3000
      NEARZERO_RUNNER_CONTAINERIZED: "true"
      # The host's time zone name (the installer reads it from the host), so the runner reports a
      # zone that follows daylight saving rather than its container's fixed clock offset.
      TZ: ${NEARZERO_TIME_ZONE:-}
      NEARZERO_RUNNER_STATE_DIR: /var/lib/nearzero-runner
      NEARZERO_RUNNER_HANDOFF_DIR: /var/lib/nearzero/handoff
      NEARZERO_ROUTER_DIR: /etc/nearzero/router
      NEARZERO_ROUTER_IMAGE: ${NEARZERO_ROUTER_IMAGE:-traefik:v3.7.18}
      NEARZERO_ACME_EMAIL: ${NEARZERO_ACME_EMAIL:-}
      NEARZERO_HTTP_PORT: ${NEARZERO_HTTP_PORT:-80}
      NEARZERO_HTTPS_PORT: ${NEARZERO_HTTPS_PORT:-443}
      # The built-in DNS server's files: the runner publishes managed zones there and starts the
      # server when a zone is connected in the console (spec 10.8).
      NEARZERO_DNS_DIR: /etc/nearzero/dns
      NEARZERO_DNS_IMAGE: ${NEARZERO_DNS_IMAGE:-coredns/coredns:1.15.0}
      NEARZERO_DNS_BIND_ADDRESS: ${NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}
      NEARZERO_DNS_PORT: ${NEARZERO_DNS_PORT:-53}
      NEARZERO_DNS_NETWORK: nearzero-internal
      # While a move from 0.1.x runs, what the runner creates carries the attempt too.
      NEARZERO_MIGRATION_ATTEMPT: ${NEARZERO_MIGRATION_ATTEMPT:-}
      # Builder image overrides, each pinned by digest, and the metrics sample interval (spec 03
      # 3.5); empty means the release's own.
      NEARZERO_HEROKU_BUILDER_IMAGE: ${NEARZERO_HEROKU_BUILDER_IMAGE:-}
      NEARZERO_PAKETO_BUILDER_IMAGE: ${NEARZERO_PAKETO_BUILDER_IMAGE:-}
      NEARZERO_RAILPACK_FRONTEND_IMAGE: ${NEARZERO_RAILPACK_FRONTEND_IMAGE:-}
      NEARZERO_STATIC_NGINX_IMAGE: ${NEARZERO_STATIC_NGINX_IMAGE:-}
      NEARZERO_METRICS_REFRESH_SECONDS: ${NEARZERO_METRICS_REFRESH_SECONDS:-}
      # Storage usage is the host's root filesystem, not this container's (30c R3-34): the
      # runner measures the filesystem of the file mounted below.
      NEARZERO_HOST_ROOT_PATH: /run/nearzero-host-root
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./router:/etc/nearzero/router
      - ./dns:/etc/nearzero/dns
      - runner-state:/var/lib/nearzero-runner
      - runner-handoff:/var/lib/nearzero/handoff:ro
      # One file of the host's root filesystem (every Linux has /etc/passwd there, and it holds
      # nothing secret), read-only: the runner reads that filesystem's size and free space and
      # gains nothing it could write, and no folder of the host (30c R3-34).
      - /etc/passwd:/run/nearzero-host-root:ro
    networks:
      - internal
    cap_drop:
      - ALL
    # label=disable: under SELinux (Fedora's moby-engine runs dockerd with --selinux-enabled) a
    # confined container may neither use the Docker socket nor write ./router (C2-08). The runner
    # holds the socket, which is root on this server anyway, so SELinux confinement adds nothing;
    # the containers it starts (the router, the DNS server) stay confined, with their folders
    # relabelled. Where SELinux is off, the option does nothing.
    security_opt:
      - no-new-privileges:true
      - label=disable
    read_only: true
    tmpfs:
      - /tmp
    # The image's health check is the console's and the API's; the runner reports to the control
    # plane instead.
    healthcheck:
      disable: true
    logging: *logging
    labels:
      <<: *managed
      dev.nearzero.component: runner

  dns:
    image: ${NEARZERO_DNS_IMAGE:-coredns/coredns:1.15.0}
    container_name: nearzero1-dns
    profiles:
      - dns
    restart: unless-stopped
    command: ["-conf", "/etc/nearzero/dns/Corefile"]
    ports:
      - "${NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_DNS_PORT:-53}:1053/udp"
      - "${NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_DNS_PORT:-53}:1053/tcp"
    volumes:
      # z relabels the folder under SELinux so this confined server may read it (C2-08); without
      # SELinux it does nothing.
      - ./dns:/etc/nearzero/dns:ro,z
    networks:
      - internal
    # The CoreDNS binary carries the bind-service file capability and won't start without it;
    # every other capability is dropped.
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    read_only: true
    logging: *logging
    labels:
      <<: *managed
      dev.nearzero.component: dns

# Created by the installer with 1.0's labels before anything starts.
networks:
  # The control plane and its database. Apps never join it.
  internal:
    name: nearzero-internal
    external: true
  # The private network the router and what it serves share: the console and every app.
  edge:
    name: nearzero-edge
    external: true

volumes:
  postgres-data:
    name: nearzero-postgres-data
    external: true
  # The router's certificates live in nearzero-router-certificates, which the runner creates
  # beside the router (with 1.0's labels, so rollback and uninstall find it).
  runner-state:
    name: nearzero-runner-state
    external: true
  runner-handoff:
    name: nearzero-runner-handoff
    external: true
  runner-link:
    name: nearzero-runner-link
    external: true
NEARZERO_EMBEDDED_COMPOSE
}

nz_command_file_contents() {
  cat <<'NEARZERO_EMBEDDED_COMMAND'
#!/usr/bin/env bash
#
# The nearzero server command (spec 03 3.4), installed by the Nearzero installer at
# /usr/local/bin/nearzero. Run `sudo nearzero help` for the commands.
#
# None of the commands prints a password or a secret. Commands that read credentials take them
# from the terminal, or from standard input when there is no terminal (over SSH, in scripts).

set -o pipefail

NZC_DIR="${NEARZERO_INSTALL_DIR:-/opt/nearzero}"
NZC_ENV="$NZC_DIR/.env"
NZC_INSTALL_COMMAND="curl -fsSL https://cdn.nearzero.dev/install.sh | sudo bash"
NZC_SERVICES="control runner postgres router dns"
NZC_REQUIRED_KEYS="NEARZERO_IMAGE NEARZERO_AUTH_SECRET NEARZERO_DATA_MODE DATABASE_URL COMPOSE_PROFILES"

nzc_usage() {
  cat <<EOF
Usage: sudo nearzero [command]

Commands:
  status                 Show Nearzero's services and their state (the default)
  logs [service...] [--tail N] [--since TIME] [--timestamps]
                         Follow the logs of every service, or of the ones named: control, runner,
                         postgres, router, dns (0.1.x's platform and console mean control,
                         traefik router). Starts from the last 200 lines unless --tail says.
  audit [--since DATE] [--until DATE]
                         Print the audit record (sign-ins, member and policy changes, Agent
                         actions, deletes and more) as JSON lines, oldest first. Dates are
                         YYYY-MM-DD or ISO times; secret-looking fields are redacted.
  restart                Restart the console and API, and start anything that is stopped.
                         Apps and databases you deployed keep running.
  update                 Download the configured release again and restart. It never moves to a
                         newer version; to upgrade, run the install command again:
                           $NZC_INSTALL_COMMAND
  create-owner           Create the admin account when there is none yet. Asks for an email (the
                         settings' NEARZERO_ADMIN_EMAIL when Enter is pressed) and a password, or
                         reads them as two lines from standard input.
  reset-password [email] Set a new password for an account and sign out its other sessions. Without
                         an email it asks which account (Enter: the owner); without a terminal it
                         reads two lines, the email (empty: the owner) and the password.
  set-email <old> <new>  Change an account's email address. It counts as confirmed, and the
                         account's sessions are signed out. For servers that can't send email.
  reset-2fa [email]      Turn off two-factor sign-in for an account (the owner's by default) that
                         lost its authenticator and backup codes. Add --yes to skip the question.
  backup-db [file]       Save the bundled database to a file (default: $NZC_DIR/nearzero-db-<time>.sql)
  restore-db <file>      Replace the bundled database with a file made by backup-db. Asks first;
                         add --yes to skip the question.
  import [--dry-run] <file>
                         Import a 0.1.x export made on another server (moving to a new machine).
                         Asks for its passphrase, or reads NEARZERO_MIGRATION_PASSPHRASE.
  migrate status         Show how the move from 0.1.x stands, one line per service
  migrate retry          Try the services that failed to move again
  migrate rollback       Go back to 0.1.x, from its untouched data (until finalize). Asks first;
                         add --yes to skip the question.
  migrate finalize       Delete the 0.1.x data once everything works on 1.0. Asks you to type
                         "delete" first; add --yes to skip the question.
  runner-link status     Show the runner link certificate's fingerprint, the next one while it
                         is being replaced, and the servers that don't hold the next one yet
  runner-link rotate     Make a new runner link certificate. Within a minute every connected
                         server is given its fingerprint over its current link
  runner-link switch [--force]
                         Use the new certificate and restart Nearzero. Refuses while a server
                         doesn't hold its fingerprint yet, unless --force
  runner-link cancel     Drop the new certificate without using it
  help                   Show this help
EOF
}

nzc_err() {
  local line
  for line in "$@"; do printf '%s\n' "$line" >&2; done
}

nzc_die() {
  nzc_err "$@"
  exit 1
}

nzc_has() { command -v "$1" >/dev/null 2>&1; }

nzc_has_terminal() { [ -t 0 ] && (exec 4</dev/tty) 2>/dev/null; }

# --- Configuration -----------------------------------------------------------------------------

# Reads .env without evaluating it: KEY=value lines, comments and blank lines only. Values land in
# NZC_VALUE_<KEY>. A broken file stops every command before it runs (spec 03 3.4).
nzc_read_config() {
  if [ ! -f "$NZC_ENV" ]; then
    nzc_die "Nearzero isn't installed on this server ($NZC_ENV is missing)." \
      "Install it with: $NZC_INSTALL_COMMAND"
  fi
  local line key number=0 seen
  while IFS= read -r line || [ -n "$line" ]; do
    number=$((number + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if ! [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      nzc_die "line $number of $NZC_ENV isn't a KEY=value line; fix it, then rerun the installer: $NZC_INSTALL_COMMAND"
    fi
    key="${line%%=*}"
    seen="NZC_LINE_$key"
    if [ -n "${!seen}" ]; then
      nzc_die "duplicate $key in $NZC_ENV; rerun the installer: $NZC_INSTALL_COMMAND"
    fi
    printf -v "$seen" '%s' "$number"
    printf -v "NZC_VALUE_$key" '%s' "${line#*=}"
  done <"$NZC_ENV"
  local required="$NZC_REQUIRED_KEYS"
  [ "$(nzc_value NEARZERO_DATA_MODE)" = local ] && required="$required NEARZERO_DATABASE_PASSWORD"
  for key in $required; do
    if [ -z "$(nzc_value "$key")" ]; then
      nzc_die "missing $key in $NZC_ENV; rerun the installer: $NZC_INSTALL_COMMAND"
    fi
  done
}

nzc_value() {
  local name="NZC_VALUE_$1"
  printf '%s' "${!name}"
}

nzc_profile_on() {
  case ",$(nzc_value COMPOSE_PROFILES)," in *,"$1",*) return 0 ;; esac
  return 1
}

nzc_console_address() {
  local url host bind port ip
  url=$(nzc_value NEARZERO_CONSOLE_URL)
  if [ -n "$url" ]; then
    printf '%s' "${url%/}"
    return
  fi
  host=$(nzc_value NEARZERO_MANAGEMENT_HOSTNAME)
  bind=$(nzc_value NEARZERO_MANAGEMENT_BIND_ADDRESS)
  port=$(nzc_value NEARZERO_CONSOLE_PORT)
  ip=$(nzc_value NEARZERO_PUBLIC_IP)
  if [ -n "$host" ]; then
    printf 'https://%s' "$host"
  elif [ "$bind" = 127.0.0.1 ]; then
    printf 'http://localhost:%s' "${port:-4321}"
  elif [ -n "$bind" ] && [ "$bind" != 0.0.0.0 ]; then
    printf 'http://%s:%s' "$bind" "${port:-4321}"
  else
    printf 'http://%s:%s' "${ip:-<server address>}" "${port:-4321}"
  fi
}

# --- Docker ------------------------------------------------------------------------------------

nzc_compose() {
  docker compose --project-directory "$NZC_DIR" --file "$NZC_DIR/compose.yml" --env-file "$NZC_ENV" "$@"
}

nzc_require_docker() {
  nzc_has docker || nzc_die "Docker isn't installed on this server. Run the install command again: $NZC_INSTALL_COMMAND"
  docker info >/dev/null 2>&1 ||
    nzc_die "Docker isn't running on this server. Start it (for example: sudo systemctl start docker), then try again."
}

nzc_running() {
  [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = true ]
}

nzc_require_running() {
  if ! nzc_running nearzero-control; then
    nzc_die "Nearzero is not running. Start it with: sudo nearzero restart"
  fi
}

# Services that run with this configuration. The router isn't one: the runner keeps it running.
nzc_active_services() {
  local services="control runner"
  nzc_profile_on database && services="postgres $services"
  nzc_profile_on dns && services="$services dns"
  printf '%s' "$services"
}

# The router's line for status, in the same columns as the services above it.
nzc_router_status() {
  local state status
  state=$(docker inspect --format '{{.State.Status}}' nearzero-router 2>/dev/null) || state="missing"
  if [ "$state" = missing ]; then
    status="the runner starts it"
  else
    status=$(docker ps -a --filter name=^nearzero-router$ --format '{{.Status}}' 2>/dev/null)
  fi
  printf '%-10s %-10s %s (kept by the runner)\n' router "$state" "$status"
}

# Waits for the console and API to report healthy.
nzc_wait_healthy() {
  local timeout started health restarts
  timeout=$(nzc_value NEARZERO_STARTUP_TIMEOUT)
  timeout="${timeout:-300}"
  started=$(date +%s)
  while :; do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' nearzero-control 2>/dev/null)
    [ "$health" = healthy ] && return 0
    restarts=$(docker inspect --format '{{.RestartCount}}' nearzero-control 2>/dev/null)
    if [ "${restarts:-0}" -ge 5 ] || [ $(($(date +%s) - started)) -ge "$timeout" ]; then
      nzc_err "Nearzero did not start. Its last log lines:"
      nzc_compose logs --no-color --tail 60 control >&2
      nzc_err "" "Fix the problem above, then run: sudo nearzero restart"
      return 1
    fi
    sleep 2
  done
}

# --- Commands ----------------------------------------------------------------------------------

nzc_status() {
  printf 'Nearzero %s\n' "$(nzc_value NEARZERO_VERSION)"
  printf 'Console: %s\n\n' "$(nzc_console_address)"
  nzc_compose --profile '*' ps --all --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' ||
    nzc_die "Couldn't read the state of Nearzero's services."
  nzc_router_status
  nzc_dns_status
  if ! nzc_running nearzero-control; then
    printf '\nNearzero is not running. Start it with: sudo nearzero restart\n'
    return 1
  fi
}

# The DNS server when the runner started it for a zone connected in the console (C2-20): a
# container of the same name made outside compose, which compose's logs and ps don't see.
nzc_runner_dns() {
  local project
  project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' nearzero1-dns 2>/dev/null) || return 1
  [ -z "$project" ]
}

# The DNS server's line for status when the runner started it, as for the router.
nzc_dns_status() {
  nzc_runner_dns || return 0
  local state status
  state=$(docker inspect --format '{{.State.Status}}' nearzero1-dns 2>/dev/null)
  status=$(docker ps -a --filter name=^nearzero1-dns$ --format '{{.Status}}' 2>/dev/null)
  printf '%-10s %-10s %s (started by the runner for a zone)\n' dns "$state" "$status"
}

# Follows the logs of the services named (all when none): several at once, with Docker's own
# --tail, --since and --timestamps (G4-23), the router and a runner-made DNS server included.
nzc_logs() {
  local tail=200 since="" timestamps="" arg services=() name
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      --tail | -n)
        [ "$#" -gt 0 ] || nzc_die "--tail needs a number of lines (or all)."
        tail="$1"
        shift
        ;;
      --tail=*) tail="${arg#--tail=}" ;;
      --since)
        [ "$#" -gt 0 ] || nzc_die "--since needs a time, like 10m or 2026-11-28T09:00."
        since="$1"
        shift
        ;;
      --since=*) since="${arg#--since=}" ;;
      --timestamps | -t) timestamps=1 ;;
      --follow | -f) ;;
      -*) nzc_die "logs doesn't know $arg. Use: sudo nearzero logs [service...] [--tail N] [--since TIME] [--timestamps]" ;;
      *) services+=("$arg") ;;
    esac
  done
  case "$tail" in
    all) ;;
    '' | *[!0-9]*) nzc_die "--tail needs a number of lines, or all; it is \"$tail\"." ;;
  esac
  local options=(--follow --tail "$tail")
  [ -n "$since" ] && options+=(--since "$since")
  [ -n "$timestamps" ] && options+=(--timestamps)

  local compose_services=() others=() note=""
  for name in "${services[@]}"; do
    # 0.1.x's service names, which its docs and people's notes use (R4-10).
    case "$name" in
      platform | console | api) name=control ;;
      traefik) name=router ;;
      monitoring)
        note="${note}The runner collects metrics now; see them with: sudo nearzero logs runner"$'\n'
        continue
        ;;
      schedules)
        note="${note}The control plane runs schedules now; see them with: sudo nearzero logs control"$'\n'
        continue
        ;;
    esac
    case " $NZC_SERVICES " in
      *" $name "*) ;;
      *) nzc_die "There's no Nearzero service called $name. Services: ${NZC_SERVICES// /, }." ;;
    esac
    case " ${compose_services[*]} ${others[*]} " in *" $name "*) continue ;; esac
    if [ "$name" = router ] || { [ "$name" = dns ] && nzc_runner_dns; }; then
      others+=("$name")
    else
      compose_services+=("$name")
    fi
  done
  [ -n "$note" ] && printf '%s' "$note"
  if [ "${#services[@]}" -gt 0 ] && [ "${#compose_services[@]}" -eq 0 ] && [ "${#others[@]}" -eq 0 ]; then
    return 0
  fi
  if [ "${#services[@]}" -eq 0 ]; then
    # Everything: compose's services, the router, and the DNS server when the runner made it.
    others=(router)
    nzc_runner_dns && others+=(dns)
  fi
  if [ "${#others[@]}" -eq 0 ]; then
    exec docker compose --project-directory "$NZC_DIR" --file "$NZC_DIR/compose.yml" \
      --env-file "$NZC_ENV" --profile '*' logs "${options[@]}" "${compose_services[@]}"
  fi
  if [ "${#others[@]}" -eq 1 ] && [ "${#compose_services[@]}" -eq 0 ] && [ "${#services[@]}" -gt 0 ]; then
    exec docker logs "${options[@]}" "$(nzc_container_of "${others[0]}")"
  fi
  # Several sources at once: each in the background, its lines marked with its name like
  # compose's, until Ctrl-C (which stops them all).
  local pids=() container
  trap 'kill "${pids[@]}" 2>/dev/null; exit 0' INT TERM
  if [ "${#services[@]}" -eq 0 ] || [ "${#compose_services[@]}" -gt 0 ]; then
    docker compose --project-directory "$NZC_DIR" --file "$NZC_DIR/compose.yml" \
      --env-file "$NZC_ENV" --profile '*' logs "${options[@]}" "${compose_services[@]}" &
    pids+=($!)
  fi
  for name in "${others[@]}"; do
    container=$(nzc_container_of "$name")
    docker inspect "$container" >/dev/null 2>&1 || continue
    nzc_prefixed "$name" docker logs "${options[@]}" "$container" &
    pids+=($!)
  done
  wait
}

# Runs a command, each line of its output marked with a name as compose marks its services'.
nzc_prefixed() {
  local label line
  label=$(printf '%-9s|' "$1")
  shift
  "$@" 2>&1 | while IFS= read -r line; do printf '%s %s\n' "$label" "$line"; done
}

# The container a non-compose service runs as.
nzc_container_of() {
  case "$1" in
    router) printf 'nearzero-router' ;;
    dns) printf 'nearzero1-dns' ;;
    *) printf '%s' "$1" ;;
  esac
}

nzc_start_all() {
  # shellcheck disable=SC2046
  nzc_compose up -d --no-build $(nzc_active_services) || return 1
}

nzc_restart() {
  printf 'Restarting Nearzero...\n'
  if nzc_running nearzero-control; then
    nzc_compose restart control >/dev/null || nzc_die "Couldn't restart Nearzero."
  fi
  nzc_start_all >/dev/null || nzc_die "Couldn't start Nearzero's services. See: sudo nearzero status"
  nzc_wait_healthy || exit 1
  printf 'Nearzero is running at %s\n' "$(nzc_console_address)"
}

nzc_update() {
  printf 'Downloading Nearzero %s again...\n' "$(nzc_value NEARZERO_VERSION)"
  # shellcheck disable=SC2046
  nzc_compose pull --quiet $(nzc_active_services) ||
    nzc_die "Couldn't download the configured images. Check this server's connection to their registries."
  # The runner uses the router image already on the server rather than fetching it itself.
  if nzc_profile_on router && [ -n "$(nzc_value NEARZERO_ROUTER_IMAGE)" ]; then
    docker pull --quiet "$(nzc_value NEARZERO_ROUTER_IMAGE)" >/dev/null ||
      nzc_die "Couldn't download the router image. Check this server's connection to its registry."
  fi
  nzc_start_all >/dev/null || nzc_die "Couldn't start Nearzero's services. See: sudo nearzero status"
  nzc_wait_healthy || exit 1
  printf 'Nearzero %s is running at %s\n' "$(nzc_value NEARZERO_VERSION)" "$(nzc_console_address)"
  printf 'This keeps the installed version. To move to a newer one, run: %s\n' "$NZC_INSTALL_COMMAND"
}

# Runs one of the control plane's account commands inside its container; credentials travel on
# standard input only.
nzc_control() {
  nzc_compose exec -T control nearzero-control "$@"
}

# Replacing the runner link's certificate (C4-10): the control plane gives servers the next
# fingerprint over their current link, and the switch takes effect when it restarts.
nzc_runner_link() {
  local action="${1:-status}"
  case "$action" in
    status | rotate | switch | cancel) ;;
    *) nzc_die "Unknown runner-link command: $action. Use status, rotate, switch or cancel." ;;
  esac
  nzc_running nearzero-control || nzc_die "Nearzero isn't running. Start it with: sudo nearzero restart"
  nzc_control runner-link "$@" </dev/null || return 1
  if [ "$action" = switch ]; then
    nzc_restart
  fi
}

# Reads a password twice from the terminal into NZC_PASSWORD.
nzc_prompt_password() {
  local label="$1" first second saved
  while :; do
    saved=$(stty -g </dev/tty 2>/dev/null)
    # Echo off before the prompt shows, so nothing typed at once is echoed.
    stty -echo </dev/tty 2>/dev/null
    printf '%s' "$label" >/dev/tty
    IFS= read -r first </dev/tty || first=""
    printf '\nConfirm password: ' >/dev/tty
    IFS= read -r second </dev/tty || second=""
    stty "$saved" </dev/tty 2>/dev/null
    printf '\n' >/dev/tty
    if [ "${#first}" -lt 8 ] || [ "${#first}" -gt 128 ]; then
      printf 'Use 8 to 128 characters.\n' >/dev/tty
      continue
    fi
    if [ "$first" != "$second" ]; then
      printf "The passwords don't match. Try again.\n" >/dev/tty
      continue
    fi
    NZC_PASSWORD="$first"
    return 0
  done
}

nzc_create_owner() {
  nzc_require_running
  local status
  # owner-status --json answers {"owner":"exists",...} or {"owner":"missing"}; its sentence for
  # people goes to standard error.
  status=$(nzc_control owner-status --json </dev/null 2>/dev/null | grep '^{' | tail -n 1)
  case "$status" in
    *'"owner":"exists"'*)
      # create-owner says who the owner is and what to do, and exits 1.
      nzc_control create-owner </dev/null
      return 1
      ;;
  esac
  local email password suggested
  # The installer's admin email, offered as the default (31a G1-14).
  suggested=$(nzc_value NEARZERO_ADMIN_EMAIL)
  if nzc_has_terminal; then
    while :; do
      if [ -n "$suggested" ]; then
        printf 'Email [%s]: ' "$suggested" >/dev/tty
      else
        printf 'Email: ' >/dev/tty
      fi
      IFS= read -r email </dev/tty || nzc_die "No email was given, so no account was created."
      email=$(printf '%s' "$email" | tr -d '[:space:]')
      [ -z "$email" ] && email="$suggested"
      case "$email" in
        ?*@?*.?*) break ;;
      esac
      printf 'Enter a valid email address, like you@company.com.\n' >/dev/tty
    done
    nzc_prompt_password "Password (8+ characters): "
    password="$NZC_PASSWORD"
    NZC_PASSWORD=""
  else
    IFS= read -r email || true
    IFS= read -r password || true
    email="${email%$'\r'}"
    password="${password%$'\r'}"
    # An empty first line means the installer's admin email.
    [ -z "$(printf '%s' "$email" | tr -d '[:space:]')" ] && email="$suggested"
  fi
  printf '%s\n%s\n' "$email" "$password" | nzc_control create-owner
}

# reset-password [email] (31a G1-01, spec 03 3.4). Without an email the account comes first: on a
# terminal "Email [<owner>]:", where Enter keeps the owner; without one, the first of two lines
# (0.1.x's form), where an empty line means the owner. So
#   printf 'bob@example.com\nNewPass123\n' | sudo nearzero reset-password
# resets Bob's password, never the owner's.
nzc_reset_password() {
  nzc_require_running
  local email="$1" password owner status
  if [ -z "$email" ]; then
    if nzc_has_terminal; then
      status=$(nzc_control owner-status --json </dev/null 2>/dev/null | grep '^{' | tail -n 1)
      owner=$(printf '%s' "$status" | sed -n 's/.*"email":"\([^"]*\)".*/\1/p')
      printf 'Email [%s]: ' "${owner:-the owner}" >/dev/tty
      IFS= read -r email </dev/tty || nzc_die "No email was given, so no password was changed."
    else
      IFS= read -r email || [ -n "$email" ] || nzc_die "No email was given, so no password was changed."
    fi
    email=$(printf '%s' "${email%$'\r'}" | tr -d '[:space:]')
    [ -z "$email" ] && email="$owner"
  fi
  if nzc_has_terminal; then
    nzc_prompt_password "New password for ${email:-the owner} (8+ characters): "
    password="$NZC_PASSWORD"
    NZC_PASSWORD=""
  else
    IFS= read -r password || true
    password="${password%$'\r'}"
  fi
  if [ -n "$email" ]; then
    printf '%s\n' "$password" | nzc_control reset-password "$email"
  else
    # No email given and no owner found: the control plane's empty first line means the owner.
    printf '\n%s\n' "$password" | nzc_control reset-password
  fi
}

# set-email <old> <new> (31a G1-02): root vouches for the new address.
nzc_set_email() {
  [ "$#" -eq 2 ] || nzc_die "Usage: sudo nearzero set-email <current email> <new email>"
  nzc_require_running
  nzc_control set-email "$1" "$2" </dev/null
}

nzc_reset_2fa() {
  local email="" yes=0 argument
  for argument in "$@"; do
    case "$argument" in
      --yes | -y) yes=1 ;;
      *) email="$argument" ;;
    esac
  done
  nzc_require_running
  local who="${email:-the owner}"
  if [ "$yes" = 0 ]; then
    nzc_has_terminal || nzc_die "No terminal to confirm on, so nothing was changed. To go ahead from a script, run: sudo nearzero reset-2fa ${email:+$email }--yes"
    local answer
    printf 'Turn off two-factor sign-in for %s? They sign in with their password alone until they set it up again. [y/N] ' "$who" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    case "$answer" in
      y | Y | yes | YES | Yes) ;;
      *) printf 'Nothing was changed.\n'; return 1 ;;
    esac
  fi
  # Confirmed here, so the control plane's own question is answered with --yes.
  if [ -n "$email" ]; then
    nzc_control reset-2fa "$email" --yes </dev/null
  else
    nzc_control reset-2fa --yes </dev/null
  fi
}

nzc_require_bundled_database() {
  if [ "$(nzc_value NEARZERO_DATA_MODE)" != local ]; then
    nzc_die "This command works with the bundled database only, and this server uses an external one." \
      "Back it up and restore it with your database's own tools."
  fi
  nzc_running nearzero1-postgres ||
    nzc_die "The bundled database isn't running. Start Nearzero with: sudo nearzero restart"
}

nzc_backup_db() {
  local file="$1"
  nzc_require_bundled_database
  [ -n "$file" ] || file="$NZC_DIR/nearzero-db-$(date -u +%Y%m%d-%H%M%S).sql"
  local dir name
  dir=$(dirname -- "$file")
  name=$(basename -- "$file")
  [ -d "$dir" ] || nzc_die "backup destination directory does not exist: $dir"
  [ -w "$dir" ] || nzc_die "backup destination directory is not writable: $dir"
  [ -d "$file" ] && nzc_die "$file is a directory; give a file name, like $file/nearzero.sql"
  local partial="$dir/.$name.partial.$$" errors
  errors=$(
    umask 077
    nzc_compose exec -T postgres pg_dump --username nearzero --dbname nearzero --clean --if-exists \
      --no-owner --no-privileges 2>&1 >"$partial"
  )
  local status=$?
  if [ "$status" != 0 ] || [ ! -s "$partial" ]; then
    rm -f "$partial"
    nzc_die "The database dump failed, so nothing was written${errors:+: $errors}"
  fi
  chmod 0600 "$partial" && mv -f "$partial" "$file" || {
    rm -f "$partial"
    nzc_die "Couldn't save the dump as $file."
  }
  printf '%s\n' "$file"
}

nzc_restore_db() {
  local file="" yes=0 argument
  for argument in "$@"; do
    case "$argument" in
      --yes | -y) yes=1 ;;
      *) file="$argument" ;;
    esac
  done
  [ -n "$file" ] || nzc_die "Name the file to restore: sudo nearzero restore-db <file>"
  [ -f "$file" ] && [ -r "$file" ] || nzc_die "Can't read $file."
  head -n 20 "$file" | grep -q 'PostgreSQL database dump' ||
    nzc_die "$file isn't a database dump made by: sudo nearzero backup-db"
  nzc_require_bundled_database
  if [ "$yes" = 0 ]; then
    nzc_has_terminal || nzc_die "No terminal to confirm on, so nothing was restored. To restore from a script, run: sudo nearzero restore-db $file --yes"
    local answer
    printf 'This replaces all of Nearzero'"'"'s current data (accounts, workspaces, projects and settings)\n' >/dev/tty
    printf 'with the backup in %s. Apps and databases you deployed keep running.\n' "$file" >/dev/tty
    printf 'Type "replace" to continue: ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    [ "$answer" = replace ] || {
      printf 'Nothing was restored.\n'
      return 1
    }
  fi
  printf 'Stopping the console and API...\n'
  nzc_compose stop control >/dev/null 2>&1
  printf 'Restoring %s...\n' "$file"
  local errors
  # The dump drops only the objects it holds, so tables a later version added (and the rows
  # that refer to the dump's own) would stay, or stop the restore. The whole schema goes first,
  # in the same transaction, so the dump replaces the data exactly (spec 03 3.4, B2-09).
  if ! errors=$(
    {
      printf 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n'
      cat "$file"
    } | nzc_compose exec -T postgres psql --username nearzero --dbname nearzero \
      --quiet --single-transaction -v ON_ERROR_STOP=1 2>&1 >/dev/null
  ); then
    nzc_start_all >/dev/null 2>&1
    nzc_die "The restore failed and the current data was kept (it runs as one transaction): $(printf '%s' "$errors" | tail -n 3)"
  fi
  nzc_start_all >/dev/null || nzc_die "Restored, but Nearzero couldn't start. See: sudo nearzero status"
  nzc_wait_healthy || exit 1
  printf 'Restored the database from %s. Nearzero is running at %s\n' "$file" "$(nzc_console_address)"
}

# --- Moving from 0.1.x (spec 29) ----------------------------------------------------------------
#
# The installer moves a 0.1.x install in place and keeps its data under $NZC_MIGRATION/0.1 until
# `migrate finalize`. import reads an export made elsewhere (moving to a new machine). The
# control plane does the work; this command adds what only the host can: stopping and starting
# control planes, and deleting the old data after a typed confirmation.

NZC_MIGRATION="$NZC_DIR/migration"

# The export's passphrase into NZC_PASSPHRASE: from NEARZERO_MIGRATION_PASSPHRASE, or asked.
nzc_passphrase() {
  NZC_PASSPHRASE="${NEARZERO_MIGRATION_PASSPHRASE:-}"
  [ -n "$NZC_PASSPHRASE" ] && return 0
  nzc_has_terminal || nzc_die "Set NEARZERO_MIGRATION_PASSPHRASE to the export's passphrase, or run this on a terminal."
  local saved
  saved=$(stty -g </dev/tty 2>/dev/null)
  stty -echo </dev/tty 2>/dev/null
  printf 'Passphrase: ' >/dev/tty
  IFS= read -r NZC_PASSPHRASE </dev/tty || NZC_PASSPHRASE=""
  stty "$saved" </dev/tty 2>/dev/null
  printf '\n' >/dev/tty
  [ -n "$NZC_PASSPHRASE" ] || nzc_die "No passphrase was given, so nothing was imported."
}

nzc_import() {
  local file="" dry="" argument
  for argument in "$@"; do
    case "$argument" in
      --dry-run) dry="--dry-run" ;;
      -*) nzc_die "Unknown option: $argument. Run: sudo nearzero import [--dry-run] <file>" ;;
      *) file="$argument" ;;
    esac
  done
  [ -n "$file" ] || nzc_die "Name the export file: sudo nearzero import [--dry-run] <file>"
  [ -f "$file" ] && [ -r "$file" ] || nzc_die "Can't read $file."
  nzc_require_running
  nzc_passphrase
  # The export goes in on standard input and the passphrase through the environment, so neither
  # is ever an argument.
  if [ -n "$dry" ]; then
    NEARZERO_MIGRATION_PASSPHRASE="$NZC_PASSPHRASE" docker exec -i -e NEARZERO_MIGRATION_PASSPHRASE \
      nearzero-control nearzero-control import --dry-run - <"$file"
  else
    NEARZERO_MIGRATION_PASSPHRASE="$NZC_PASSPHRASE" docker exec -i -e NEARZERO_MIGRATION_PASSPHRASE \
      nearzero-control nearzero-control import --wait - <"$file"
  fi
}

nzc_migration_state() {
  cut -d' ' -f1 "$NZC_MIGRATION/state" 2>/dev/null
}

# Applies one action to a 0.1.x workload (the installer's nz_legacy_workload, same rules).
# The lines of control-plane.txt that name a workload ("volume", "project", "folder" and "port"
# lines are read on their own).
nzc_is_workload_kind() {
  case "$1" in container | swarm-service | swarm-stack | compose-project) return 0 ;; esac
  return 1
}

# Starts a Swarm service the move stopped (spec 29.5): its replica count and the published ports
# it let go of ("published:target:protocol:mode" words in dev.nearzero.migration.ports, which the
# runner and the installer write), as they were.
nzc_swarm_start() {
  local name="$1" mode="$2" wanted kept word pub tgt proto pm args=()
  wanted=$(docker service inspect --format '{{index .Spec.Labels "dev.nearzero.migration.replicas"}}' "$name")
  case "$wanted" in '' | *[!0-9]*) wanted="" ;; esac
  kept=$(docker service inspect --format '{{index .Spec.Labels "dev.nearzero.migration.ports"}}' "$name")
  if [ -n "$wanted" ]; then
    args+=(--label-rm dev.nearzero.migration.replicas --replicas "$wanted")
  elif [ "$mode" = 0 ]; then
    args+=(--replicas 1)
  fi
  if [ -n "$kept" ]; then
    args+=(--label-rm dev.nearzero.migration.ports)
    for word in $kept; do
      case "$word" in *[!0-9a-z:]* | *:*:*:*:*) continue ;; esac
      IFS=: read -r pub tgt proto pm <<<"$word"
      args+=(--publish-add "published=$pub,target=$tgt,protocol=$proto,mode=$pm")
    done
  fi
  [ "${#args[@]}" -gt 0 ] || return 0
  docker service update --detach "${args[@]}" "$name" >/dev/null
}

# True when a container, Swarm service, network or volume carries 1.0's label: nothing done to
# 0.1.x's workloads ever touches it (spec 29.5 "Finalize").
nzc_is_ours() {
  local kind="$1" name="$2" field=.Labels
  case "$kind" in container) field=.Config.Labels ;; service) field=.Spec.Labels ;; esac
  [ "$(docker "$kind" inspect --format "{{index $field \"dev.nearzero.edition\"}}" "$name" 2>/dev/null)" = 1 ]
}

# A Compose project's containers that aren't 1.0's: a moved stack keeps its project name, so its
# 1.0 containers share the project label with 0.1.x's.
nzc_project_containers() {
  local id
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$1" 2>/dev/null); do
    nzc_is_ours container "$id" || printf '%s\n' "$id"
  done
}

nzc_legacy_workload() {
  local action="$1" kind="$2" name="$3" mode ids
  case "$name" in *[!A-Za-z0-9_.-]* | "") return 1 ;; esac
  case "$kind" in
    swarm-stack)
      for ids in $(docker service ls -q --filter "label=com.docker.stack.namespace=$name" 2>/dev/null); do
        nzc_legacy_workload "$action" swarm-service "$ids" || return 1
      done
      ;;
    swarm-service)
      docker service inspect "$name" >/dev/null 2>&1 || return 0
      nzc_is_ours service "$name" && return 0
      mode=$(docker service inspect --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}global{{end}}' "$name")
      case "$action" in
        start) nzc_swarm_start "$name" "$mode" ;;
        remove) docker service rm "$name" >/dev/null ;;
      esac
      ;;
    container)
      docker inspect "$name" >/dev/null 2>&1 || return 0
      nzc_is_ours container "$name" && return 0
      case "$action" in
        start) docker start "$name" >/dev/null ;;
        # Its anonymous volumes go with it; named ones never do.
        remove) docker rm -fv "$name" >/dev/null ;;
      esac
      ;;
    compose-project)
      # Only the project's own 0.1.x containers, one by one, never the project as a whole.
      ids=$(nzc_project_containers "$name")
      [ -n "$ids" ] || return 0
      # shellcheck disable=SC2086
      case "$action" in
        start) docker start $ids >/dev/null ;;
        remove) docker rm -fv $ids >/dev/null ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

# The networks a 0.1.x workload's containers or Swarm services use, one name per line.
nzc_workload_networks() {
  local kind="$1" name="$2" id target
  case "$kind" in
    container)
      nzc_is_ours container "$name" ||
        docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$name" 2>/dev/null | tr ' ' '\n'
      ;;
    compose-project)
      for id in $(nzc_project_containers "$name"); do
        docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id" 2>/dev/null | tr ' ' '\n'
      done
      ;;
    swarm-service)
      nzc_is_ours service "$name" && return 0
      for target in $(docker service inspect --format '{{range .Spec.TaskTemplate.Networks}}{{.Target}} {{end}}' "$name" 2>/dev/null); do
        docker network inspect --format '{{.Name}}' "$target" 2>/dev/null
      done
      ;;
    swarm-stack)
      for id in $(docker service ls -q --filter "label=com.docker.stack.namespace=$name" 2>/dev/null); do
        nzc_workload_networks swarm-service "$id"
      done
      ;;
  esac
}

# Removes each of these networks once no container is attached and it carries no 1.0 label;
# Docker's own networks stay.
nzc_remove_unused_networks() {
  local network
  for network in $(printf '%s\n' "$@" | sed '/^$/d' | sort -u); do
    case "$network" in bridge | host | none | ingress | docker_gwbridge) continue ;; esac
    docker network inspect "$network" >/dev/null 2>&1 || continue
    nzc_is_ours network "$network" && continue
    [ "$(docker network inspect --format '{{len .Containers}}' "$network" 2>/dev/null)" = 0 ] || continue
    docker network rm "$network" >/dev/null 2>&1
  done
}

nzc_rollback() {
  local yes=0 argument
  for argument in "$@"; do
    case "$argument" in
      --yes | -y) yes=1 ;;
      *) nzc_die "Unknown option: $argument" ;;
    esac
  done
  [ "$(nzc_migration_state)" = finalized ] &&
    nzc_die "The move is finalized: the 0.1.x data is deleted, so it can't be rolled back."
  [ -f "$NZC_MIGRATION/0.1/env" ] || nzc_die "This server has no 0.1.x install to go back to."
  local version
  version=$(cat "$NZC_MIGRATION/0.1/version" 2>/dev/null)
  version="${version:-0.1.x}"
  if [ "$yes" = 0 ]; then
    nzc_has_terminal || nzc_die "No terminal to confirm on, so nothing was changed. To go back from a script, run: sudo nearzero migrate rollback --yes"
    local answer
    printf 'Go back to Nearzero %s? Nearzero 1.0 stops, and what was changed in 1.0 since the move is lost. Your apps restart once more. [y/N] ' "$version" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    case "$answer" in
      y | Y | yes | YES | Yes) ;;
      *) printf 'Nothing was changed.\n'; return 1 ;;
    esac
  fi
  local plan="" kind name status
  if nzc_running nearzero-control; then
    plan=$(nzc_control migrate rollback-plan </dev/null)
    status=$?
    [ "$status" = 4 ] && nzc_die "The move is finalized: the 0.1.x data is deleted, so it can't be rolled back."
    # Remote servers go back first, while 1.0 can still sign in to them.
    nzc_control migrate rollback-servers </dev/null
  fi
  local plane="$NZC_MIGRATION/control-plane.txt" attempt
  attempt=$(cat "$NZC_MIGRATION/attempt" 2>/dev/null)

  # 1. Only what carries 1.0's label goes (spec 29.5 "Rollback"): its control plane, router,
  # runner and the moved services' containers, then the volumes and networks this attempt made.
  # A volume the bundle names (keep lines) or without 1.0's label is never removed.
  printf 'Stopping Nearzero 1.0...\n'
  local ids volume network
  # Its anonymous volumes go with each container; named ones never do.
  ids=$(docker ps -aq --filter label=dev.nearzero.edition=1)
  # shellcheck disable=SC2086
  [ -n "$ids" ] && docker rm -fv $ids >/dev/null
  [ -f "$NZC_ENV" ] && [ -f "$NZC_DIR/compose.yml" ] && nzc_compose --profile '*' down --timeout 30 >/dev/null 2>&1
  for volume in $(nzc_attempt_objects volume "$attempt"); do
    grep -Fqx "keep $volume" "$plane" 2>/dev/null && continue
    grep -Fqx "volume $volume" "$plane" 2>/dev/null && continue
    docker volume rm "$volume" >/dev/null 2>&1
  done
  for network in $(nzc_attempt_objects network "$attempt"); do
    docker network rm "$network" >/dev/null 2>&1
  done
  local aside path
  aside="$NZC_MIGRATION/1.0-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$aside" && chmod 0700 "$aside"
  for path in .env compose.yml router dns; do
    [ -e "$NZC_DIR/$path" ] && mv -f "$NZC_DIR/$path" "$aside/"
  done
  mv -f "$NZC_MIGRATION/0.1/env" "$NZC_ENV" || nzc_die "Couldn't put the 0.1.x settings back in $NZC_ENV."
  for path in "$NZC_MIGRATION/0.1/files/"* "$NZC_MIGRATION/0.1/files/".[!.]*; do
    [ -e "$path" ] && mv -f "$path" "$NZC_DIR/"
  done

  # 2. The 0.1.x control plane: its Compose project from its folder, created and started whether
  # or not any of its containers are left, then every workload the move stopped.
  printf 'Starting Nearzero %s...\n' "$version"
  local failed="" project folder
  project=$(sed -n 's/^project //p' "$plane" 2>/dev/null | head -n 1)
  folder=$(sed -n 's/^folder //p' "$plane" 2>/dev/null | head -n 1)
  case "$project$folder" in *[!A-Za-z0-9_./-]*) project="" ;; esac
  # Where an env file kept outside a project's folder may be (29a.9): the 0.1.x install's data
  # folders, which are its install folder, its control plane's folder and its data volumes'.
  NZC_DATA_ROOTS=$(nzc_data_roots "$plane" "$folder")
  if [ -n "$project" ] && [ -d "$folder" ]; then
    nzc_legacy_compose_up "$plane" "$project" "$folder" || failed="$failed $project"
  fi
  while read -r kind name; do
    nzc_is_workload_kind "$kind" && [ -n "$name" ] || continue
    nzc_legacy_workload start "$kind" "$name" || failed="$failed $name"
  done <"$plane"
  # 3. Each moved service's 0.1.x workload, as it was before the move. A stack whose files the
  # bundle names comes back from them: its stopped containers may have been replaced by 1.0's
  # deploy of the same project (spec 29.5).
  while read -r kind name; do
    nzc_is_workload_kind "$kind" && [ -n "$name" ] || continue
    if [ "$kind" = compose-project ] && nzc_stack_from_plan "$plan" "$name"; then
      continue
    fi
    nzc_legacy_workload start "$kind" "$name" || failed="$failed $name"
  done <<<"$plan"
  if [ -f "$NZC_MIGRATION/0.1/nearzero" ]; then
    # Renamed into place: this script keeps running from the file it was started from.
    cp -p "$NZC_MIGRATION/0.1/nearzero" "/usr/local/bin/nearzero.rollback" &&
      mv -f /usr/local/bin/nearzero.rollback /usr/local/bin/nearzero
  fi
  rm -rf "$NZC_MIGRATION/0.1"
  rm -f "$NZC_MIGRATION/attempt"
  printf 'rolled-back\n' >"$NZC_MIGRATION/state"

  # 4. Back when its console answers its sign-in page and its database takes connections.
  local missing
  missing=$(nzc_wait_legacy_back "$plane" "$project" "${NZC_ROLLBACK_WAIT_SECONDS:-300}")
  [ -n "$failed" ] && missing="$missing$failed"
  if [ -n "$missing" ]; then
    nzc_err "Nearzero $version didn't come back within 5 minutes. Not back:$missing." \
      "Check them with: docker ps -a; docker service ls. Nearzero 1.0's settings are in $aside."
    exit 1
  fi
  printf 'Nearzero %s is back. The move to 1.0 was undone.\n' "$version"
  printf "Nearzero 1.0 is stopped; its settings are in %s.\n" "$aside"
  printf 'To move again later, run the 1.0 install command: %s\n' "$NZC_INSTALL_COMMAND"
}

# Creates and starts 0.1.x's Compose project from its folder with its own Compose files, in
# order, and its env file (29a.9 controlPlaneDetails); without them, Compose's own file lookup.
nzc_legacy_compose_up() {
  local plane="$1" project="$2" folder="$3" env file files=()
  while IFS= read -r file; do files+=("$file"); done < <(sed -n 's/^composefile //p' "$plane" 2>/dev/null)
  env=$(sed -n 's/^envfile //p' "$plane" 2>/dev/null | head -n 1)
  nzc_compose_files_up "$project" "$folder" "$env" "${files[@]}"
}

# Runs a Compose project from its own files in its folder (used exactly as the bundle gives it),
# in order, with its env file; without named files, Compose's own lookup in the folder.
nzc_compose_files_up() {
  local project="$1" folder="$2" env="$3" file args=()
  shift 3
  for file in "$@"; do
    case "$file" in "" | *..* | /*) continue ;; esac
    args+=(-f "$folder/$file")
  done
  case "$env" in
    *..*) env="" ;;
    /*)
      # Kept outside the folder: only a regular file under the install's data folders, never
      # written to. Otherwise the project isn't started without its variables.
      if ! nzc_env_allowed "$env"; then
        nzc_err "The env file $env isn't a regular file under the 0.1.x install's data folders, so $project wasn't started."
        return 1
      fi
      args+=(--env-file "$env")
      env=""
      ;;
  esac
  [ -n "$env" ] && args+=(--env-file "$folder/$env")
  if [ "${#args[@]}" -gt 0 ]; then
    (cd "$folder" && docker compose --project-directory "$folder" -p "$project" "${args[@]}" up -d >/dev/null 2>&1)
  else
    (cd "$folder" && docker compose -p "$project" up -d >/dev/null 2>&1)
  fi
}

# The 0.1.x install's data folders, resolved: its install folder, its control plane's folder and
# the folders of its data volumes (the plane's volume lines).
nzc_data_roots() {
  local plane="$1" folder="$2" kind name root
  # On every server 0.1.x keeps data in /opt/nearzero and /etc/nearzero (29a.9).
  for root in "$NZC_DIR" /opt/nearzero /etc/nearzero "$folder"; do
    [ -n "$root" ] && readlink -f "$root" 2>/dev/null
  done
  while read -r kind name; do
    [ "$kind" = volume ] && [ -n "$name" ] || continue
    root=$(docker volume inspect --format '{{.Mountpoint}}' "$name" 2>/dev/null)
    [ -n "$root" ] && readlink -f "$root" 2>/dev/null
  done <"$plane"
}

# True for a regular file, reached by no link, under one of NZC_DATA_ROOTS.
nzc_env_allowed() {
  local file="$1" root
  case "$file" in /* ) ;; *) return 1 ;; esac
  case "$file" in *..* | *[!A-Za-z0-9_./-]*) return 1 ;; esac
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(readlink -f "$file" 2>/dev/null)" = "$file" ] || return 1
  for root in $NZC_DATA_ROOTS; do
    root="${root%/}"
    [ -n "$root" ] || continue
    case "$file" in "$root"/*) return 0 ;; esac
  done
  return 1
}

# A moved stack's 0.1.x copy from its own files, when the rollback plan names its folder: 1.0's
# labelled containers in the project go first, with their anonymous volumes. False when the plan
# names no folder (it is then started as before, from its stopped containers).
nzc_stack_from_plan() {
  local plan="$1" name="$2" folder env ids file files=()
  folder=$(printf '%s\n' "$plan" | awk -v n="$name" '$1 == "stackfolder" && $2 == n { print $3; exit }')
  case "$folder" in /*) ;; *) return 1 ;; esac
  case "$folder" in *[!A-Za-z0-9_./-]* | *..*) return 1 ;; esac
  while IFS= read -r file; do
    [ -n "$file" ] && files+=("$file")
  done < <(printf '%s\n' "$plan" | awk -v n="$name" '$1 == "stackfile" && $2 == n { print $3 }')
  env=$(printf '%s\n' "$plan" | awk -v n="$name" '$1 == "stackenv" && $2 == n { print $3; exit }')
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$name" --filter label=dev.nearzero.edition=1 2>/dev/null)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker rm -fv $ids >/dev/null
  nzc_compose_files_up "$name" "$folder" "$env" "${files[@]}" || failed="$failed $name"
  return 0
}

# The volumes or networks of one move attempt that carry 1.0's label. Without a known attempt,
# only 1.0's own database volume (a fresh one, made for the move) counts.
nzc_attempt_objects() {
  local kind="$1" attempt="$2"
  if [ -n "$attempt" ]; then
    docker "$kind" ls -q --filter label=dev.nearzero.edition=1 \
      --filter "label=dev.nearzero.migration-attempt=$attempt" 2>/dev/null
  elif [ "$kind" = volume ]; then
    case " $(docker volume inspect --format '{{range $k, $v := .Labels}}{{$k}}={{$v}} {{end}}' nearzero-postgres-data 2>/dev/null) " in
      *" dev.nearzero.edition=1 "*) printf 'nearzero-postgres-data\n' ;;
    esac
  fi
}

# Waits until the 0.1.x console answers (its sign-in page, or the page it sends there) on one of
# its ports and every PostgreSQL of its control plane takes connections. Prints what isn't back.
nzc_wait_legacy_back() {
  local plane="$1" project="$2" seconds="$3" until ports port path code console db ids id image missing
  ports=$(sed -n 's/^port //p' "$plane" 2>/dev/null | tr '\n' ' ')
  [ -n "${ports// /}" ] || ports="4321 3000"
  until=$(($(date +%s) + seconds))
  while :; do
    console=0
    for port in $ports; do
      for path in /login /sign-in /signin /; do
        code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port$path" 2>/dev/null)
        case "$code" in 2?? | 3??) console=1; break 2 ;; esac
      done
    done
    db=1
    ids=""
    [ -n "$project" ] && ids=$(docker ps -q --filter "label=com.docker.compose.project=$project" 2>/dev/null)
    while read -r kind name; do
      case "$kind" in
        container) nzc_running "$name" && ids="$ids $(docker inspect --format '{{.Id}}' "$name" 2>/dev/null)" ;;
        swarm-service) ids="$ids $(docker ps -q --filter "label=com.docker.swarm.service.name=$name" 2>/dev/null)" ;;
      esac
    done < <(grep -E '^(container|swarm-service) ' "$plane" 2>/dev/null)
    for id in $ids; do
      image=$(docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null)
      case "$image" in *postgres*) docker exec "$id" pg_isready -q >/dev/null 2>&1 || db=0 ;; esac
    done
    [ "$console" = 1 ] && [ "$db" = 1 ] && return 0
    if [ "$(date +%s)" -ge "$until" ]; then
      missing=""
      [ "$console" = 1 ] || missing="$missing its console (ports $ports)"
      [ "$db" = 1 ] || missing="$missing its database"
      printf '%s' "$missing"
      return 0
    fi
    sleep 3
  done
}

nzc_finalize() {
  local yes=0 argument
  for argument in "$@"; do
    case "$argument" in
      --yes | -y) yes=1 ;;
      *) nzc_die "Unknown option: $argument" ;;
    esac
  done
  [ "$(nzc_migration_state)" = finalized ] && { printf 'The move is already finalized.\n'; return 0; }
  [ -d "$NZC_MIGRATION/0.1" ] || nzc_die "There is no 0.1.x data on this server to delete."
  nzc_require_running
  if [ "$yes" = 0 ]; then
    nzc_has_terminal || nzc_die "No terminal to confirm on, so nothing was deleted. To finalize from a script, run: sudo nearzero migrate finalize --yes"
    local answer
    printf 'This deletes the 0.1.x data on this server: its control plane, its database and its settings.\n' >/dev/tty
    printf 'Services that failed to move stop too. After this, sudo nearzero migrate rollback is no longer possible.\n' >/dev/tty
    printf 'Type "delete" to continue: ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    [ "$answer" = delete ] || { printf 'Nothing was deleted.\n'; return 1; }
  fi
  # The host's stopped 0.1.x workloads, asked before the move is marked final.
  local plan
  plan=$(nzc_control migrate rollback-plan </dev/null)
  nzc_control migrate finalize --yes </dev/null || exit 1
  local kind name failed="" workloads="" networks=""
  # The networks they use, read before anything goes (removed at the end once unused).
  while read -r kind name; do
    nzc_is_workload_kind "$kind" && [ -n "$name" ] || continue
    networks="$networks $(nzc_workload_networks "$kind" "$name" | tr '\n' ' ')"
  done < <(cat "$NZC_MIGRATION/control-plane.txt" 2>/dev/null; printf '%s\n' "$plan")
  while read -r kind name; do
    [ -n "$name" ] || continue
    if [ "$kind" = volume ]; then
      docker volume rm "$name" >/dev/null 2>&1 || failed="$failed $name"
    elif nzc_is_workload_kind "$kind"; then
      nzc_legacy_workload remove "$kind" "$name" || failed="$failed $name"
      workloads="$workloads $kind:$name"
    fi
  done <"$NZC_MIGRATION/control-plane.txt"
  # The moved services' 0.1.x workloads on this server go now too (the control plane removes the
  # ones on other servers through their runners).
  while read -r kind name; do
    nzc_is_workload_kind "$kind" && [ -n "$name" ] || continue
    nzc_legacy_workload remove "$kind" "$name" >/dev/null 2>&1
    workloads="$workloads $kind:$name"
  done <<<"$plan"
  rm -rf "$NZC_MIGRATION/0.1"
  printf 'finalized\n' >"$NZC_MIGRATION/state"
  [ -n "$failed" ] && nzc_err "These couldn't be removed:$failed. Remove them by hand."
  # Up to 2 minutes for them to be gone (spec 29.5 "Finalize").
  local left until
  until=$(($(date +%s) + ${NZC_FINALIZE_WAIT_SECONDS:-120}))
  while :; do
    left=$(nzc_still_there "$workloads")
    [ -z "$left" ] && break
    [ "$(date +%s)" -ge "$until" ] && break
    sleep 3
  done
  # Then 0.1.x's networks: its shared and router networks, its Compose default network and each
  # moved stack's old default network, once nothing uses them and they aren't 1.0's.
  # shellcheck disable=SC2086
  nzc_remove_unused_networks $networks
  if [ -n "$left" ]; then
    printf 'Finalized: the 0.1.x data is deleted and Nearzero 1.0 keeps running. Still being removed:%s.\n' "$left"
    printf 'Check them with: docker service ls; docker ps -a\n'
    return 0
  fi
  printf 'Finalized: the 0.1.x data is deleted. Nearzero 1.0 keeps running.\n'
}

# Which of these kind:name workloads still exist.
nzc_still_there() {
  local item kind name left=""
  for item in $1; do
    kind="${item%%:*}" name="${item#*:}"
    case "$kind" in
      swarm-service) docker service inspect "$name" >/dev/null 2>&1 && left="$left $name" ;;
      swarm-stack) [ -n "$(docker service ls -q --filter "label=com.docker.stack.namespace=$name" 2>/dev/null)" ] && left="$left $name" ;;
      container) docker inspect "$name" >/dev/null 2>&1 && left="$left $name" ;;
      compose-project) [ -n "$(nzc_project_containers "$name")" ] && left="$left $name" ;;
    esac
  done
  printf '%s' "$left"
}

nzc_migrate() {
  local sub="${1:-status}"
  [ "$#" -gt 0 ] && shift
  case "$sub" in
    status | retry)
      nzc_require_running
      nzc_control migrate "$sub" "$@" </dev/null
      ;;
    rollback) nzc_rollback "$@" ;;
    finalize) nzc_finalize "$@" ;;
    *)
      nzc_err "Unknown migrate command: $sub" "Use: sudo nearzero migrate status | retry | rollback | finalize"
      return 1
      ;;
  esac
}


# --- Main --------------------------------------------------------------------------------------

nzc_main() {
  local command="${1:-status}"
  [ "$#" -gt 0 ] && shift
  case "$command" in
    help | -h | --help)
      nzc_usage
      return 0
      ;;
    export)
      nzc_die "This server runs Nearzero 1.0, so there is nothing to export. To move a 0.1.x server here," \
        "run sudo nearzero export on it, copy the file here, then run: sudo nearzero import <file>"
      ;;
    status | logs | audit | restart | update | create-owner | reset-password | set-email | reset-2fa | backup-db | restore-db | import | migrate | runner-link) ;;
    *)
      nzc_err "Unknown command: $command" ""
      nzc_usage >&2
      return 1
      ;;
  esac
  if [ "$(id -u)" != 0 ]; then
    nzc_die "This command needs root. Run: sudo nearzero $command"
  fi
  # Going back to 0.1.x works even when 1.0's settings are half written.
  if [ "$command" = migrate ] && [ "${1:-}" = rollback ]; then
    nzc_require_docker
    [ -f "$NZC_ENV" ] && (nzc_read_config) >/dev/null 2>&1 && nzc_read_config
    shift
    nzc_rollback "$@"
    return $?
  fi
  nzc_read_config
  nzc_require_docker
  case "$command" in
    status) nzc_status ;;
    logs) nzc_logs "$@" ;;
    # The audit record, from the control plane's database (spec 22.4 rule 8).
    audit) nzc_control audit "$@" ;;
    restart) nzc_restart ;;
    update) nzc_update ;;
    create-owner) nzc_create_owner ;;
    reset-password) nzc_reset_password "$1" ;;
    set-email) nzc_set_email "$@" ;;
    reset-2fa) nzc_reset_2fa "$@" ;;
    backup-db) nzc_backup_db "$1" ;;
    restore-db) nzc_restore_db "$@" ;;
    import) nzc_import "$@" ;;
    migrate) nzc_migrate "$@" ;;
    runner-link) nzc_runner_link "$@" ;;
  esac
}

nzc_main "$@"
NEARZERO_EMBEDDED_COMMAND
}

main "$@"
