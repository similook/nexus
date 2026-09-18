#!/usr/bin/env bash
# Build nexus.aar for Android.
#
# libbox and nexuscore are bound in ONE invocation on purpose: a gomobile-bound function may
# only take parameters whose types come from bound packages, and nexuscore.NewService takes a
# libbox.PlatformInterface. Binding them separately produces an AAR that will not link.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${OUT:-build/android/nexus.aar}"
ANDROID_API="${ANDROID_API:-21}"

# See README.md "Build tags". Verify against the pinned sing-box release's Makefile —
# the tag list moves between releases.
TAGS="with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api"

command -v gomobile >/dev/null || {
  echo "gomobile not found: go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init" >&2
  exit 1
}
: "${ANDROID_HOME:?ANDROID_HOME must point at the Android SDK}"
: "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point at the NDK}"

mkdir -p "$(dirname "$OUT")"

# -checklinkname=0 — REQUIRED, and not a cosmetic flag.
#
# Go 1.23 made the linker reject //go:linkname directives that reach standard-library
# internals not marked linkname-able at their definition; 1.25 is stricter still. Something
# in the sing-box dependency graph linknames os.checkPidfdOnce, so the link fails with:
#
#   link: .../experimental/libbox: invalid reference to os.checkPidfdOnce
#
# -checklinkname=0 restores the pre-1.23 behaviour. It is the documented escape hatch, not a
# hack, but it IS a safety check being switched off: the linknamed symbol is an unexported
# implementation detail that can change in any Go release. Treat a Go toolchain bump the same
# way we treat a sing-box bump — a reviewed change, with a build to prove it.
#
# Before assuming it is permanent, find the offender:
#   grep -rn "go:linkname os.checkPidfd" "$(go env GOMODCACHE)/github.com/sagernet/"
#
# -s -w strip symbols and DWARF: size, which on Apple is budget.
#
# Flags are identical across platforms so the two builds stay comparable in bench runs.
gomobile bind \
  -v \
  -target=android/arm64 \
  -androidapi "$ANDROID_API" \
  -javapkg=io.nexus \
  -tags "$TAGS" \
  -trimpath \
  -ldflags="-s -w -checklinkname=0" \
  -o "$OUT" \
  github.com/sagernet/sing-box/experimental/libbox \
  github.com/nexus/nexus-core/nexuscore

echo "built $OUT"
echo "sing-box: $(go list -m -f '{{.Version}}' github.com/sagernet/sing-box)"
echo "size:     $(du -h "$OUT" | cut -f1)"
echo
echo "Next: confirm the generated Java names match what the Kotlin expects —"
echo "  unzip -o $OUT -d /tmp/nexus-aar"
echo "  javap -classpath /tmp/nexus-aar/classes.jar io.nexus.libbox.PlatformInterface"