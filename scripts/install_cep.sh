#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_NAME="com.hermesagent.premierevideoeditor.cep"
TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
TARGET_PATH="$TARGET_DIR/$EXT_NAME"

mkdir -p "$TARGET_DIR"
rm -rf "$TARGET_PATH"
ln -s "$ROOT/cep-extension" "$TARGET_PATH"

echo "CEP extension linked to:"
echo "  $TARGET_PATH"
echo
echo "Restart Premiere Pro and open:"
echo "  Window -> Extensions (Legacy) -> HERMES"
