---
name: release
description: Use when cutting a maintain-plugins release - bump the version, tag the commit, publish to npm, and verify the pi gallery picks it up. Covers the exact command order and what each step prints when it works.
---

# release

Publishing a version touches three separate things that must agree: the version in `package.json`, the git tag, and what npm serves. This is the order that keeps them in step.

## 1. Verify first

```bash
bash .agents/skills/host-version/scripts/check-host-versions.sh
bun run ci
```

CI must be green on both matrix legs. A release that ships a red suite is not a release.

## 2. Bump the version

```bash
bash .agents/skills/bump-version/scripts/bump-version.sh            # status only
bash .agents/skills/bump-version/scripts/bump-version.sh --patch    # 0.1.0 -> 0.1.1
bash .agents/skills/bump-version/scripts/bump-version.sh --minor    # 0.1.0 -> 0.2.0
bash .agents/skills/bump-version/scripts/bump-version.sh --major    # 0.1.0 -> 1.0.0
```

The flag is required to change anything; with no flag the script only reports.

**Zero-padded patch numbers.** If this package keeps climbing `0.1.0`, `0.1.1`, ... , `0.1.10`, note that `--patch` on `0.1.9` yields `0.1.10` correctly, but `--minor` yields `0.2.0` — a different track entirely. Edit `package.json` by hand if you want `0.1.10` without a minor bump.

## 3. Commit and tag

```bash
git add -A
git commit -m "chore: release v0.1.1"
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin master
git push origin v0.1.1
```

**Annotated tags only** (`-a`). GitHub Releases are built from them; a lightweight tag will not work.

## 4. Publish

```bash
npm whoami                                  # must be the owning account
grep '"version"' package.json               # must match the tag
npm view maintain-plugins version           # the currently published version
npm publish --access public
```

Read the last line of the output. It names the version that actually went out:

```
+ maintain-plugins@0.1.1
```

Anything else means it did not publish.

**`npm publish` reads `package.json`, not the git tag.** They must already agree from steps 2 and 3, but nothing in the command checks it — a mismatched tag publishes the old version and fails with `EPUBLISHCONFLICT`.

**Common failures**

| Error | Cause |
|---|---|
| `E404` on PUT | Not logged in as the account that owns the name. `npm login` |
| `EPUBLISHCONFLICT` | That version already exists. Bump again. |
| `ENEEDAUTH` | Expired token. `npm login` |

## 5. Verify

```bash
npm view maintain-plugins version
npm view maintain-plugins dist.tarball
```

Then install it into a real host and confirm the extension loads:

```bash
omp plugin uninstall maintain-plugins
omp plugin install npm:maintain-plugins
omp -e ./extensions/index.ts
# type /maint to confirm both commands autocomplete
```

`pi install npm:maintain-plugins` for the pi host.

## pi gallery

The gallery is driven by the `pi-package` keyword, so a publish appears within minutes. https://pi.dev/packages/maintain-plugins

## Never commit

Do not commit or push unless asked, and never run `git commit` as part of a code change — only in step 3 of an actual release.
