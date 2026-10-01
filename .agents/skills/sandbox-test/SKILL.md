---
name: sandbox-test
description: Use when testing maintain-plugins by hand, or when writing an e2e test that drives a real Pi or OMP host - seeds a throwaway HOME with a deliberately stale plugin, prints the command to launch it, and removes it safely. `--profile` does not isolate this extension, so HOME is the only lever that works.
---

# sandbox-test

Test this extension against a real host without touching the real one.

`/maint-update-all` rewrites the host's plugin manifest. That file is also what
every real plugin install reads, so testing against the live profile risks
breaking a working setup to check a feature that only writes version numbers.

## Why `--profile` does not work here

`omp --profile <name>` isolates the host. It does not isolate this extension:

```bash
omp --profile test plugin doctor --json   # -> ~/.omp/profiles/test/plugins
# in the same session, the extension reports:
#   pluginDir = ~/.omp/plugins              <- the default profile
```

`pluginDirFor()` and `cachePathFor()` in `src/core/paths.ts` build their paths
from `os.homedir()` plus `.omp/plugins` and never read `OMP_PROFILE`. A session
run with `--profile test` therefore discovers the default profile's plugins and
rewrites the **real** manifest. Pi has no `--profile` flag at all.

`omp plugin link .` is not an alternative either: it writes the real
`~/.omp/plugins/package.json`, which is the file under test.

`HOME` is the lever that works for both hosts. The extension reads
`os.homedir()`, so redirecting it moves both the directory it reads and the
directory it rewrites.

## The three commands

```bash
bash .agents/skills/sandbox-test/scripts/sandbox-test.sh init
bash .agents/skills/sandbox-test/scripts/sandbox-test.sh use
bash .agents/skills/sandbox-test/scripts/sandbox-test.sh remove
```

### init

Seeds `~/.omp/sandbox-maint` (or `~/.pi/sandbox-maint`) with:

- a credential-free `models.yml`, so no API key is copied into a throwaway
  directory and no model call is ever made,
- a plugin manifest pinned to a **stale** version,
- a digest of the real plugin manifest, used as the guard on `remove`.

It prints what it seeded, the npm latest version for comparison, and the digest
it recorded.

`init` is idempotent - it removes and recreates the sandbox - so **init is also
the reset**. After a successful update, run `init` again to get the stale state
back.

### use

Prints the launch command. It does not exec it, so the command stays editable:

```
HOME="/home/you/.omp/sandbox-maint" omp --no-session --no-skills --no-rules -e /path/to/extensions/index.ts
```

pi has no `--no-rules`, so its line drops that flag. The script knows which is
which — do not copy one host's flags to the other.

Inside that session:

| Command | Expected |
|---|---|
| (session start) | `1 plugin update(s) available - run /maint-updates-check to review` |
| `/maint-updates-check` | `omp plugins (1 installed, 1 update available)` and the `pkg: <pin> -> <latest>` line |
| `/maint-update-all` | confirm dialog naming each delta, then `Updated 1 plugin(s)` |

To check what the sandbox resolved:

```bash
HOME="$HOME/.omp/sandbox-maint" omp plugin list   # omp
HOME="$HOME/.pi/sandbox-maint"  pi list           # pi (not `pi plugin list`)
```

### remove

Deletes the sandbox. Two guards, because this is the only irreversible step:

1. the path must be under `~/.omp/` or `~/.pi/` **and** contain `sandbox`,
2. the real plugin manifest must still match the digest `init` recorded.

If either fails it refuses and explains. The second guard is the useful one: if
the real manifest changed since `init`, something ran outside the sandbox, and
deleting the evidence is the wrong move.

## The fixture is your own plugin

The default is `system-prompt-switch`, this repo's sibling, pinned to the
**second-newest published version**. Publishing a release makes the sandbox
stale again without editing the script, so the fixture cannot silently go
current.

Never test against a plugin you do not control: a third-party release would
change what the sandbox reports, and a bug report would be ambiguous.

Override with `--package <name>` and, if you must pin a literal, `--pin <version>`.
`--pin` is also the offline path when `npm view` cannot reach the registry.

```bash
sandbox-test.sh init --host pi
sandbox-test.sh init --path /tmp/maint-scratch --pin 0.9.5
```

## Hosts differ in what discovery reads

| Host | Reads the stale version from | Needs a real install? |
|---|---|---|
| OMP | `package.json` + `omp-plugins.lock.json` | no |
| Pi | `node_modules/<pkg>/package.json` | no - a stub manifest is seeded, because a package listed in settings with no manifest is treated as not installed |

Neither needs `pi install` or `omp plugin install`. The old version is installed
*during* the test, by `/maint-update-all` itself, which is the code under test.

## Cost

The first launch in a fresh sandbox downloads the host's native modules into
`$SANDBOX/.omp/natives` - about 360M, a few seconds. The seed itself is under
1M. A warm sandbox starts instantly; this is the main reason the e2e suite
reuses one sandbox rather than building a fresh `HOME` per test.

## For e2e tests

`tests/e2e/sandbox.test.ts` drives the host the same way, in `--mode rpc`
instead of a TUI: it writes commands to the host's stdin and reads
`extension_ui_request` frames from stdout. That is what lets a test answer the
`/maint-update-all` confirmation without a human.

```bash
bun test tests/e2e/sandbox.test.ts
```

The tests skip with a printed reason when the host CLI is not on `PATH`, so a
contributor without `omp` and `pi` is not blocked.
