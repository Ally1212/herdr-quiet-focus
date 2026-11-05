#!/bin/sh
set -eu
CONFIG_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$CONFIG_DIR/layouts" "$CONFIG_DIR/mods"
cp "$ROOT/layouts/main-quiet-focus.json" "$CONFIG_DIR/layouts/"
for dir in "$ROOT"/mods/*; do
  name=$(basename "$dir")
  mkdir -p "$CONFIG_DIR/mods/$name"
  cp "$dir"/* "$CONFIG_DIR/mods/$name/"
done
printf '%s\n' "Installed Herdr Quiet Focus."
printf '%s\n' "Switch with: herdr-app do layout.switch '{\"name\":\"main-quiet-focus\"}'"
printf '%s\n' "Then check with: herdr-app status"
