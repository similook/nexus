#!/usr/bin/env bash
# Build Nexus.xcframework for iOS (device + simulator) and macOS.
#
# The framework is linked into BOTH the app target and the NEPacketTunnelProvider extension
# target. The extension is where the ~50 MB ceiling applies — see ADR-0001 §3.3.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${OUT:-build/apple/Nexus.xcframework}"
IOS_VERSION="${IOS_VERSION:-15.0}"

# Kept in sync with build-android.sh. with_ech was dropped after it failed against the
# 1.14 pin — confirm against the pinned release's own Makefile before re-adding it.
TAGS="with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api"

command -v gomobile >/dev/null || {
  echo "gomobile not found: go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init" >&2
  exit 1
}
command -v xcodebuild >/dev/null || { echo "Xcode required" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"

gomobile bind \
  -v \
  -target=ios,iossimulator,macos \
  -iosversion "$IOS_VERSION" \
  -tags "$TAGS" \
  -trimpath \
  -ldflags="-s -w -checklinkname=0" \
  -o "$OUT" \
  github.com/sagernet/sing-box/experimental/libbox \
  github.com/nexus/nexus-core/nexuscore

echo "built $OUT"

# Size gate. Not a proxy for runtime RSS, but a binary that grows suddenly is a signal that a
# build tag or dependency crept in, and every byte of __TEXT is mapped in the extension.
SIZE=$(du -sk "$OUT" | cut -f1)
echo "xcframework size: ${SIZE} KiB"
if [ "$SIZE" -gt 65536 ]; then
  echo "WARNING: framework exceeded 64 MiB — check build tags before shipping" >&2
fi

cat <<'NOTE'

Reminders for the extension target:
  * App Group container must be the BasePath passed to nexuscore.Setup, so the app process
    and the extension share the command socket.
  * Entitlements: com.apple.developer.networking.networkextension (packet-tunnel-provider).
  * Do NOT link this framework into a WebView/UI-only target — it pulls the whole core in.
NOTE
