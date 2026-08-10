#!/usr/bin/env sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/nearzero-entrypoint-test.XXXXXX")"

cleanup() {
	rm -rf "$test_dir"
}
trap cleanup 0

mkdir -p "$test_dir/bin"
cat > "$test_dir/bin/node" <<'FAKE_NODE'
#!/usr/bin/env sh
set -eu

service_path="$1"
case "$service_path" in
	dist/wait-for-postgres.mjs)
		if [ "${WAIT_FOR_POSTGRES_MODE:-exit}" = wait ]; then
			printf '%s\n' "$$" > "${TEST_STATE_DIR}/bootstrap.ready"
			trap 'touch "${TEST_STATE_DIR}/bootstrap.terminated"; exit 0' INT TERM
			while :; do
				sleep 1
			done
		fi
		exit "${WAIT_FOR_POSTGRES_EXIT_CODE:-0}"
		;;
	dist/server.mjs)
		service_name=platform
		mode="${PLATFORM_MODE:-wait}"
		exit_code="${PLATFORM_EXIT_CODE:-0}"
		;;
	console-dist/server/entry.mjs)
		service_name=console
		mode="${CONSOLE_MODE:-wait}"
		exit_code="${CONSOLE_EXIT_CODE:-0}"
		printf '%s\n' "${PORT:-unset}" > "${TEST_STATE_DIR}/console.port"
		;;
	*)
		exit 127
		;;
esac

ready_file="${TEST_STATE_DIR}/${service_name}.ready"
term_file="${TEST_STATE_DIR}/${service_name}.terminated"
printf '%s\n' "$$" > "$ready_file"
trap 'touch "$term_file"; exit 0' INT TERM

if [ "$mode" = exit ]; then
	# Let both fake services install their signal handlers before exercising the
	# fail-fast path, matching a runtime process that exits after startup.
	for _attempt in 1 2 3 4 5; do
		if [ -f "${TEST_STATE_DIR}/platform.ready" ] && [ -f "${TEST_STATE_DIR}/console.ready" ]; then
			break
		fi
		sleep 1
	done
	exit "$exit_code"
fi

while :; do
	sleep 1
done
FAKE_NODE
chmod +x "$test_dir/bin/node"

wait_until_ready() {
	state_dir="$1"
	for _attempt in 1 2 3 4 5; do
		if [ -f "$state_dir/platform.ready" ] && [ -f "$state_dir/console.ready" ]; then
			return 0
		fi
		sleep 1
	done
	echo "services did not become ready" >&2
	return 1
}

run_exit_case() {
	case_name="$1"
	expected_status="$2"
	expected_terminated_service="$3"
	state_dir="$test_dir/$case_name"
	mkdir -p "$state_dir"

	set +e
	PATH="$test_dir/bin:$PATH" TEST_STATE_DIR="$state_dir" \
		PLATFORM_MODE="${PLATFORM_MODE:-wait}" PLATFORM_EXIT_CODE="${PLATFORM_EXIT_CODE:-0}" \
		CONSOLE_MODE="${CONSOLE_MODE:-wait}" CONSOLE_EXIT_CODE="${CONSOLE_EXIT_CODE:-0}" \
		sh "$root_dir/docker/entrypoint.sh"
	status="$?"
	set -e

	if [ "$status" -ne "$expected_status" ]; then
		echo "$case_name: expected status $expected_status, got $status" >&2
		return 1
	fi
	if [ ! -f "$state_dir/$expected_terminated_service.terminated" ]; then
		echo "$case_name: sibling $expected_terminated_service was not terminated" >&2
		return 1
	fi
}

PLATFORM_MODE=exit PLATFORM_EXIT_CODE=42 CONSOLE_MODE=wait CONSOLE_EXIT_CODE=0 \
	run_exit_case platform_failure 42 console

PLATFORM_MODE=wait PLATFORM_EXIT_CODE=0 CONSOLE_MODE=exit CONSOLE_EXIT_CODE=0 \
	run_exit_case clean_console_exit 1 platform

signal_state_dir="$test_dir/signal"
mkdir -p "$signal_state_dir"
PATH="$test_dir/bin:$PATH" TEST_STATE_DIR="$signal_state_dir" \
	PLATFORM_MODE=wait CONSOLE_MODE=wait NEARZERO_CONSOLE_PORT=5000 \
	sh "$root_dir/docker/entrypoint.sh" &
entrypoint_pid="$!"
wait_until_ready "$signal_state_dir"
internal_console_port=""
IFS= read -r internal_console_port < "$signal_state_dir/console.port" || true
if [ "$internal_console_port" != 4321 ]; then
	kill -TERM "$entrypoint_pid" 2>/dev/null || true
	wait "$entrypoint_pid" 2>/dev/null || true
	echo "host port override leaked into the internal console listener" >&2
	exit 1
fi
kill -TERM "$entrypoint_pid"
set +e
wait "$entrypoint_pid"
signal_status="$?"
set -e

if [ "$signal_status" -ne 143 ]; then
	echo "signal: expected status 143, got $signal_status" >&2
	exit 1
fi
for service_name in platform console; do
	if [ ! -f "$signal_state_dir/$service_name.terminated" ]; then
		echo "signal: $service_name was not terminated" >&2
		exit 1
	fi
done

bootstrap_state_dir="$test_dir/bootstrap-signal"
mkdir -p "$bootstrap_state_dir"
PATH="$test_dir/bin:$PATH" TEST_STATE_DIR="$bootstrap_state_dir" \
	WAIT_FOR_POSTGRES_MODE=wait sh "$root_dir/docker/entrypoint.sh" &
bootstrap_entrypoint_pid="$!"
for _attempt in 1 2 3 4 5; do
	[ -f "$bootstrap_state_dir/bootstrap.ready" ] && break
	sleep 1
done
if [ ! -f "$bootstrap_state_dir/bootstrap.ready" ]; then
	echo "bootstrap signal: startup process did not become ready" >&2
	exit 1
fi
kill -TERM "$bootstrap_entrypoint_pid"
set +e
wait "$bootstrap_entrypoint_pid"
bootstrap_signal_status="$?"
set -e
if [ "$bootstrap_signal_status" -ne 143 ]; then
	echo "bootstrap signal: expected status 143, got $bootstrap_signal_status" >&2
	exit 1
fi
if [ ! -f "$bootstrap_state_dir/bootstrap.terminated" ]; then
	echo "bootstrap signal: startup process was not terminated" >&2
	exit 1
fi

echo "entrypoint supervision checks passed"
