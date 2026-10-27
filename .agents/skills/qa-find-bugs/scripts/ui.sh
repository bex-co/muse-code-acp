#!/usr/bin/env bash
# GUI helpers for the Bex pass. Coordinates are in screenshot space: the Bex
# window is pinned at (X0,Y0) with size W×H points, and screenshots are scaled
# to W pixels wide, so a point read off a screenshot is (x, y) here.
#
#   ui.sh pin                      bring Bex to the front and pin its window
#   ui.sh shot NAME [delay]        screenshot the window to $QA_DIR/gui/NAME.png
#   ui.sh click X Y                real mouse click (GPUI ignores AX clicks)
#   ui.sh paste "text"             type via the clipboard (IME-safe), restoring it
#   ui.sh key CHAR "mods"          e.g. ui.sh key p "command down, shift down"
#   ui.sh code N ["mods"]          key code (36 return, 53 escape, 125 down)
#   ui.sh palette "action"         run a Bex command-palette action
#   ui.sh running                  exit 0 when Bex is running
#   ui.sh quit                     quit Bex
#
# Every input action first checks that Bex is frontmost and aborts otherwise,
# so keystrokes can never land in another app the user is working in.
set -euo pipefail
QA_DIR=${QA_DIR:?set QA_DIR}
X0=${UI_X0:-100} Y0=${UI_Y0:-100} W=${UI_W:-1600} H=${UI_H:-1100}
PROC=bex
mkdir -p "$QA_DIR/gui"

front() { osascript -e "tell application \"System Events\" to tell process \"$PROC\" to set frontmost to true" >/dev/null; }
guard() {
  front
  sleep 0.15
  local f
  f=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')
  if [ "$f" != "$PROC" ]; then
    echo "ui.sh: '$f' is frontmost, not Bex; refusing to send input" >&2
    exit 3
  fi
}
pin() {
  front
  osascript -e "tell application \"System Events\" to tell process \"$PROC\" to set position of window 1 to {$X0, $Y0}" \
    -e "tell application \"System Events\" to tell process \"$PROC\" to set size of window 1 to {$W, $H}" >/dev/null
}

case "${1:-}" in
  pin) pin ;;
  shot)
    sleep "${3:-1}"
    screencapture -x -R"$X0,$Y0,$W,$H" "$QA_DIR/gui/$2.png"
    sips -Z "$W" "$QA_DIR/gui/$2.png" --out "$QA_DIR/gui/$2.png" >/dev/null
    echo "$QA_DIR/gui/$2.png"
    ;;
  click) pin; guard; cliclick "c:$((X0 + $2)),$((Y0 + $3))" ;;
  paste)
    guard
    saved=$(mktemp)
    pbpaste >"$saved" 2>/dev/null || true
    printf '%s' "$2" | pbcopy
    osascript -e 'tell application "System Events" to keystroke "v" using {command down}'
    sleep 0.3
    pbcopy <"$saved"
    rm -f "$saved"
    ;;
  key) guard; osascript -e "tell application \"System Events\" to keystroke \"$2\" using {$3}" ;;
  code)
    guard
    if [ -n "${3:-}" ]; then
      osascript -e "tell application \"System Events\" to key code $2 using {$3}"
    else
      osascript -e "tell application \"System Events\" to key code $2"
    fi
    ;;
  palette)
    "$0" key p "command down, shift down"
    sleep 0.5
    "$0" paste "$2"
    sleep 0.5
    "$0" code 36
    ;;
  running) pgrep -f "/Applications/Bex.app/Contents/MacOS" >/dev/null ;;
  quit) osascript -e 'tell application "Bex" to quit' >/dev/null 2>&1 || true ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
