#!/usr/bin/env bash
#
# Build nexusd, the desktop daemon (ADR-0003).
#
# ============================================================================================
# HOW THIS DIFFERS FROM build-android.sh, AND WHY IT IS SO MUCH SHORTER
#
# build-android.sh runs `gomobile bind` and co-binds TWO packages — libbox and nexuscore — into
# one AAR, because gomobile has to generate Java bindings for both sides of an interface that
# crosses the JNI boundary.
#
# There is no such boundary here. nexusd is a plain Go binary that talks to the GUI over a
# socket, so this is `go build` and nothing else. No gomobile, no NDK, no ANDROID_HOME.
#
# It also does NOT pass -checklinkname=0, and that omission is load-bearing. The Android build
# needs it because libbox's oomprofile package //go:linkname's into the runtime. nexusd does
# not link libbox at all — see the note on `version` in cmd/nexusd/main.go — so if this script
# ever starts needing that flag, something has pulled the mobile path back in. Fix the import
# rather than adding the flag.
# ============================================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
bash ./scripts/prepare-sing-box.sh

# The same tag set as build-android.sh, deliberately.
#
# Keeping them identical is what lets core/scripts/check-configs.sh validate one config against
# one feature set and have the answer mean something on every platform. A config that needs a
# tag the other platform lacks is a config that works on one client and mysteriously fails on
# the other.
#
# Desktop will eventually want more of them — with_dhcp for one — and that is the moment to
# give check-configs.sh a second tag source rather than letting the two drift silently.
TAGS="${TAGS:-with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api}"

VERSION="${VERSION:-0.1.0}"
OUTDIR="${OUTDIR:-build/desktop}"

# Empty = host platform only. Set TARGETS to cross-compile:
#   TARGETS="linux/amd64 linux/arm64 darwin/arm64 windows/amd64" ./scripts/build-desktop.sh
TARGETS="${TARGETS:-}"

# -s -w strips the symbol table and DWARF. -X stamps the version that `nexusd version` prints.
LDFLAGS="-s -w -X main.version=${VERSION}"

build_one() {
    local goos="$1" goarch="$2" suffix=""
    [ "$goos" = "windows" ] && suffix=".exe"

    local out="${OUTDIR}/nexusd-${goos}-${goarch}${suffix}"
    printf '  %-22s ' "${goos}/${goarch}"

    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
        go build -tags "$TAGS" -trimpath -ldflags "$LDFLAGS" -o "$out" ./cmd/nexusd

    printf 'ok  %s\n' "$(du -h "$out" | cut -f1)"
}

mkdir -p "$OUTDIR"

echo "nexusd ${VERSION}"
echo "tags: ${TAGS}"
echo

if [ -z "$TARGETS" ]; then
    build_one "$(go env GOOS)" "$(go env GOARCH)"
else
    for target in $TARGETS; do
        build_one "${target%%/*}" "${target##*/}"
    done
fi

echo
echo "Output in ${OUTDIR}/"
echo
echo "Next: ./${OUTDIR}/nexusd check -c <config.json>   (no privileges needed)"
echo
echo "WARNING: 'nexusd run' with a tun inbound takes over the machine's default route."
echo "There is no crash recovery yet (ADR-0003 Phase 8) — if it is SIGKILLed while"
echo "connected, stale routes can survive it. Use a VM until that lands."
