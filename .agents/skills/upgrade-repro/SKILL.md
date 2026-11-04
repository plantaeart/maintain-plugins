---
name: upgrade-repro
description: Use when a plugin upgrade fails or reports success without changing the version, and you need to reproduce it headlessly - really installs an old version of system-prompt-switch into a throwaway HOME, runs the extension's real upgrade code against it, and reports before/after. Can force an older bun on PATH to reproduce runtime-version failures.
---

# upgrade-repro

Reproduces `/maint-update-all` end to end without a TUI and without touching
`~/.omp` or `~/.pi`.

Difference from `sandbox-test`: that skill seeds stub manifests and drives a
host over rpc. This one installs the old version **for real** with the host's
own installer, then calls the extension's `discoverPlugins`, `checkVersions`
and `applyUpdates` directly, so the actual `omp plugin install` /
`npm install` subprocess runs.

## Commands

```bash
S=.agents/skills/upgrade-repro/scripts/upgrade-repro.sh
bash $S run                       # seed an old version, then upgrade it
bash $S seed --pin 0.12.0         # only seed (default pin: second-newest release)
bash $S upgrade                   # only upgrade (re-run after a fix)
bash $S upgrade --bun-dir DIR     # force another bun first on PATH
bash $S run --host pi
bash $S clean
```

The sandbox lives in `/tmp/opencode/upgrade-repro`; `clean` refuses any other path.

## Output

`before` lines show installed vs latest, `install` lines the subprocess being
run, `after` lines what discovery reads from disk. The last line is `RESULT`:

| Exit | Meaning |
|---|---|
| 0 | `OK`, version on disk now equals latest |
| 1 | `FAILED`, the host installer failed; the error text is printed |
| 2 | `NOT UPGRADED`, installer exited 0 but the version on disk did not move |

## Reproducing the bun runtime failure

omp 18.16.0 aborts with `Bun runtime must be >= 1.4.4` when an older `bun` is
first on `PATH` (for example a stale Nix devshell). To reproduce, point
`--bun-dir` at the bin directory of a bun older than 1.4.4 and run
`bash $S run --bun-dir <dir>`.

## Known finding: upgrading to system-prompt-switch 0.13.0

`bash $S run --pin 0.12.0` exits 1: `omp plugin install system-prompt-switch@0.13.0`
reloads the new extension in the CLI process, and 0.13.0's
`promptOnStartupFromConfig` throws `Settings not initialized`. omp has already
written `node_modules` (0.13.0) but exits non-zero before updating
`omp-plugins.lock.json`, and maintain-plugins then rolls the manifest back.
Installing other plugins, or 0.12.0, exits 0.
