# maintain-plugins — Dev Guide

Hexagonal (Ports & Adapters) Pi/OMP extension written in TypeScript, ESM, run directly by the host through Bun. No build step.

---

## Requirements

- Bun ≥ 1.3
- Node ≥ 22 (for `npm` tooling during publish)
- Pi or OMP installed and on `PATH` (for the e2e suite)

---

## Layout

```
extensions/
  index.ts                # Entry point registered with Pi/OMP (`package.json` -> `main` / `extensions`)
src/
  ports/                  # Outbound interfaces: cache.port, process.port, registry.port
  core/                   # Domain logic: paths, plugin-registry, version-check, updater
  core/types/             # Shared domain types
tests/
  unit/                   # Domain tests with injected ports (no host required)
  e2e/                    # Real host CLI driven over --mode rpc (skips if no host on PATH)
.agents/
  skills/                 # Project-local omp skills (not shipped to npm; see `.npmignore`)
    bump-version/         # Edit `package.json` + annotated git tag (no commit)
    ci-check/             # Full green-pipeline run + skill validation
    get-context/          # One-shot project overview
    host-version/         # Compare CI host pins against the latest published release
    release/              # Full publish playbook
    sandbox-test/         # Throwaway HOME for testing the extension by hand
    unit-test/            # Test conventions for this repo
```

The domain never imports from `extensions/`; tests inject mock implementations through the ports.

---

## Scripts

```bash
bun test                  # 37 unit + 2 e2e tests
bun test tests/e2e/       # e2e only (real host CLIs; skips if none on PATH)
bun run typecheck         # tsc --noEmit
bun run lint              # oxlint
bun run ci                # lint + typecheck + test + validate:skills (what CI runs)
```

CI runs the suite twice, once per host (`OMPCODE=0` and `OMPCODE=1`), because the extension ships for both and the tests derive their expectations from `detectHost()` rather than hard-coding omp. Both legs also spawn the real host CLIs, which CI installs at pinned versions — see the `host-version` skill when updating those pins.

---

## Testing locally

Everything below runs against a **sandbox**: a throwaway `HOME` holding a deliberately stale plugin. Three commands, all from the `sandbox-test` skill.

### Why a sandbox and not `--profile`

`/maint-update-all` rewrites the host's plugin manifest, and that manifest is what every real plugin install reads. `--profile` does not isolate this extension:

```bash
omp --profile test plugin doctor --json   # -> ~/.omp/profiles/test/plugins
# while the extension in that same session reports:
#   pluginDir = ~/.omp/plugins              <- the default profile
```

`pluginDirFor()` and `cachePathFor()` in `src/core/paths.ts` build their paths from `os.homedir()` plus `.omp/plugins` and never read `OMP_PROFILE`. A session run with `--profile test` discovers the default profile's plugins and rewrites the **real** manifest. Pi has no `--profile` flag at all.

`omp plugin link .` is not an alternative either: it writes the real `~/.omp/plugins/package.json`, which is the file under test.

`HOME` is the lever that works for both hosts. The extension reads `os.homedir()`, so redirecting it moves both the directory it reads and the directory it rewrites.

### 1. init

```bash
bash .agents/skills/sandbox-test/scripts/sandbox-test.sh init
```

Seeds `~/.omp/sandbox-maint` (or `~/.pi/sandbox-maint`):

```
Sandbox ready: /home/you/.omp/sandbox-maint
  host      omp
  plugin    system-prompt-switch
  pinned    0.9.5   (npm latest: 0.9.10)
  seeded    16K
  guard     2414824150-299  /home/you/.omp/plugins/package.json
```

- **No credentials.** The seed includes a 185-byte `models.yml` with `auth: none`, so the host boots and loads the extension without an API key and without a model call. Nothing secret is copied into a throwaway directory.
- **A plugin you control.** The default is `system-prompt-switch`, this repo's sibling, pinned to the *second-newest* published version. Publish a release and the sandbox goes stale again without editing anything, so the fixture cannot silently go current. Never test against a plugin you do not control — a third-party release would change what the report says.
- **A guard.** The digest of your real plugin manifest is recorded here and re-checked by `remove`.

`init` is idempotent: it removes and recreates the sandbox, so **init is also the reset**.

Useful flags:

```bash
sandbox-test.sh init --host pi                  # the other host
sandbox-test.sh init --package <name>           # a different package
sandbox-test.sh init --pin 0.9.5                # a literal pin; also the offline path
sandbox-test.sh init --path /tmp/maint-scratch  # somewhere else entirely
```

### 2. use

```bash
bash .agents/skills/sandbox-test/scripts/sandbox-test.sh use
```

