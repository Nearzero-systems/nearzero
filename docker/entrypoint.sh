#!/usr/bin/env sh
set -eu

# The combined OSS image has two equally critical processes. Run each process
# behind a small supervisor so the parent can learn which one exits first while
# remaining compatible with POSIX shells that do not provide `wait -n`.
event_dir="$(mktemp -d "${TMPDIR:-/tmp}/nearzero-entrypoint.XXXXXX")"
event_pipe="$event_dir/service-exit"
mkfifo "$event_pipe"
# Keep one parent-owned read/write descriptor open so opening the FIFO cannot be
# interrupted before either service has finished starting.
exec 3<> "$event_pipe"

platform_supervisor_pid=""
console_supervisor_pid=""
bootstrap_pid=""

cleanup() {
	rm -rf "$event_dir"
}

reap_supervisor() {
	pid="$1"
	[ -n "$pid" ] || return 0
	if wait "$pid" 2>/dev/null; then
		return 0
	fi
	return 0
}

signal_supervisors() {
	signal="$1"
	for pid in "$platform_supervisor_pid" "$console_supervisor_pid"; do
		[ -n "$pid" ] || continue
		kill "-$signal" "$pid" 2>/dev/null || true
	done
}

terminate_bootstrap() {
	signal="$1"
	[ -n "$bootstrap_pid" ] || return 0

	watchdog_pid=""
	if kill -0 "$bootstrap_pid" 2>/dev/null; then
		kill "-$signal" "$bootstrap_pid" 2>/dev/null || true
		(
			sleep 8
			kill -KILL "$bootstrap_pid" 2>/dev/null || true
		) &
		watchdog_pid="$!"
	fi
	wait "$bootstrap_pid" 2>/dev/null || true
	if [ -n "$watchdog_pid" ]; then
		kill "$watchdog_pid" 2>/dev/null || true
		wait "$watchdog_pid" 2>/dev/null || true
	fi
	bootstrap_pid=""
}

shutdown() {
	signal="$1"
	exit_status="$2"

	# Do not recursively run the shutdown handler while reaping the children.
	trap - INT TERM
	terminate_bootstrap "$signal"
	signal_supervisors "$signal"
	reap_supervisor "$platform_supervisor_pid"
	reap_supervisor "$console_supervisor_pid"
	exit "$exit_status"
}

supervise_service() {
	# The service process must not inherit PID 1's event descriptor.
	exec 3>&-
	service_name="$1"
	shift
	child_pid=""
	watchdog_pid=""

	stop_child() {
		signal="$1"
		exit_status="$2"
		trap - INT TERM

		if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
			kill "-$signal" "$child_pid" 2>/dev/null || true

			# A stuck Node process must not keep PID 1 alive forever during a
			# restart. Give it a short grace period, then force termination.
			(
				sleep 8
				kill -KILL "$child_pid" 2>/dev/null || true
			) &
			watchdog_pid="$!"
		fi

		if [ -n "$child_pid" ]; then
			wait "$child_pid" 2>/dev/null || true
		fi
		if [ -n "$watchdog_pid" ]; then
			kill "$watchdog_pid" 2>/dev/null || true
			wait "$watchdog_pid" 2>/dev/null || true
		fi
		exit "$exit_status"
	}

	trap 'stop_child TERM 143' TERM
	trap 'stop_child INT 130' INT

	"$@" &
	child_pid="$!"
	if wait "$child_pid"; then
		service_status=0
	else
		service_status="$?"
	fi

	trap - INT TERM
	printf '%s %s\n' "$service_name" "$service_status" > "$event_pipe"
	exit "$service_status"
}

trap cleanup 0
trap 'shutdown TERM 143' TERM
trap 'shutdown INT 130' INT

(
	exec 3>&-
	exec node dist/wait-for-postgres.mjs
) &
bootstrap_pid="$!"
if wait "$bootstrap_pid"; then
	bootstrap_status=0
else
	bootstrap_status="$?"
fi
bootstrap_pid=""
if [ "$bootstrap_status" -ne 0 ]; then
	exit "$bootstrap_status"
fi

supervise_service platform node dist/server.mjs &
platform_supervisor_pid="$!"

supervise_service console env \
	HOST="${HOST:-0.0.0.0}" \
	PORT="${NEARZERO_CONSOLE_INTERNAL_PORT:-4321}" \
	node console-dist/server/entry.mjs &
console_supervisor_pid="$!"

# The first supervisor to report an exit makes the whole combined service
# unhealthy. Stop and reap its sibling, then preserve a failure status. A clean
# exit is still unexpected for a long-running service, so translate 0 to 1.
if IFS=' ' read -r exited_service exited_status <&3; then
	:
else
	exited_service="unknown"
	exited_status=1
fi

trap - INT TERM
signal_supervisors TERM
reap_supervisor "$platform_supervisor_pid"
reap_supervisor "$console_supervisor_pid"

if [ "$exited_status" -eq 0 ]; then
	exited_status=1
fi

printf '%s\n' "Nearzero ${exited_service} service exited; stopping combined runtime." >&2
exit "$exited_status"
