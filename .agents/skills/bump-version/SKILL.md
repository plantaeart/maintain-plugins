---
name: bump-version
description: Use when you need to bump the package version in package.json or create an annotated git tag at HEAD. Bumping edits the file only - it does not commit or tag, and --tag is a separate step, so a human stays in control of commits and pushes.
---

# bump-version

Show the current package version and, on request, bump it in `package.json` (no commit, no tag) or create an annotated git tag at the current HEAD. Designed for a workflow where the human commits and pushes manually.

## When to use

Run this skill when you need a quick status read on the project version, want to bump `package.json` (patch / minor / major) for review and manual commit, or want to create the `v<semver>` tag at HEAD.

## How to run

```bash
.agents/skills/bump-version/scripts/bump-version.sh           # status only
.agents/skills/bump-version/scripts/bump-version.sh --patch   # edit package.json to next patch; no commit
.agents/skills/bump-version/scripts/bump-version.sh --minor   # edit package.json to next minor; no commit
.agents/skills/bump-version/scripts/bump-version.sh --major   # edit package.json to next major; no commit
.agents/skills/bump-version/scripts/bump-version.sh --tag     # create annotated tag v<version> at HEAD
.agents/skills/bump-version/scripts/bump-version.sh --help
```

## Behavior

- **No flag** — prints status (name, current version, last git tag, current branch). No file changes.
- **`--patch | --minor | --major`** — edits `package.json` in place to the next semver version. Does **not** commit, does **not** tag. Works on a dirty working tree (your other changes stay alongside the version bump in the staging area).
- **`--tag`** — reads the current `version` from `package.json` and creates an annotated git tag `v<version>` at the current commit. Refuses if the tag already exists.
- **`--help`** — usage.

## Workflow

The skill is intentionally split so the human controls every commit and push:

1. `bump-version.sh --minor` — bumps `package.json`.
2. Review the diff with `git diff package.json`. Commit yourself: `git add package.json && git commit`.
3. (optional, recommended) `bump-version.sh --tag` — creates `v<version>` tag at HEAD.
4. Push yourself: `git push` and `git push --tags`.
5. Publish yourself: `npm publish --access public`.

The full publish playbook lives in the `release` skill.

## Notes

- The displayed version has no leading `v`; the tag is `v<semver>` (per repo convention).
- If the tag `v<version>` already exists, `--tag` refuses to overwrite — bump again.
- `--patch` / `--minor` / `--major` work on a dirty tree; `--tag` does not (a tag points at a clean commit).