Prints the launch command rather than running it, so you can edit the flags:

```
HOME="/home/you/.omp/sandbox-maint" omp --no-session --no-skills --no-rules -e /path/to/extensions/index.ts
```

pi has no `--no-rules`; its line omits it. The script knows which is which — do not carry one host's flags to the other.

Then, inside that session:

| Step | Expected |
|---|---|
| session start | `1 plugin update(s) available - run /maint-updates-check to review` |
| `/maint-updates-check` | `omp plugins (1 installed, 1 update available)` + `system-prompt-switch: 0.9.5 -> 0.9.10` |
| `/maint-update-all` | confirm naming the delta, then `Updated 1 plugin(s)` |
| decline the confirm | `Update cancelled.` and nothing written |

To see what the sandbox resolved afterwards:

```bash
HOME="$HOME/.omp/sandbox-maint" omp plugin list   # omp
HOME="$HOME/.pi/sandbox-maint"  pi list           # pi — `pi list`, not `pi plugin list`
```

First launch in a fresh sandbox downloads the host's native modules into `$SANDBOX/.omp/natives` (~360M, a few seconds). Everything else stays under 1M.

### 3. remove

```bash
bash .agents/skills/sandbox-test/scripts/sandbox-test.sh remove
```

Two guards, because this is the only irreversible step:

1. the path must be under `~/.omp/` or `~/.pi/` **and** contain `sandbox`,
2. the real plugin manifest must still match the digest `init` recorded.

Either failure refuses and explains. The second is the useful one: if your real manifest changed since `init`, something ran outside the sandbox, and deleting the evidence is the wrong move.

```
Removed /home/you/.omp/sandbox-maint (364M).
Real manifest untouched: /home/you/.omp/plugins/package.json (2414824150-299).
```

### Hosts differ in what discovery reads

| Host | Reads the stale version from | Needs a real install? |
|---|---|---|
| OMP | `package.json` + `omp-plugins.lock.json` | no |
| Pi | `node_modules/<pkg>/package.json` | no — a stub manifest is seeded, since a package listed in settings with no manifest counts as not installed |

Neither needs `pi install` or `omp plugin install`. The old version gets installed *during* the test, by `/maint-update-all` itself.

---

## Running the tests

`tests/e2e/sandbox.test.ts` spawns the real host in `--mode rpc`: commands go in on stdin, the extension's output comes back as `extension_ui_request` frames on stdout, and the test answers the confirmation itself. That is what lets a real end-to-end run with nobody present.

```bash
bun test tests/e2e/sandbox.test.ts
bun test -t "omp"            # one host
```

It covers, per host: the session-start notice fires; `/maint-updates-check` reports the delta and writes nothing; declining the confirm writes nothing; accepting it installs into the sandbox **and leaves the real manifest byte-identical**.

A command is asserted by the host *answering* it, not by an `available_commands_update` frame: omp broadcasts that frame and pi does not, so waiting on it would hang on one host forever.

The suite skips with a printed reason when the host CLI is off `PATH`, so a contributor without `omp` and `pi` is not blocked. Each test builds its own sandbox under `os.tmpdir()`, never the skill's default, so it cannot collide with a sandbox you are using, and removes it afterwards.

No API key is involved: the sandbox seeds a credential-free `models.yml` with `auth: none`, so the host boots and loads the extension without a model call.

The rollback path needs no real failure — `applyUpdates()` takes an optional `run`, so a unit test covers it:

```ts
const result = await applyUpdates(records, {
  pluginDirs: new Map([[HostPlatform.Omp, dir]]),
  run: async () => ({ code: 1, stderr: "simulated install failure" }),
});
// result.ok === false, and the manifest is byte-identical to its pre-update content.
```

---

## Architecture notes

- **Ports**: `src/ports/*.port.ts` define `RegistryLookup`, `RunCommand`, and the cache read/write pair. Each is injected, so no unit test touches the network or spawns a process.
- **Core**: `plugin-registry.ts` discovers what is installed, `version-check.ts` fills in `latest` from the registry (with cache and offline fallback), `updater.ts` plans and applies the change with backup + rollback.
- **Extension**: `extensions/index.ts` wires the three together, registers the two commands, and fires a detached check on session start. One in-flight check is shared by the notice and both commands, so a start followed by `/maint-updates-check` does not re-query.
- **Why hexagonal**: keeps the domain unit-testable without spawning a host. All 37 unit tests run in under 50ms and none of them touch the network.
- **Deliberate simplifications**, each marked with a `ponytail:` comment at the site: sequential registry lookups, pre-release versions compared as the plain number they lead with, and self-update excluded.

### What the update reports, and where

Two constraints shaped the progress UI, both read out of the host package rather than guessed:

