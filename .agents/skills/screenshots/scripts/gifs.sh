#!/usr/bin/env bash
# README demo GIFs of the REAL omp TUI: scripted keys, one tmux capture per step, rendered to PNG frames, joined by ffmpeg.
# Usage: gifs.sh [--list] [gif-name...]   (default: all)   env: MP_GIFS_OUT=<dir> (default assets/gifs), MP_GIF_WIDTH=900
MP_COLS=100 MP_ROWS=30
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
export LC_ALL="${LC_ALL:-C.UTF-8}" # ${s:i:1} must split by character, not by byte
[ "$(printf 'é' | wc -m)" = 1 ] || { echo "need a UTF-8 locale (set LC_ALL)"; exit 2; }
OUT="${MP_GIFS_OUT:-$REPO/assets/gifs}"
WIDTH="${MP_GIF_WIDTH:-900}"
command -v ffmpeg >/dev/null || { echo "need ffmpeg"; exit 2; }
mkdir -p "$OUT"

# Recording: frame <seconds> grabs the pane now and shows it for <seconds>; rec_end renders all frames and joins them.
W=""; SCENE_FAILS=0
rec_start() { W="$(mktemp -d /tmp/mp-gif.XXXXXX)"; N=0; }
frame() {
	N=$((N+1)); local id; id="$(printf %04d "$N")"
	tmux capture-pane -t $T -e -p > "$W/$id.ansi"
	cursor_arg "$W/$id.ansi" > "$W/$id.cur"
	echo "$1" > "$W/$id.dur"
}
# rec_end <name>: ansi -> png (fixed grid, same size every frame) -> ffmpeg palette gif
rec_end() {
	local a id cur last="" ok=1
	# a step that never reached its screen (await/launch bumped FAILS) must not overwrite the committed GIF
	if [ "$FAILS" != "$SCENE_FAILS" ]; then echo "  FAIL gif: $1 (a step did not reach its screen, file left as is)"; rm -rf "$W"; return; fi
	: > "$W/list.txt"
	for a in "$W"/*.ansi; do
		id="$(basename "$a" .ansi)"; cur="$(cat "$W/$id.cur")"
		if ! python3 "$HERE/render-ansi.py" "$a" "$W/$id.png" --fixed "${MP_COLS}x${MP_ROWS}" --title omp ${cur:+--cursor "$cur"}; then ok=0; break; fi
		printf "file '%s'\nduration %s\n" "$W/$id.png" "$(cat "$W/$id.dur")" >> "$W/list.txt"; last="$W/$id.png"
	done
	[ -n "$last" ] && echo "file '$last'" >> "$W/list.txt" # concat demuxer ignores the last duration without a repeat
	if [ $ok = 1 ] && ffmpeg -v error -y -f concat -safe 0 -i "$W/list.txt" \
		-vf "fps=12,scale=$WIDTH:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 "$OUT/$1.gif"; then
		echo "  wrote $OUT/$1.gif ($N frames, $(du -h "$OUT/$1.gif" | cut -f1))"
	else
		echo "  FAIL gif: $1"; FAILS=$((FAILS+1))
	fi
	rm -rf "$W"
}
typed() { # typed <text>: one character at a time, a frame after each
	local s="$1" i
	for ((i=0; i<${#s}; i++)); do tmux send-keys -t $T -l "${s:i:1}"; sleep 0.1; frame 0.08; done
}
press() { key "$@"; frame "${HOLD:-0.5}"; } # press <tmux keys>: send, then a frame
slash_typed() { typed "$1"; frame 0.4; key Enter; sleep 1; } # a slash command typed like a user would
start_omp() { launch "$1" || FAILS=$((FAILS+1)); } # a failed start must fail the scene, not record an error screen

gif_check() {
	fresh; start_omp "$S/proj"; rec_start; frame 2.4
	slash_typed "/maint-updates-check"; await "plugins \([0-9]+ installed"; frame 4
	rec_end check
}
gif_update() {
	fresh; start_omp "$S/proj"; rec_start; frame 2
	slash_typed "/maint-update-all"; await "Update all plugins\?"; frame 3
	key Enter; await "Updating [0-9]"; frame 1.2
	await "Restart now\?" 160; frame 3.5
	rec_end update
}
gif_uninstall() {
	fresh; start_omp "$S/proj"; rec_start; frame 1.5
	slash_typed "/maint-uninstall-plugin"; await "Remove which plugin\?"; frame 1.5
	press Down; HOLD=1 press Down
	key Enter; await "Remove [^ ]+@"; frame 2.5
	key Enter; await "Removed "; frame 3
	rec_end uninstall
}

ALL=$(declare -F | sed -n 's/^declare -f gif_//p')
if [ "${1:-}" = "--list" ]; then echo "$ALL" | tr '_' '-'; exit 0; fi
GIFS=("$@"); [ ${#GIFS[@]} -eq 0 ] && GIFS=($(echo "$ALL" | tr '_' '-'))
for g in "${GIFS[@]}"; do
	fn="gif_${g//-/_}"
	declare -F "$fn" >/dev/null || { echo "unknown gif: $g (see --list)"; FAILS=$((FAILS+1)); continue; }
	echo "[$g]"; SCENE_FAILS=$FAILS; "$fn"
done
tmux kill-session -t $T 2>/dev/null
rm -rf "$S" 2>/dev/null || { sleep 1; rm -rf "$S"; }
[ $FAILS -eq 0 ] && echo "ALL OK" || { echo "$FAILS FAILED"; exit 1; }
