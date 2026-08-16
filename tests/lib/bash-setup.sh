#!/usr/bin/env bash
# Shared setup functions for bash-based integration tests.
# Source this file at the start of test scripts.

set -euo pipefail

# Auto-load .env.test so these scripts work when invoked directly and not just via
# `npm test`, which sources it for the whole chain. Mirrors tests/lib/rpc-harness.mjs,
# which already does this for the .mjs tests.
__ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env.test"
if [[ -f "$__ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$__ENV_FILE"
	set +a
fi

# macOS does not ship GNU timeout. Prefer the native command when available,
# then Homebrew's gtimeout, and finally Perl's exec-preserving alarm. The test
# cleanup trap reaps descendants after a timeout.
if ! command -v timeout >/dev/null 2>&1; then
	if command -v gtimeout >/dev/null 2>&1; then
		timeout() { gtimeout "$@"; }
	else
		timeout() {
			perl -e '$seconds = shift @ARGV; alarm $seconds; exec @ARGV; die "exec failed: $!\n"' "$@"
		}
	fi
fi

# Setup standard test environment.
# Usage: setup_test_env "test-name"
# Sets: DIR, LOGDIR, LOGFILE (if specified), DEBUG_LOG, and exports CLAUDE_BRIDGE_DEBUG
setup_test_env() {
	local name="$1"
	local log_suffix="${2:-.log}"  # optional: suffix for logfile, or "none" for no logfile

	DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
	LOGDIR="$DIR/.test-output"
	mkdir -p "$LOGDIR"

	export CLAUDE_BRIDGE_DEBUG=1
	DEBUG_LOG="$LOGDIR/${name}-debug.log"
	export CLAUDE_BRIDGE_DEBUG_PATH="$DEBUG_LOG"

	if [[ "$log_suffix" != "none" ]]; then
		LOGFILE="$LOGDIR/${name}${log_suffix}"
	else
		LOGFILE=""
	fi

	# Exercise the exact Pi version pinned by this repository, not whichever
	# global CLI happens to be installed. Run from the project root so local
	# config remains visible.
	PATH="$DIR/node_modules/.bin:$PATH"
	cd "$DIR"

	# Export for use in tests
	export DIR LOGDIR DEBUG_LOG LOGFILE PATH
}

# Kill all descendant processes (children, grandchildren, etc.).
# Use as: trap kill_descendants EXIT
kill_descendants() {
	pkill -P $$ 2>/dev/null || true
	sleep 1
}

# Require an environment variable or exit with error.
# Usage: require_env VARNAME
require_env() {
	local var="$1"
	local val="${!var:-}"
	if [[ -z "$val" ]]; then
		echo "ERROR: $var not set (see .env.test)"
		exit 1
	fi
	echo "$val"
}

# Check for required commands or exit with error.
# Usage: require_command cmd1 cmd2 ...
require_command() {
	local cmd
	for cmd in "$@"; do
		if ! command -v "$cmd" >/dev/null 2>&1; then
			echo "ERROR: $cmd is required but not installed"
			exit 1
		fi
	done
}
