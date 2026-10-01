#!/usr/bin/env bash
# Seed, launch, and delete a throwaway HOME for testing maintain-plugins.
#
# The extension resolves its plugin directory from os.homedir(), so overriding
# HOME moves both the directory it reads and the directory it rewrites. That is
# the only isolation lever that works for both hosts:
#
#   omp --profile test plugin doctor  ->  ~/.omp/profiles/test/plugins
#   the same session's extension      ->  ~/.omp/plugins        <- default profile
#
# `omp plugin link` is not covered either: it writes the real
# ~/.omp/plugins/package.json, which is exactly the file under test.
#
# The seed is deliberately credential-free. A 185-byte models.yml with
# `auth: none` is enough for the host to boot, load the extension, and answer
# extension_ui_request frames over --mode rpc, which is all these tests do. No
# API key is copied into a throwaway directory and no model call is ever made.
#
# Usage:
#   sandbox-test.sh init   [--host omp|pi] [--package NAME] [--pin VERSION] [--path DIR]
#   sandbox-test.sh use    [--host omp|pi] [--path DIR]
#   sandbox-test.sh remove [--path DIR]
#   sandbox-test.sh --help
#
# Exit codes: 0 ok, 1 refused (guard tripped) or a host/runtime is missing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# The plugin whose stale version we seed. It is this repo's sibling, so the
# fixture stays meaningful: publish a new version and the sandbox is stale again
# without touching the script.
DEFAULT_PACKAGE="system-prompt-switch"

# Auth-free model declaration. Without it the host exits with "No models
# available" before the extension ever loads.
read -r -d '' MODELS_YML <<'YML' || true
providers:
  - id: sandbox
    name: Sandbox
    api: openai-completions
    baseUrl: https://api.openai.com/v1
    auth: none
    models:
      - id: sandbox-model
        name: Sandbox Model
YML

die() {
	echo "sandbox-test: $*" >&2
	exit 1
}

usage() {
	sed -n '/^# Usage:/,/^#   sandbox-test.sh --help/p' "${BASH_SOURCE[0]}" |
		sed 's/^# \{0,1\}//'
}

# --- arguments -------------------------------------------------------------

ACTION="${1:-}"
case "${ACTION}" in
init | use | remove) shift ;;
-h | --help | help)
	usage
	exit 0
	;;
"") die "no action given. Try: sandbox-test.sh --help" ;;
*) die "unknown action '${ACTION}'. Expected init, use or remove." ;;
esac

HOST="omp"
PACKAGE="${DEFAULT_PACKAGE}"
PIN=""
SANDBOX=""

while [ $# -gt 0 ]; do
	case "$1" in
	--host) HOST="${2:-}"; shift 2 ;;
	--package) PACKAGE="${2:-}"; shift 2 ;;
	--pin) PIN="${2:-}"; shift 2 ;;
	--path) SANDBOX="${2:-}"; shift 2 ;;
	*) die "unknown flag '${1}'" ;;
	esac
done

case "${HOST}" in
omp | pi) ;;
*) die "--host must be omp or pi, got '${HOST}'" ;;
esac

REAL_HOME="${HOME}"
[ -n "${SANDBOX}" ] || SANDBOX="${REAL_HOME}/.${HOST}/sandbox-maint"

# The real plugin manifest is the thing `/maint-update-all` must never touch, so
# its digest is recorded at init and re-checked at remove.
real_manifest() {
	if [ "${HOST}" = "omp" ]; then
		echo "${REAL_HOME}/.omp/plugins/package.json"
	else
		echo "${REAL_HOME}/.pi/agent/npm/package.json"
	fi
}

digest() {
	if [ -f "$1" ]; then
		cksum "$1" | awk '{print $1 "-" $2}'
	else
		echo "absent"
	fi
}

# --- init ------------------------------------------------------------------

# The pin defaults to the second-newest published version rather than a literal,
# so the fixture is stale again after every release of the package instead of
# quietly going current. Falls back to whatever --pin says when npm is
# unreachable, which is also the offline escape hatch.
#
# Sets PIN rather than echoing it: run in a command substitution, `die` would
# only kill the subshell, and the caller would carry on with an empty pin and
# seed a manifest pinned to nothing.
resolve_pin() {
	[ -n "${PIN}" ] && return 0
	local versions second
	versions=$(npm view "${PACKAGE}" versions --json 2>/dev/null | tr -d ' \n')
	case "${versions}" in
	\[*)
		second=$(printf '%s' "${versions}" | tr -d '[]"' | tr ',' '\n' | grep -v '^$' | tail -n 2 | head -n 1)
		[ -n "${second}" ] && PIN="${second}"
		;;
	esac
	[ -n "${PIN}" ] ||
		die "could not read published versions of ${PACKAGE} from npm. Pass --pin <version> to seed offline."
}

