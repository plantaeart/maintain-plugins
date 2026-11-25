---
name: screenshots
description: Use when the README screenshots or demo GIFs are out of date or a change touches what the user sees (session-start notice, /maint-updates-check report, update confirmation and restart dialogs, uninstall picker) - shots.sh drives a real omp TUI in tmux inside a sandbox HOME and renders each screen to a PNG in assets/imgs; gifs.sh records scripted scenes to GIFs in assets/gifs. omp only; use sandbox-test for manual testing, this skill for pictures.
---

# screenshots

Takes README screenshots of the real omp TUI running the working-tree extension. Sandbox `HOME` only, so no personal paths or plugins end up in a picture. No model or login is needed.

**Needs network.** The sandbox pins each stale plugin one release behind npm and the extension asks the live registry, so the versions in the pictures move with npm. `/maint-update-all` runs a real `omp plugin install` inside the sandbox.

## Run

```bash
bash .agents/skills/screenshots/scripts/shots.sh --list              # shot names
bash .agents/skills/screenshots/scripts/shots.sh                     # all shots -> assets/imgs/<name>.png
bash .agents/skills/screenshots/scripts/shots.sh notice check        # only these
MP_SHOTS_OUT=/tmp/try bash .agents/skills/screenshots/scripts/shots.sh notice   # other output dir
```

Needs `tmux`, `omp`, `jq`, `npm` and `python3` with Pillow on PATH (and `ffmpeg` for GIFs). Inside `nix develop`/direnv Pillow is there; for an editor language server (basedpyright) or plain Python create the venv `pyrightconfig.json` points at: `uv venv .venv && uv pip install --python .venv/bin/python pillow` (gitignored). Fonts (Fira Code, Symbols Nerd Font, Noto Sans Mono, Symbola) and the Twemoji bitmap font are read from `/usr/share/fonts`; Pillow cannot draw the COLRv1 Noto Color Emoji, hence Twemoji.

**Always open every PNG afterwards** and look for clipped text, missing glyphs, personal paths and wrong state. A shot that did not reach its screen fails with the last lines of the pane.

## How it works

1. `fresh` (`common.sh`) resets the sandbox (`/tmp/mp-shots`, refuses any other prefix: it runs `rm -rf`) with `setupVersion: 3` (skips omp's first-run wizard; a newer omp may need a higher number), a credential-free `models.yml`, the plugin manifest, lockfile and stub `node_modules` that discovery reads, and a saved one-exchange session.
2. The seeded plugins are `STALE_PKGS` (pinned at the second-newest npm version) and `CURRENT_PKGS` (newest). Pick packages that install **and load** under omp: `omp-activities` and `@nickf93/omp-automode` failed with "cannot load it on omp" during a real update. This plugin itself is not seeded (it is loaded from the working tree with `-e`), so no self-update detour.
3. `launch` starts `omp --continue -e <repo>/extensions/index.ts` with `PI_*`/`OMP_*` removed. `--continue` plus the saved session matters: omp declines the in-place restart for an unsaved session, so without it `Restart now?` never appears.
4. `snap <name> <wait-regex> <from-regex>` waits for the screen, captures `tmux capture-pane -e`, and `render-ansi.py` draws it (SGR colours, wide glyphs, emoji, cursor, window chrome). `<from-regex>` hides omp's splash above the first matching line.

## Add or change a shot

Add `shot_<name>() { fresh; launch "$S/proj"; <keys>; snap <name> "<wait>" "<from>"; }` to `scripts/shots.sh` (underscores in the function are dashes in the file and on the command line). Helpers: `slash "<cmd>"`, `key <tmux keys>`, `say "<text>"`, `await "<regex>"`.

## Shots

| Name | Shows |
|---|---|
| `notice` | session-start notice above the input, friendly text typed |
| `check` | `/maint-updates-check` report |
| `update-confirm` | `/maint-update-all` confirmation with every delta |
| `update-restart` | `Restart now?` dialog after the update |
| `uninstall-pick` | `/maint-uninstall-plugin` picker |
| `uninstall-confirm` | removal confirmation |
| `uninstall-done` | `Removed <plugin>` result |

## Demo GIFs: `gifs.sh`

```bash
bash .agents/skills/screenshots/scripts/gifs.sh --list     # gif names (same as the README file names)
bash .agents/skills/screenshots/scripts/gifs.sh            # all -> assets/gifs/<name>.gif
bash .agents/skills/screenshots/scripts/gifs.sh check      # only this one
MP_GIFS_OUT=/tmp/try MP_GIF_WIDTH=720 bash .agents/skills/screenshots/scripts/gifs.sh check
```

Not a screen recorder: a scene types the keys, and `frame <seconds>` grabs the pane after each step. Each capture is rendered by `render-ansi.py --fixed 100x30` (whole pane, same size every frame) and `ffmpeg` joins them with the given hold times into a palette GIF (12 fps, 900 px wide). A scene whose `await`/`launch` failed does not overwrite the committed GIF.

Add a scene: `gif_<name>() { fresh; start_omp "$S/proj"; rec_start; frame 1; ...; rec_end <name>; }` to `scripts/gifs.sh`. Helpers on top of the shot ones: `typed "<text>"` (one frame per character), `slash_typed "/maint-x"` (types, Enter), `press <keys>` (`HOLD=<s>` to hold longer), `frame <s>`. Scenes: `check`, `update`, `uninstall`. Look at several frames of each GIF afterwards: `ffmpeg -i x.gif -vf "fps=1/2,scale=450:-1,tile=3x3" -frames:v 1 sheet.png`.

## Rules

- Output goes to `assets/imgs/` and `assets/gifs/` by default and overwrites the committed files: review before committing. Both are in `.npmignore`; the README links them by GitHub raw URL.
- GitHub's README image proxy caches by URL: after replacing a GIF under the same name, bump `?v=<version>` on its README URL.
- Never point it at the real `~/.omp`: the sandbox sets its own `HOME` (see `sandbox-test` for why `--profile` is not isolation).
- The renderer is a Pillow script, not a terminal: if omp starts drawing a new glyph, add it to `render-ansi.py` rather than editing a PNG by hand. Keep it at 0 errors in basedpyright and clean in ruff.
