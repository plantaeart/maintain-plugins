---
name: unit-test
description: Use when writing or changing a test in this repo - TDD order, port injection instead of a mocking library, the sandbox registry that stops a test leaking into the real plugin dir, awaiting the real signal instead of sleeping, driving a real host over --mode rpc, and enum usage.
---

# unit-test

How to add tests to this repo. Read this before writing or changing a test — the conventions here are specific and several of them prevent real damage to the user's prompt library.

## TDD order (required)

1. Write the failing test first. Run it. Confirm it fails **for the reason you expect**, not a syntax error.
2. Implement the minimum code to pass.
3. Run the whole suite. It must stay green.

Never write the implementation first and back-fill a test.

## Layout

```
tests/
  unit/                 domain tests, no host, no network — milliseconds each
  e2e/                  real host CLI driven over --mode rpc, in a sandbox HOME
  helpers/
    test-sandbox-registry.ts  register / sweep / cleanup for sandbox dirs
    global-setup.ts           sweep on start, cleanup on exit
```

`bunfig.toml` preloads `global-setup.ts` into every `bun test`.

Choose by what you are testing:
- Pure functions (`paths`, `plugin-record`, `version-check`, `updater`) → `tests/unit/`, no mocks needed.
- Anything using `RegistryLookup` / `RunCommand` / the cache pair → `tests/unit/`, inject the hand-written stubs (below).
- The real extension in a real host → `tests/e2e/`, which spawns the binary.

There is no `tests/fixtures/` directory here. This extension writes no user content, so there is no equivalent of the sibling repo's prompt-name enum; a test that creates a sandbox registers the directory instead.

## Commands

```bash
bun test                              # everything
bun test tests/unit/updater.test.ts
bun test -t "leaves the manifest alone"  # single test by name
bun run typecheck && bun run lint     # both must be clean
```

## Mocking: inject through the ports

The domain never imports an adapter, so unit tests pass their own functions. There is no mocking library.

```ts
// src/ports/registry.port.ts — no network in a unit test
const lookup: RegistryLookup = async (name) => (name === "stale" ? "2.0.0" : undefined);

// src/ports/process.port.ts — no real process either
const seen: string[] = [];
const run: RunCommand = async (command, options) => {
	seen.push(command);
	seen.push(options?.cwd ?? "");
	return { code: 0 };
};

await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
	pluginDirs: new Map([[HostPlatform.Omp, dir]]),
	run,
});
```

For a run that must fail, return a non-zero code rather than making something throw — `RunCommand` never rejects by contract, and `applyUpdates` treats a throw as a bug rather than a failed install:

```ts
run: async () => ({ code: 1, stderr: "network down" }),
```

Capture the command string and the `cwd` when the *choice of installer* is what the test is about; that is how the omp-lockfile regression is pinned.

## Sandboxes: always the registry

…

```ts
import { registerTestSandbox } from "../helpers/test-sandbox-registry";

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "maint-test-"));
	registerTestSandbox(dir);
});
```

`tests/helpers/global-setup.ts` runs on every suite (via `bunfig.toml` preload) and **removes every registered directory on exit, pass or fail**, plus sweeps `/tmp/maint-e2e-*` leftovers from a crashed run. Verified: a test that fails mid-run still has its directory removed.

It deliberately does **not** delete `~/.omp/sandbox-maint` or `~/.pi/sandbox-maint`. Those can be hundreds of megabytes of host natives, but they are also what a human may be testing by hand in another terminal; they are reported, and `sandbox-test.sh remove` is the deliberate delete.

## When you need the real filesystem

Point a `home` argument at a temp dir. Every function that touches disk takes `home` explicitly — `discoverPlugins(host, home)`, `pluginDirFor(host, home)`, `cachePathFor(host, home)` — so there is no adapter to configure and no way to accidentally fall back to the real home:

