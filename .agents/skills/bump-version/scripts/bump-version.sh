#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FLAG="${1:-}"
if [ "${FLAG}" = "--help" ] || [ "${FLAG}" = "-h" ]; then
  cat << 'EOF'
Usage: bump-version.sh [--patch|--minor|--major|--tag|--help]

No flag      Show status (name, version, last tag, branch). No changes.
--patch      Edit package.json to the next patch version (e.g. 0.9.0 -> 0.9.1).
             Does NOT commit and does NOT tag — you review and commit yourself.
--minor      Edit package.json to the next minor version (e.g. 0.9.0 -> 0.10.0).
             Does NOT commit and does NOT tag.
--major      Edit package.json to the next major version (e.g. 0.9.0 -> 1.0.0).
             Does NOT commit and does NOT tag.
--tag        Create an annotated git tag v<version> at HEAD, where <version>
             is read from package.json. Refuses if the tag already exists.
--help       Show this help.

Workflow:
  1. bash bump-version.sh --minor       # edits package.json
  2. review the diff, then commit       # you commit
  3. bash bump-version.sh --tag         # creates v<version> tag at HEAD
  4. git push && git push --tags        # you push
  5. npm publish --access public        # you publish
EOF
  exit 0
fi

case "${FLAG}" in
  --patch|--minor|--major|--tag) ;;
  "") ;;
  *)
    echo "Unknown flag: ${FLAG}" >&2
    exit 2
    ;;
esac

cd "${ROOT_DIR}"

NAME=$(grep -o '"name": *"[^"]*"' package.json | cut -d'"' -f4)
VERSION=$(grep -o '"version": *"[^"]*"' package.json | cut -d'"' -f4)

LAST_TAG="(no tags)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if LT=$(git describe --tags --abbrev=0 2>/dev/null); then
    LAST_TAG="${LT}"
  fi
fi

BRANCH="(no git)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "(detached)")
fi

print_status() {
  echo "============================================================"
  echo " VERSION STATUS"
  echo "============================================================"
  echo "Project Root : ${ROOT_DIR}"
  echo "• Name       : ${NAME}"
  echo "• Version    : ${VERSION}"
  echo "• Last Tag    : ${LAST_TAG}"
  echo "• Branch      : ${BRANCH}"
  echo "============================================================"
}

if [ -z "${FLAG}" ]; then
  print_status
  exit 0
fi

# --- --tag: create annotated tag at HEAD, version read from package.json ---
if [ "${FLAG}" = "--tag" ]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not a git repository — cannot create a tag." >&2
    exit 1
  fi
  TAG="v${VERSION}"
  if git rev-parse --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
    echo "Tag ${TAG} already exists — refusing to overwrite." >&2
    exit 1
  fi
  git tag -a "${TAG}" -m "Release ${TAG}"
  echo "Tagged HEAD as ${TAG}"
  LAST_TAG="${TAG}"
  print_status
  exit 0
fi

# --- --patch|--minor|--major: bump package.json in-place, no commit, no tag ---
# Parse current "MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]"
NEW_VERSION="${VERSION}"
case "${VERSION}" in
  *-*)
    # Pre-release suffix: bump the pre-release counter if any, otherwise add -0
    PRERELEASE="${VERSION#*-}"
    BASE="${VERSION%%-*}"
    if [[ "${PRERELEASE}" =~ ^[0-9]+$ ]]; then
      NEW_VERSION="${BASE}-$((PRERELEASE + 1))"
    else
      NEW_VERSION="${BASE}-0"
    fi
    ;;
  *)
    BASE="${VERSION%+*}"
    IFS='.' read -r MAJOR MINOR PATCH <<< "${BASE}"
    case "${FLAG}" in
      --patch) NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
      --minor) NEW_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
      --major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    esac
    ;;
esac

# Edit package.json in place via python (preserves formatting better than sed).
python3 -c "
import json
with open('package.json') as f:
    pkg = json.load(f)
pkg['version'] = '${NEW_VERSION}'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
"

VERSION="${NEW_VERSION}"
print_status
echo ""
echo "Next: review package.json, commit, then 'bash bump-version.sh --tag'."