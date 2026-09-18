#!/usr/bin/env bash
# Dump the real libbox API surface from the PINNED module, so drift is a mechanical fix
# instead of an archaeology session.
#
# Run this:
#   * before the first build (the signatures in nexuscore/ were written against published
#     docs for the 1.12 line, not a compiled 1.14 — see README.md "API drift")
#   * on every sing-box version bump, before touching any other file
set -euo pipefail

cd "$(dirname "$0")/.."

command -v go >/dev/null || { echo "go toolchain required" >&2; exit 1; }

PKG="github.com/sagernet/sing-box/experimental/libbox"
VERSION=$(go list -m -f '{{.Version}}' github.com/sagernet/sing-box)

echo "=== pinned sing-box: $VERSION ==="
echo

echo "--- SetupOptions (nexuscore.go builds a literal of this — the usual break) ---"
go doc "$PKG.SetupOptions"
echo

echo "--- PlatformInterface (implemented natively in Kotlin/Swift, not here) ---"
go doc "$PKG.PlatformInterface"
echo

# The service type has been renamed before (BoxService was gone in 1.14) and may be again.
# We deliberately never name it in our code — service.go's boxService interface and power.go's
# pauser interface both match on METHODS. So rather than `go doc` a fixed name, discover the
# real return type of NewService and document whatever it is called today.
echo "--- NewService signature (the service type is whatever this returns) ---"
go doc "$PKG.NewService"
echo
SERVICE_TYPE=$(go doc "$PKG.NewService" 2>/dev/null | grep -oE '\(\*[A-Za-z_][A-Za-z0-9_]*,' | head -1 | tr -d '(*,')
if [ -n "$SERVICE_TYPE" ]; then
  echo "--- $SERVICE_TYPE (boxService + pauser must stay subsets of this) ---"
  go doc "$PKG.$SERVICE_TYPE"
else
  echo "(could not parse the service type from NewService — read the signature above)"
fi
echo

echo "--- CommandServer / CommandClient (the UI boundary, docs/ipc-boundary.md) ---"
go doc "$PKG.CommandServer"
go doc "$PKG.CommandClient"
go doc "$PKG.CommandClientOptions"
echo

echo "--- handlers implemented by the native plugin ---"
go doc "$PKG.CommandServerHandler"
go doc "$PKG.CommandClientHandler"
echo

echo "=== checking our two drift points compile ==="
go build ./nexuscore/ && echo "OK: nexuscore builds against $VERSION"
