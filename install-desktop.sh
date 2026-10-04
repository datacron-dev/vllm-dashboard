#!/usr/bin/env bash
# Install vLLM Dashboard as a desktop application.
#
# This script:
#   1. Copies the built .AppImage to ~/.local/bin/vllm-dashboard.AppImage
#   2. Copies the vLLM-Playground SVG icon to ~/.local/share/icons/vllm-dashboard.svg
#   3. Writes a .desktop launcher to ~/.local/share/applications/vllm-dashboard.desktop
#   4. Creates a wrapper script at ~/.local/bin/vllm-dashboard for terminal access
#   5. Refreshes the desktop database (if available)
#
# Run AFTER `npm run build` has produced dist/vllm-dashboard-0.1.0-<arch>.AppImage.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$PROJECT_DIR/dist"
APPIMAGE="$DIST/vllm-dashboard-0.1.0-*.AppImage"
SOURCE_ICON="/home/ai-dev/.local/share/icons/vllm-Playground.svg"

DEST_BIN="$HOME/.local/bin"
DEST_ICON_DIR="$HOME/.local/share/icons"
DEST_APP_DIR="$HOME/.local/share/applications"
DEST_ICON="$DEST_ICON_DIR/vllm-dashboard.svg"
DEST_DESKTOP="$DEST_APP_DIR/vllm-dashboard.desktop"
STABLE_APPIMAGE="$DEST_BIN/vllm-dashboard.AppImage"
WRAPPER="$DEST_BIN/vllm-dashboard"

echo "==> Installing vLLM Dashboard"

# 1. Find and copy the AppImage
shopt -s nullglob
APPFILES=("$DIST"/vllm-dashboard-*.AppImage)
shopt -u nullglob
if [[ ${#APPFILES[@]} -eq 0 ]]; then
  echo "ERROR: No AppImage found in $DIST/. Run 'npm run build' first." >&2
  exit 1
fi
cp -f "${APPFILES[0]}" "$STABLE_APPIMAGE"
chmod +x "$STABLE_APPIMAGE"
echo "    AppImage -> $STABLE_APPIMAGE"

# 2. Icon (vLLM-Playground SVG)
if [[ -f "$SOURCE_ICON" ]]; then
  cp -f "$SOURCE_ICON" "$DEST_ICON"
  echo "    Icon     -> $DEST_ICON"
else
  echo "    WARNING: source icon $SOURCE_ICON not found; using AppImage's embedded icon." >&2
fi

# 3. .desktop launcher
# --no-sandbox: Electron's SUID chrome-sandbox helper is not root-owned inside
# an AppImage, so the launcher disables the sandbox explicitly. main.js also
# auto-detects and adds --no-sandbox at runtime, but having it here makes the
# desktop entry work even before the JS bootstrap runs.
# --disable-gpu --disable-software-rasterizer: the GPU process crashes on
# headless/SSH sessions (no usable GPU). main.js auto-detects this too, but
# baking it here makes the launcher reliable from the first click.
cat > "$DEST_DESKTOP" <<EOF
[Desktop Entry]
Name=vLLM Dashboard
Comment=Monitor a local vLLM server. Shows health, KV cache, throughput, prefix cache hit rate, and live logs.
Exec=$STABLE_APPIMAGE --no-sandbox --disable-gpu
Icon=$DEST_ICON
Terminal=false
Type=Application
Categories=Development;
StartupNotify=true
EOF
chmod +x "$DEST_DESKTOP"
echo "    Launcher -> $DEST_DESKTOP"

# 4. Wrapper script for terminal access
# Allows launching via the 'vllm-dashboard' command without typing the .AppImage suffix.
cat > "$WRAPPER" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/vllm-dashboard.AppImage" \
  --no-sandbox \
  --disable-gpu \
  "$@"
WRAPPER_EOF
chmod +x "$WRAPPER"
echo "    Wrapper -> $WRAPPER"

# 5. Refresh desktop database (best-effort)
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DEST_APP_DIR" 2>/dev/null || true
  echo "    Desktop DB refreshed."
else
  echo "    (update-desktop-database not available; menu may need a re-login)"
fi

echo
echo "==> Done. Launch via:"
echo "      • App menu: 'vLLM Dashboard'"
echo "      • Terminal: vllm-dashboard"
echo "      • Or:       $STABLE_APPIMAGE"