```ts
tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maint-test-"));
registerTestSandbox(tmp);

const dir = path.join(tmp, ".omp", "plugins");
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ … }));

const records = await discoverPlugins(HostPlatform.Omp, tmp);
```

**Never point a test at `~/.omp` or `~/.pi`.** That is the one mistake this repo cannot recover from: a test writing there edits the user's real plugin manifest, which is the file `/maint-update-all` rewrites. `tests/e2e/sandbox.test.ts` shows the full pattern — it overrides `HOME` on the spawned host process.

`afterEach` can still remove the tree directly for a test that wants to assert on it afterwards; the registry is the backstop, not a replacement:

```ts
afterEach(async () => {
	try { await fs.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
```

## Async: await the signal, never a timer

The extension detaches work (`void records().then(…)`), so a test must wait for the thing it actually produced — not sleep.

```ts
// wrong
await new Promise((r) => setTimeout(r, 10));

// right: wait for the real signal
const asked = Promise.withResolvers<void>();
// ... resolve() when the callback fires
await asked.promise;
```

Use `Promise.withResolvers()`, never `new Promise((resolve) => …)` with nested callbacks. The e2e suite has a frame-matching helper for this: a host command is awaited by the `extension_ui_request` frame it produces, not by a delay. A timeout is a deadlock guard there, not synchronisation.

## Enums, not string literals

`HostPlatform`, `ExtensionCommand` and `ExtensionEventType` are enums. Use the members, not the raw strings:

```ts
host: HostPlatform.Omp    // not "omp"
```

A raw string still compiles in a test fixture, which is exactly how a wrong host label survives for so long. When a test needs a value that is *deliberately* off-type — persisted JSON from an older version — cast it explicitly and say why in a comment.

## Assertions

- Assert the behaviour a user or caller depends on, not the implementation. `expect(result.ok).toBe(false)` beats asserting on a private field.
- Prefer `toContain` for assembled strings. Reserve `toBe` for an exact whole-value contract.
- Negative assertions matter: `expect(recheck).not.toContain("0.9.5 ->")` is what pins the omp-lockfile fix, because the bug was a re-check that still reported the old version.
- One behaviour per `it`. The name states the behaviour, not the method: `"leaves the manifest byte-identical when the install fails"`, not `"testRollback"`.
- When you fix a bug, add the regression test **and** verify it fails without the fix (revert the source change, watch it fail, restore). A test that never went red proves nothing.

## Typecheck and lint are part of the test

`bun test` does not typecheck. A test with a signature mismatch against a port passes at runtime and breaks the build:

```ts
bun run typecheck   # must be clean
bun run lint        # must be clean
```

Run `bun run ci` before declaring work done — it is the full pipeline, including skill validation. See the `ci-check` skill.

## Debugging a flaky e2e failure

The failure message from `tests/e2e/sandbox.test.ts` carries the host's stderr and every notification seen so far, so the usual answer is in the failure itself rather than in a log file:

```
timed out waiting for the progress widget. stderr: ...
```

Common causes, in the order they have actually happened here:

| Symptom | Cause |
|---|---|
| `timed out waiting for registration of …` | the host printed `Unknown option: --no-rules` — pi has no such flag |
| `No models available. Use /login` | the sandbox `models.yml` was edited or lost; re-run `sandbox-test.sh init` |
| report shows the version just installed | `HOME` was not overridden on the spawned process, so discovery read the real profile |
| a cached answer came back instead of the new one | use `uncachedNotify()` for a query asked twice |

This extension writes **no log file**; `logPathFor()` exists in `src/core/paths.ts` but nothing calls it.

## Do not

- Do not use a real host clock or timers to make an async test pass.
- Do not create a directory on disk without registering it.
- Do not point a test at `~/.omp` or `~/.pi`, and do not spawn a host without overriding `HOME`.
- Do not delete a test to make a suite green. If a test encodes wrong behaviour, fix the behaviour and say so.
- Do not weaken an assertion just to pass. Change the assertion only when the requirement genuinely changed.
