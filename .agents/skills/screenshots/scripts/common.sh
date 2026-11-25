#!/usr/bin/env bash
# Shared by shots.sh and gifs.sh (source it): real omp in tmux inside a sandbox HOME, never touches ~/.omp.
# The caller sets MP_COLS / MP_ROWS (pane size) before sourcing. Needs network: versions come from npm.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="${MP_SANDBOX:-/tmp/mp-shots}"
HOST=omp ENTRY=extensions/index.ts T=mp-shots
FAILS=0
# reset_sandbox runs rm -rf on $S: never accept a path outside /tmp.
case "$S" in /tmp/?*) ;; *) echo "MP_SANDBOX must be a directory under /tmp (got: $S)"; exit 2 ;; esac

command -v tmux >/dev/null && command -v omp >/dev/null && command -v jq >/dev/null && command -v npm >/dev/null \
	&& python3 -c "import PIL" 2>/dev/null || { echo "need tmux, omp, jq, npm and python3 Pillow"; exit 2; }

# Friendly text typed into the visible input area (never submitted, so no model call).
HELLO="Nice, my plugins are all up to date now ! 🎉"

# Plugins seeded into the sandbox: STALE ones are pinned one release behind npm, CURRENT ones at the newest version.
STALE_PKGS=(system-prompt-switch omp-llm-role)
CURRENT_PKGS=(omp-axonhub)
PINS="$(mktemp /tmp/mp-pins.XXXXXX)" # "<name> <version>" lines, resolved once per run
# Ctrl+C or a crash must not leave the tmux session, a half-written frame directory (W, set by gifs.sh) or PINS behind.
trap 'tmux kill-session -t $T 2>/dev/null; [ -n "${W:-}" ] && rm -rf "$W"; rm -f "$PINS"' EXIT
for p in "${STALE_PKGS[@]}"; do
	v="$(npm view "$p" versions --json | jq -r '.[-2]')"; [ -n "$v" ] && [ "$v" != null ] || { echo "no npm versions for $p"; exit 2; }
	echo "$p $v" >> "$PINS"
done
for p in "${CURRENT_PKGS[@]}"; do
	v="$(npm view "$p" version)"; [ -n "$v" ] || { echo "no npm version for $p"; exit 2; }
	echo "$p $v" >> "$PINS"
done

# reset_sandbox: omp HOME with the plugin manifest, lockfile and stub node_modules the extension's discovery reads.
reset_sandbox() {
	tmux kill-session -t $T 2>/dev/null
	# A just-killed omp still writes its input draft and history on the way out: wait for it, or it lands in the next sandbox.
	for _ in $(seq 20); do pgrep -f -- "--continue -e $REPO/$ENTRY" >/dev/null || break; sleep 0.25; done
	rm -rf "$S"
	mkdir -p "$S/home/.omp/agent" "$S/home/.omp/plugins" "$S/proj"
	echo "setupVersion: 3" > "$S/home/.omp/agent/config.yml" # skips the first-run wizard
	# Without a declared model omp exits with "No models available" before the extension loads.
	cat > "$S/home/.omp/agent/models.yml" <<'YML'
providers:
  - id: sandbox
    name: Sandbox
    api: openai-completions
    baseUrl: https://api.openai.com/v1
    auth: none
    models:
      - id: sandbox-model
        name: Sandbox Model
YML
	# A saved conversation on disk: omp only offers `Restart now?` when the session can be resumed (launch passes --continue).
	local sd="$S/home/.omp/agent/sessions/${S//\//-}-proj" ts=2026-01-01T00:00:00.000Z
	mkdir -p "$sd"
	{
		printf '{"type":"session","version":3,"id":"01a18ed9-853c-77c7-832e-ecc7cb3655f1","timestamp":"%s","cwd":"%s"}\n' "$ts" "$S/proj"
		printf '{"type":"message","id":"aa000001","parentId":null,"timestamp":"%s","message":{"role":"user","content":[{"type":"text","text":"Hi!"}],"attribution":"user","timestamp":1767225600000}}\n' "$ts"
		printf '{"type":"message","id":"aa000002","parentId":"aa000001","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help?"}],"api":"openai-completions","provider":"0","model":"sandbox-model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1767225601000}}\n' "$ts"
	} > "$sd/2026-01-01T00-00-00-000Z_01a18ed9-853c-77c7-832e-ecc7cb3655f1.jsonl"
	local d="$S/home/.omp/plugins" name ver
	jq -Rn '[inputs|split(" ")] as $p | {name:"omp-plugins",private:true,dependencies:($p|map({(.[0]):("npm:"+.[0]+"@"+.[1])})|add)}' "$PINS" > "$d/package.json"
	jq -Rn '[inputs|split(" ")] as $p | {plugins:($p|map({(.[0]):{version:.[1],enabledFeatures:null,enabled:true}})|add),settings:{}}' "$PINS" > "$d/omp-plugins.lock.json"
	while read -r name ver; do # discovery ignores a lock entry with nothing in node_modules
		mkdir -p "$d/node_modules/$name"
		printf '{"name":"%s","version":"%s"}\n' "$name" "$ver" > "$d/node_modules/$name/package.json"
	done < "$PINS"
}
fresh() { reset_sandbox; }

# launch <cwd>: starts omp with the working-tree extension, waits until the stale-plugin notice shows.
# PI_*/OMP_* are removed so a run from inside an agent session cannot leak its session into the host.
launch() {
	tmux kill-session -t $T 2>/dev/null
	local unset_env; unset_env=$(env | grep -oE '^(PI|OMP)_[A-Za-z0-9_]*' | sed 's/^/-u /' | tr '\n' ' ')
	tmux new-session -d -s $T -x "${MP_COLS:-110}" -y "${MP_ROWS:-40}" -c "$1" "env $unset_env HOME=$S/home $HOST --continue -e $REPO/$ENTRY"
	for _ in $(seq 60); do sleep 0.5; screen | grep -qE "plugin updates? available" && return 0; done
	echo "timeout waiting for startup"; screen; return 1
}
screen() { tmux capture-pane -t $T -p; }
settle() { sleep 1.5; }
slash() { tmux send-keys -t $T "$1" Enter; settle; }
await() { # await <regex> [half-seconds=40]: wait for the screen to match (the registry is asked live)
	for _ in $(seq "${2:-40}"); do screen | grep -qE "$1" && return 0; sleep 0.5; done
	echo "  FAIL waiting for: $1"; screen | grep -v '^\s*$' | tail -15; FAILS=$((FAILS+1)); return 1
}
say() { tmux send-keys -t $T -l "$1"; sleep 0.5; }
key() { tmux send-keys -t $T "$@"; sleep 0.4; }
# cursor_arg <ansi-file>: prints "x,y" when the real cursor sits on omp's input line, nothing otherwise.
# omp parks the real cursor in odd places while a dialog is open: only the input line (starts with ╰─, no ╯:
# a boxed dialog also ends with ╰─) is trustworthy.
cursor_arg() {
	local cx cy; read -r cx cy <<< "$(tmux display -p -t $T '#{cursor_x} #{cursor_y}')"
	sed -n "$((cy+1))p" "$1" | sed 's/\x1b\[[0-9;]*m//g' | grep '^╰─' | grep -vq '╯' && echo "$cx,$cy"
}