cmd_init() {
	resolve_pin

	if ! command -v "${HOST}" >/dev/null 2>&1; then
		die "'${HOST}' is not on PATH. Install the host CLI, or pass --host for the other one."
	fi

	# Idempotent by design: init is also the reset.
	rm -rf "${SANDBOX}"

	if [ "${HOST}" = "omp" ]; then
		mkdir -p "${SANDBOX}/.omp/agent" "${SANDBOX}/.omp/plugins"
		printf '%s\n' "${MODELS_YML}" > "${SANDBOX}/.omp/agent/models.yml"
		# setupVersion is what makes a fresh HOME drop into the sign-in wizard,
		# which swallows the TUI before the extension is ever loaded. No real
		# session is planned in the sandbox, so the step is marked done.
		printf 'setupVersion: 2\n' > "${SANDBOX}/.omp/agent/config.yml"
		cat > "${SANDBOX}/.omp/plugins/package.json" <<JSON
{
  "name": "omp-plugins",
  "private": true,
  "dependencies": { "${PACKAGE}": "npm:${PACKAGE}@${PIN}" }
}
JSON
		cat > "${SANDBOX}/.omp/plugins/omp-plugins.lock.json" <<JSON
{
  "plugins": { "${PACKAGE}": { "version": "${PIN}", "enabledFeatures": null, "enabled": true } },
  "settings": {}
}
JSON
	else
		mkdir -p "${SANDBOX}/.pi/agent/npm/node_modules/${PACKAGE}"
		[ -f "${REAL_HOME}/.pi/agent/auth.json" ] &&
			cp "${REAL_HOME}/.pi/agent/auth.json" "${SANDBOX}/.pi/agent/auth.json"
		printf '{"packages":["npm:%s"]}\n' "${PACKAGE}" > "${SANDBOX}/.pi/agent/settings.json"
		cat > "${SANDBOX}/.pi/agent/npm/package.json" <<JSON
{
  "name": "pi-npm",
  "private": true,
  "dependencies": { "${PACKAGE}": "${PIN}" }
}
JSON
		# Pi reads the installed version from the package's own manifest and
		# skips a package whose manifest is missing, so discovery needs this
		# stub. It is never installed - `/maint-update-all` does that.
		cat > "${SANDBOX}/.pi/agent/npm/node_modules/${PACKAGE}/package.json" <<JSON
{
  "name": "${PACKAGE}",
  "version": "${PIN}"
}
JSON
	fi

	mkdir -p "${SANDBOX}/.agents"
	digest "$(real_manifest)" > "${SANDBOX}/.agents/real-manifest.cksum"

	local latest
	latest=$(npm view "${PACKAGE}" version 2>/dev/null || echo "unknown")

	echo "Sandbox ready: ${SANDBOX}"
	echo "  host      ${HOST}"
	echo "  plugin    ${PACKAGE}"
	echo "  pinned    ${PIN}   (npm latest: ${latest})"
	echo "  seeded    $(du -sh "${SANDBOX}" | cut -f1)"
	echo "  guard     $(cat "${SANDBOX}/.agents/real-manifest.cksum")  $(real_manifest)"
	echo ""
	echo "First launch downloads the host's native modules into the sandbox (~360M)."
	echo "Next:"
	echo "  bash ${0} use --host ${HOST} --path ${SANDBOX}"
}

# --- use -------------------------------------------------------------------

cmd_use() {
	[ -d "${SANDBOX}" ] || die "no sandbox at ${SANDBOX}. Run: sandbox-test.sh init"

	# pi has no --no-rules; the two hosts do not share a flag set.
	local flags="--no-session --no-skills"
	[ "${HOST}" = "omp" ] && flags="${flags} --no-rules"
	flags="${flags} -e ${ROOT_DIR}/extensions/index.ts"

	echo "# Inside the sandbox:"
	echo "#   /maint-updates-check   read-only report"
	echo "#   /maint-update-all      confirm, then install into $(plugin_dir)"
	echo ""
	echo "HOME=\"${SANDBOX}\" ${HOST} ${flags}"
	echo ""
	echo "# Inspect what the sandbox resolved:"
	if [ "${HOST}" = "omp" ]; then
		echo "HOME=\"${SANDBOX}\" omp plugin list"
	else
		echo "HOME=\"${SANDBOX}\" pi list"
	fi
}

plugin_dir() {
	if [ "${HOST}" = "omp" ]; then
		echo "${SANDBOX}/.omp/plugins"
	else
		echo "${SANDBOX}/.pi/agent/npm"
	fi
}

# --- remove ----------------------------------------------------------------

cmd_remove() {
	# Two guards, because this is the only irreversible action here.
	# 1. the path must live under the host's own config root and say "sandbox"
	case "${SANDBOX}" in
	"${REAL_HOME}/.omp/"* | "${REAL_HOME}/.pi/"*)
		case "${SANDBOX}" in
		*sandbox*) ;;
		*) die "refusing to remove ${SANDBOX}: path does not contain 'sandbox'" ;;
		esac
		;;
	*) die "refusing to remove ${SANDBOX}: not under ${REAL_HOME}/.omp or ${REAL_HOME}/.pi" ;;
	esac

	# 2. the real plugin manifest must still match what init recorded. If it
	#    differs, a run outside the sandbox happened, and deleting the evidence
	#    is exactly what you do not want.
	local record="${SANDBOX}/.agents/real-manifest.cksum"
	if [ -f "${record}" ]; then
		local expected current
		expected=$(cat "${record}")
		current=$(digest "$(real_manifest)")
		if [ "${expected}" != "${current}" ]; then
			echo "sandbox-test: refusing to remove ${SANDBOX}" >&2
			echo "  the real manifest changed since init:" >&2
			echo "    expected ${expected}" >&2
			echo "    now      ${current}" >&2
			echo "  Inspect $(real_manifest) first, then delete the sandbox by hand." >&2
			exit 1
		fi
	fi

	if [ ! -d "${SANDBOX}" ]; then
		echo "Nothing to remove: ${SANDBOX} does not exist."
		exit 0
	fi

	local size
	size=$(du -sh "${SANDBOX}" 2>/dev/null | cut -f1)
	rm -rf "${SANDBOX}"
	echo "Removed ${SANDBOX} (${size:-unknown})."
	echo "Real manifest untouched: $(real_manifest) ($(digest "$(real_manifest)"))."
}

case "${ACTION}" in
init) cmd_init ;;
use) cmd_use ;;
remove) cmd_remove ;;
esac
