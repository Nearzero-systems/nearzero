import { AccessFailure, loadServerAccess, signIn } from "../server-setup/connection.ts";
import { remoteCommand } from "../server-setup/scripts.ts";
import { shellQuote } from "../server-setup/ssh.ts";
import type { ControlServices } from "../services.ts";
import { stackFiles } from "./legacy-fields.ts";
import type { LegacyWorkload, StepResult } from "./moves.ts";

/**
 * 0.1.x workloads on servers the runner doesn't reach yet (before a server is set up again) or
 * any more (rollback): the same stop, start and remove as the runner's `legacy.workload`, done
 * with the Docker CLI over SSH with the server's saved key. A stopped Swarm service keeps its
 * earlier replica count in a label, so starting it again restores exactly that.
 *
 * installer/nearzero carries the same steps for the Nearzero host (`migrate rollback`).
 */

const REPLICAS_LABEL = "dev.nearzero.migration.replicas";
/** Published ports a stopped Swarm service let go of, as the runner and installer keep them. */
const PORTS_LABEL = "dev.nearzero.migration.ports";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

const FUNCTIONS = `
nz_swarm() {
  action=$1; name=$2
  docker service inspect "$name" >/dev/null 2>&1 || return 0
  mode=$(docker service inspect --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}global{{end}}' "$name")
  case "$action" in
    stop)
      [ "$mode" = global ] && { echo "$name runs on every node and can't be scaled down" >&2; return 1; }
      # Swarm holds published ports even at zero replicas: they go too, kept in a label.
      ports=$(docker service inspect --format '{{range .Spec.EndpointSpec.Ports}}{{.PublishedPort}}:{{.TargetPort}}:{{.Protocol}}:{{.PublishMode}} {{end}}' "$name")
      ports=\${ports% }
      [ "$mode" = 0 ] && [ -z "$ports" ] && return 0
      args=""
      [ "$mode" != 0 ] && args="--label-add ${REPLICAS_LABEL}=$mode"
      if [ -n "$ports" ]; then
        for word in $ports; do
          rest=\${word#*:}
          args="$args --publish-rm \${rest%%:*}/$(printf '%s' "$rest" | cut -d: -f2)"
        done
        # shellcheck disable=SC2086
        docker service update --detach $args --label-add "${PORTS_LABEL}=$ports" --replicas 0 "$name" >/dev/null
      else
        # shellcheck disable=SC2086
        docker service update --detach $args --replicas 0 "$name" >/dev/null
      fi ;;
    start)
      wanted=$(docker service inspect --format '{{index .Spec.Labels "${REPLICAS_LABEL}"}}' "$name")
      case "$wanted" in ''|*[!0-9]*) wanted="" ;; esac
      kept=$(docker service inspect --format '{{index .Spec.Labels "${PORTS_LABEL}"}}' "$name")
      args=""
      if [ -n "$wanted" ]; then
        args="--label-rm ${REPLICAS_LABEL} --replicas $wanted"
      elif [ "$mode" = 0 ]; then
        args="--replicas 1"
      fi
      if [ -n "$kept" ]; then
        args="$args --label-rm ${PORTS_LABEL}"
        for word in $kept; do
          case "$word" in *[!0-9a-z:]*|*:*:*:*:*) continue ;; esac
          pub=\${word%%:*}; rest=\${word#*:}; tgt=\${rest%%:*}; rest=\${rest#*:}; proto=\${rest%%:*}; pm=\${rest#*:}
          args="$args --publish-add published=$pub,target=$tgt,protocol=$proto,mode=$pm"
        done
      fi
      # shellcheck disable=SC2086
      [ -z "$args" ] || docker service update --detach $args "$name" >/dev/null ;;
    remove) docker service rm "$name" >/dev/null ;;
  esac
}
nz_stack() {
  action=$1; name=$2
  for id in $(docker service ls -q --filter "label=com.docker.stack.namespace=$name" 2>/dev/null); do
    nz_swarm "$action" "$id" || return 1
  done
}
nz_container() {
  action=$1; name=$2
  docker inspect "$name" >/dev/null 2>&1 || return 0
  case "$action" in
    stop) docker stop -t 30 "$name" >/dev/null ;;
    start) docker start "$name" >/dev/null ;;
    remove) docker rm -fv "$name" >/dev/null ;;
  esac
}
nz_compose() {
  action=$1; name=$2
  # The project's 0.1.x containers only: 1.0's (a moved stack keeps the project name) never.
  ids=""
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$name"); do
    [ "$(docker inspect --format '{{index .Config.Labels "dev.nearzero.edition"}}' "$id" 2>/dev/null)" = 1 ] || ids="$ids $id"
  done
  [ -n "$ids" ] || return 0
  case "$action" in
    stop) docker stop -t 30 $ids >/dev/null ;;
    start) docker start $ids >/dev/null ;;
    remove) docker rm -fv $ids >/dev/null ;;
  esac
}
`;

/**
 * Brings a Compose project's 0.1.x copy back from its own files (spec 29.5): 1.0's labelled
 * containers in the project go first, with their anonymous volumes; then 0.1.x's files run.
 */