**No colour.** `ctx.ui.notify(message, type?)` accepts only `"info" | "warning" | "error"` (`dist/core/extensions/types.d.ts`). There is no colour parameter, so every notification this extension raises is painted the same grey no matter what it says. That is why the report uses a glyph per row — `⬆️` stale, `·` current — instead of a colour that cannot be set.

**`setWorkingMessage()` does not work outside streaming.** It stores the message and forwards it only when `activeStatusIndicator?.kind === "working"` (`dist/modes/interactive/interactive-mode.js`), and that indicator exists only while `session.isStreaming`. A command handler runs between turns, so the message would be set and never drawn. It is also a hard no-op in RPC mode (`dist/modes/rpc/rpc-mode.js`).

So progress goes through `ctx.ui.setWidget(key, lines)`, which renders above the editor and — unlike `setWorkingMessage` — is a real RPC frame, so `tests/e2e/sandbox.test.ts` can assert it. The widget is cleared in both the success and failure paths; a row left above the editor would claim work that is already over.

The row animates rather than sitting still. `setWorkingIndicator()` — the API that would give a real animated spinner — has the same `kind === "working"` gate as `setWorkingMessage` and is a no-op in RPC, so the host's own indicator cannot be borrowed. But `setExtensionWidget` calls `requestRender()` on every `setWidget`, so a `setInterval` re-setting the row does paint. The frames are the host's own, lifted from `examples/extensions/working-indicator.ts` in the host package, so the spinner matches what the user sees everywhere else instead of inventing a second look.

The reload offer exists because the running session keeps the plugin code it started with. `ctx.reload()` is on `ExtensionCommandContext`, which is why that one handler takes that type rather than the base `ExtensionContext`. The dialog lists each plugin and its new version: the question being asked is "what am I about to reload", which a count alone does not answer.

### Each host installs with its own installer

The installer choice is not a preference — it is what keeps the next check honest.

OMP discovers the installed version from `omp-plugins.lock.json`, not from `node_modules`. `bun add` rewrites `package.json` and leaves that lock on the old version, so a `bun`-based update produced exactly this:

```
/maint-updates-check  →  system-prompt-switch: 0.9.5 -> 0.9.10
/maint-update-all     →  Updated 1 plugin(s)
omp plugin list       →  system-prompt-switch@0.9.10     <- really installed
/maint-updates-check  →  system-prompt-switch: 0.9.5 -> 0.9.10   <- still "stale"
```

`omp plugin install <pkg>@<ver>` rewrites the lock, so it is what omp uses now. It takes no target flag, so it is run with `cwd` set to the plugin directory — hence the optional second argument on `RunCommand`.

Pi reads the version out of `node_modules`, which `npm install` writes directly, so Pi never had this problem and its installer is unchanged.

Both are covered: a unit test asserts the installer choice, and `tests/e2e/sandbox.test.ts` re-runs `/maint-updates-check` after an update and requires it to report `0 updates available`. That e2e assertion is the regression test for this.

---

## Versioning

Bump with the bundled skill:

```bash
bash .agents/skills/bump-version/scripts/bump-version.sh            # status only
bash .agents/skills/bump-version/scripts/bump-version.sh --patch    # 0.1.0 -> 0.1.1
bash .agents/skills/bump-version/scripts/bump-version.sh --minor
bash .agents/skills/bump-version/scripts/bump-version.sh --major
bash .agents/skills/bump-version/scripts/bump-version.sh --tag      # annotated git tag at HEAD
```

It edits `package.json` only. It does **not** commit — commit the change yourself, then tag.

---

## Publish to npm (becomes available on pi.dev/packages automatically)

Prereqs:
1. `npm login`
2. `peerDependencies["@earendil-works/pi-coding-agent"]` is `"*"` (host packages must be `*` per Pi docs).
3. `package.json` declares `"keywords": ["pi-package"]`.

Flow — the full playbook with failure modes is in the `release` skill:

```bash
bash .agents/skills/host-version/scripts/check-host-versions.sh   # CI pins still current?
bash .agents/skills/bump-version/scripts/bump-version.sh --minor
npm publish --access public
```

**There is no `.npmignore`.** `npm pack` falls back to `.gitignore`, which does not exclude `.agents/` or `.github/`, so skills, workflows and `bun.lock` currently ship in the tarball. Adding one is the cheap fix; `tests/` stays in, so downstream contributors can run `bun test` immediately.

Smoke test the install:

```bash
pi install npm:maintain-plugins
pi list
```

---

## Contributing

PRs welcome. Keep tests green; add a unit test for any new domain logic; add an e2e test only when exercising a host integration.

## License

MIT
