#!/usr/bin/env bash
# Reproduce a real plugin upgrade headlessly, in a throwaway HOME.
#
# Unlike sandbox-test (stub manifests, driven through a TUI/rpc host), this
# installs an OLD version for real with the host's own installer, then runs the
# extension's real upgrade code (discovery, registry check, applyUpdates, which
# shells out to `omp plugin install` / `npm install`) and reports the outcome.
#
# Usage:
#   upgrade-repro.sh seed    [--host omp|pi] [--package NAME] [--pin VERSION] [--home DIR]
#   upgrade-repro.sh upgrade [--host omp|pi] [--home DIR] [--bun-dir DIR]
#   upgrade-repro.sh run     (seed + upgrade)
#   upgrade-repro.sh clean   [--home DIR]
#   upgrade-repro.sh --help
#
# --bun-dir DIR  prepend DIR to PATH (seed and upgrade), e.g. the bin dir of an old
#                bun, to reproduce "Bun runtime must be >= x" failures.
# Exit codes: 0 upgraded, 1 install failed, 2 install "succeeded" but version unchanged.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

die() { echo "upgrade-repro: $*" >&2; exit 1; }

ACTION="${1:-}"
case "${ACTION}" in
seed | upgrade | run | clean) shift ;;
-h | --help | help) sed -n '/^# Usage:/,/^# Exit codes/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
*) die "expected seed, upgrade, run or clean (see --help)" ;;
esac

HOST="omp"; PACKAGE="system-prompt-switch"; PIN=""; SBX="/tmp/opencode/upgrade-repro"; BUN_DIR=""
while [ $# -gt 0 ]; do
	case "$1" in
	--host) HOST="${2:-}"; shift 2 ;;
	--package) PACKAGE="${2:-}"; shift 2 ;;
	--pin) PIN="${2:-}"; shift 2 ;;
	--home) SBX="${2:-}"; shift 2 ;;
	--bun-dir) BUN_DIR="${2:-}"; shift 2 ;;
	*) die "unknown flag '$1'" ;;
	esac
done
case "${HOST}" in omp | pi) ;; *) die "--host must be omp or pi" ;; esac
[ -z "${BUN_DIR}" ] || export PATH="${BUN_DIR}:${PATH}"

cmd_seed() {
	command -v "${HOST}" >/dev/null || die "'${HOST}' is not on PATH"
	if [ -z "${PIN}" ]; then
		# Second-newest published version, so the fixture is stale after each release.
		PIN=$(npm view "${PACKAGE}" versions --json 2>/dev/null | tr -d ' \n[]"' | tr ',' '\n' | grep -v '^$' | tail -n 2 | head -n 1)
		[ -n "${PIN}" ] || die "cannot read versions of ${PACKAGE}; pass --pin"
	fi
	case "${SBX}" in /tmp/*) ;; *) die "refusing sandbox outside /tmp: ${SBX}" ;; esac
	rm -rf "${SBX}"
	mkdir -p "${SBX}/.omp/agent" "${SBX}/.pi/agent"
	[ "${HOST}" = omp ] && printf 'setupVersion: 2\n' > "${SBX}/.omp/agent/config.yml"
	echo "seeding ${PACKAGE}@${PIN} with '${HOST}' in ${SBX}"
	if [ "${HOST}" = omp ]; then
		(cd "${SBX}" && HOME="${SBX}" omp plugin install "${PACKAGE}@${PIN}") || die "real install of the old version failed"
	else
		mkdir -p "${SBX}/.pi/agent/npm"
		HOME="${SBX}" npm install --prefix "${SBX}/.pi/agent/npm" "${PACKAGE}@${PIN}" || die "real install failed"
		printf '{"packages":["npm:%s"]}\n' "${PACKAGE}" > "${SBX}/.pi/agent/settings.json"
	fi
	HOME="${SBX}" ${HOST} $([ "${HOST}" = omp ] && echo "plugin list" || echo list) 2>&1 | sed 's/^/  /'
}

cmd_upgrade() {
	[ -d "${SBX}" ] || die "no sandbox at ${SBX}; run seed first"
	echo "bun in use: $(command -v bun) ($(bun --version 2>&1))"
	HOME="${SBX}" REPRO_HOST="${HOST}" bun "${SCRIPT_DIR}/upgrade-driver.ts"
}

cmd_clean() {
	case "${SBX}" in /tmp/*repro*) rm -rf "${SBX}"; echo "removed ${SBX}" ;; *) die "refusing to remove ${SBX}" ;; esac
}

case "${ACTION}" in
seed) cmd_seed ;;
upgrade) cmd_upgrade ;;
run) cmd_seed && cmd_upgrade ;;
clean) cmd_clean ;;
esac
