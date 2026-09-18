#!/usr/bin/env bash
# One-shot dump of everything nexuscore depends on in the pinned libbox.
#
# Run this when the API moves under us (it did between 1.12 and 1.14: BoxService and
# NewService both disappeared, and the service lifecycle moved onto CommandServer).
#
#   ./scripts/dump-api.sh > /tmp/libbox-api.txt
#
# Paste the output. Every open question in service.go is answered by something below.
set -uo pipefail

cd "$(dirname "$0")/.."

command -v go >/dev/null || { echo "go toolchain required" >&2; exit 1; }

PKG="github.com/sagernet/sing-box/experimental/libbox"
VERSION=$(go list -m -f '{{.Version}}' github.com/sagernet/sing-box 2>/dev/null)
DIR=$(go list -m -f '{{.Dir}}' github.com/sagernet/sing-box 2>/dev/null)/experimental/libbox

echo "=============================================================="
echo " sing-box $VERSION"
echo " $DIR"
echo "=============================================================="
echo

echo "########## 1. EVERY exported func in the package ##########"
grep -hE '^func [A-Z]' "$DIR"/*.go | sort
echo

echo "########## 2. EVERY exported method, grouped by receiver ##########"
grep -hE '^func \([a-zA-Z_]+ \*?[A-Z][A-Za-z0-9_]*\) [A-Z]' "$DIR"/*.go \
  | sed -E 's/^func \([a-zA-Z_]+ \*?([A-Za-z0-9_]+)\) /\1 :: /' | sort
echo

echo "########## 3. EVERY exported type ##########"
grep -hE '^type [A-Z]' "$DIR"/*.go | sort
echo

echo "########## 4. The lifecycle owner ##########"
for sym in CommandServer NewCommandServer CommandServerHandler OverrideOptions; do
  echo "----- $sym -----"
  go doc "$PKG.$sym" 2>&1 | head -40
  echo
done

echo "########## 5. Setup + platform ##########"
for sym in SetupOptions PlatformInterface; do
  echo "----- $sym -----"
  go doc "$PKG.$sym" 2>&1 | head -40
  echo
done

echo "########## 6. The UI channel ##########"
for sym in CommandClient CommandClientOptions CommandClientHandler StatusMessage; do
  echo "----- $sym -----"
  go doc "$PKG.$sym" 2>&1 | head -40
  echo
done

echo "########## 7. Command constants (Kotlin uses these) ##########"
grep -hE '^\s*Command[A-Za-z]+\s*=|^\s*Command[A-Za-z]+ ' "$DIR"/*.go | head -40
echo

echo "########## 8. Do these still exist anywhere? ##########"
for sym in ResetNetwork UpdateWIFIState NeedWIFIState Pause Wake StartOrReloadService; do
  printf '%-22s ' "$sym"
  hits=$(grep -hE "^func \([a-zA-Z_]+ \*?[A-Z][A-Za-z0-9_]*\) $sym\(" "$DIR"/*.go)
  if [ -n "$hits" ]; then echo "$hits" | tr '\n' ' '; echo; else echo "ABSENT"; fi
done
