#!/usr/bin/env bash
# README screenshots of the REAL omp TUI running the working-tree extension, in a sandbox HOME (never touches ~/.omp).
# Usage: shots.sh [--list] [shot-name...]   (default: all shots)   env: MP_SHOTS_OUT=<dir> (default assets/imgs)
MP_COLS=110 MP_ROWS=40
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
OUT="${MP_SHOTS_OUT:-$REPO/assets/imgs}"
mkdir -p "$OUT"
# snap <name> <wait-regex> <from-regex> [await half-seconds]: wait for the screen, then render it from the first line matching <from-regex>.
snap() {
	await "$2" "${4:-40}" || return 1
	sleep 0.5
	local f cur; f="$(mktemp /tmp/mp-shots.XXXXXX)"
	tmux capture-pane -t $T -e -p > "$f"
	cur="$(cursor_arg "$f")"
	if python3 "$HERE/render-ansi.py" "$f" "$OUT/$1.png" --from "$3" --title "omp" ${cur:+--cursor "$cur"}; then
		echo "  wrote $OUT/$1.png"
	else
		echo "  FAIL render: $1"; FAILS=$((FAILS+1))
	fi
	rm -f "$f"
}
FROM_NOTICE="plugin updates? available"

shot_notice()            { fresh; launch "$S/proj"; say "$HELLO"; snap notice "plugin updates? available" "$FROM_NOTICE"; }
shot_check()             { fresh; launch "$S/proj"; slash "/maint-updates-check"; snap check "plugins \([0-9]+ installed" "plugins \("; }
shot_update_confirm()    { fresh; launch "$S/proj"; slash "/maint-update-all"; snap update-confirm "Update all plugins\?" "Update all plugins\?"; }
shot_update_restart()    { fresh; launch "$S/proj"; slash "/maint-update-all"; await "Update all plugins\?"; key Enter; snap update-restart "Restart now\?" "Updated [0-9]+ plugin|Restart now\?" 160; }
shot_uninstall_pick()    { fresh; launch "$S/proj"; slash "/maint-uninstall-plugin"; snap uninstall-pick "Remove which plugin\?" "Remove which plugin\?"; }
shot_uninstall_confirm() { fresh; launch "$S/proj"; slash "/maint-uninstall-plugin"; await "Remove which plugin\?"; key Enter; snap uninstall-confirm "Remove [^ ]+@" "Remove [^ ]+@"; }
shot_uninstall_done()    { fresh; launch "$S/proj"; slash "/maint-uninstall-plugin"; await "Remove which plugin\?"; key Enter; await "Remove [^ ]+@"; key Enter; snap uninstall-done "Removed " "Removed "; }

ALL=$(declare -F | sed -n 's/^declare -f shot_//p')
if [ "${1:-}" = "--list" ]; then echo "$ALL" | tr '_' '-'; exit 0; fi
SHOTS=("$@"); [ ${#SHOTS[@]} -eq 0 ] && SHOTS=($(echo "$ALL" | tr '_' '-'))
for s in "${SHOTS[@]}"; do
	fn="shot_${s//-/_}"
	declare -F "$fn" >/dev/null || { echo "unknown shot: $s (see --list)"; FAILS=$((FAILS+1)); continue; }
	echo "[$s]"; "$fn"
done
tmux kill-session -t $T 2>/dev/null
rm -rf "$S" 2>/dev/null || { sleep 1; rm -rf "$S"; }
[ $FAILS -eq 0 ] && echo "ALL OK" || { echo "$FAILS FAILED"; exit 1; }