const STACK_UP = `
nz_env_allowed() {
  file=$1; shift
  case "$file" in *..*) return 1 ;; esac
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(readlink -f "$file" 2>/dev/null)" = "$file" ] || return 1
  for root in "$@"; do
    root=$(readlink -f "$root" 2>/dev/null) || continue
    [ -n "$root" ] && [ "$root" != / ] || continue
    case "$file" in "$root"/*) return 0 ;; esac
  done
  return 1
}
nz_compose_files() {
  name=$1; folder=$2; envfile=$3; roots=$4; volumes=$5; shift 5
  args=""
  case "$envfile" in
    /*)
      # Kept outside the folder (29a.9): a regular file under the install's data folders only,
      # which on every server include /opt/nearzero and /etc/nearzero.
      roots="/opt/nearzero /etc/nearzero $roots"
      for volume in $volumes; do
        roots="$roots $(docker volume inspect --format '{{.Mountpoint}}' "$volume" 2>/dev/null)"
      done
      # shellcheck disable=SC2086
      nz_env_allowed "$envfile" $roots || { echo "The env file $envfile isn't a regular file under the 0.1.x install's data folders." >&2; return 1; }
      args="--env-file $envfile"; envfile="" ;;
  esac
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$name" --filter "label=dev.nearzero.edition=1")
  [ -z "$ids" ] || docker rm -fv $ids >/dev/null
  for file in "$@"; do args="$args -f $folder/$file"; done
  [ -n "$envfile" ] && args="$args --env-file $folder/$envfile"
  (cd "$folder" && docker compose --project-directory "$folder" -p "$name" $args up -d >/dev/null)
}
`;

function call(action: "stop" | "start" | "remove", workload: LegacyWorkload): string {
  if (!NAME.test(workload.name)) throw new Error(`"${workload.name}" isn't a workload name.`);
  const files =
    workload.kind === "compose-project" && action === "start" ? stackFiles(workload) : null;
  if (files) {
    const args = [
      workload.name,
      files.folder,
      files.envFile ?? "",
      (workload.dataFolders ?? []).join(" "),
      (workload.dataVolumes ?? []).join(" "),
      ...files.composeFiles,
    ];
    return `nz_compose_files ${args.map(shellQuote).join(" ")} || failed="$failed ${workload.name}"`;
  }
  const fn = {
    "swarm-service": "nz_swarm",
    "swarm-stack": "nz_stack",
    container: "nz_container",
    "compose-project": "nz_compose",
  }[workload.kind];
  return `${fn} ${action} ${shellQuote(workload.name)} || failed="$failed ${workload.name}"`;
}

/** A script that applies one action to each workload and fails naming the ones that didn't. */
export function legacyScript(
  action: "stop" | "start" | "remove",
  workloads: readonly LegacyWorkload[],
): string {
  return [
    "set -u",
    FUNCTIONS,
    'failed=""',
    ...workloads.map((workload) => call(action, workload)),
    `if [ -n "$failed" ]; then echo "Couldn't ${action}:$failed" >&2; exit 1; fi`,
    "exit 0",
  ].join("\n");
}

/**
 * Rollback on a remote server: the 1.0 runner and router stop, the containers 1.0 deployed there
 * stop (their volumes stay), and the 0.1.x workloads start again.
 */
export function rollbackServerScript(workloads: readonly LegacyWorkload[]): string {
  return [
    "set -u",
    FUNCTIONS,
    "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop nearzero-runner >/dev/null 2>&1; fi",
    "if command -v rc-service >/dev/null 2>&1; then rc-service nearzero-runner stop >/dev/null 2>&1; fi",
    'if [ -f /run/nearzero-runner.pid ]; then kill "$(cat /run/nearzero-runner.pid)" >/dev/null 2>&1; fi',
    'ids=$(docker ps -q --filter "label=dev.nearzero.managed=true")',
    '[ -n "$ids" ] && docker stop -t 30 $ids >/dev/null',
    STACK_UP,
    'failed=""',
    ...workloads.map((workload) => call("start", workload)),
    'if [ -n "$failed" ]; then echo "Couldn\'t start:$failed" >&2; exit 1; fi',
    "exit 0",
  ].join("\n");
}

/** Runs a script on a server over SSH as setup does (its key, its user, sudo when needed). */
export async function runOnServer(
  services: ControlServices,
  serverId: string,
  script: string,
  signal?: AbortSignal,
): Promise<StepResult> {
  const server = await loadServerAccess(services.db, serverId);
  if (!server) return { ok: false, reason: "the server doesn't exist any more" };
  try {
    const { session, sudo, facts } = await signIn(services, server, signal);
    try {
      const result = await session.exec(
        remoteCommand({ shell: facts.hasBash ? "bash" : "sh", sudo }),
        {
          stdin: script,
          timeoutMs: 10 * 60_000,
          ...(signal ? { signal } : {}),
        },
      );
      if (result.code === 0) return { ok: true };
      const said = (result.stderr || result.stdout).trim().split("\n").at(-1) ?? "";
      return { ok: false, reason: said || `exit code ${result.code}` };
    } finally {
      session.close();
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof AccessFailure ? error.failure.message : (error as Error).message,
    };
  }
}
