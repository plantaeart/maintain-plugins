#!/usr/bin/env bash
# Skill validation, shared by CI and local runs.
#
# The `lint-skills` job in .github/workflows/ci.yml calls this script directly,
# so CI and a contributor always apply the same rules.
#
# It runs two validators over every .agents/skills/* directory:
#   1. skills-ref validate   (pinned by commit, installed with uv)
#   2. skill-check check     (npx, --no-security-scan)
#
# Locally a missing tool is reported and skipped, so a contributor without
# uv/npx is not blocked. In CI, where both are installed, a missing tool is a
# hard failure: skipping there would let a broken validator pass unnoticed.
#
# Usage:
#   bash .agents/skills/ci-check/scripts/validate-skills.sh
#   CI=true bash .agents/skills/ci-check/scripts/validate-skills.sh   # strict
set -uo pipefail

# scripts/ -> ci-check/ -> skills/ -> .agents/ -> repo root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILLS_DIR="${ROOT_DIR}/.agents/skills"
status=0

# GitHub Actions sets CI=true; honour it so CI can never silently skip a check.
STRICT="${CI:-}"

if [ ! -d "${SKILLS_DIR}" ]; then
	echo "No skills directory at ${SKILLS_DIR}; nothing to validate."
	exit 0
fi

missing_tool() {
	echo "ERROR: $1 is required in CI but not on PATH." >&2
	status=1
}

echo "--- skills-ref validate ---"
if command -v skills-ref >/dev/null 2>&1; then
	for dir in "${SKILLS_DIR}"/*/; do
		skills-ref validate "${dir}" || status=1
	done
elif [ -n "${STRICT}" ]; then
	missing_tool "skills-ref (install: uv tool install 'git+https://github.com/agentskills/agentskills.git#subdirectory=skills-ref')"
else
	echo "skills-ref not installed. Skipping."
	echo "  install: uv tool install 'git+https://github.com/agentskills/agentskills.git#subdirectory=skills-ref'"
fi

echo ""
echo "--- skill-check ---"
if command -v npx >/dev/null 2>&1; then
	npx -y skill-check@1.2.0 check --no-security-scan "${SKILLS_DIR}" || status=1
elif [ -n "${STRICT}" ]; then
	missing_tool "npx (CI sets up Node.js)"
else
	echo "npx not available. Skipping."
fi

exit "${status}"
