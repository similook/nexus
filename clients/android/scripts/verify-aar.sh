#!/usr/bin/env bash
# Dump every gomobile-generated type the Kotlin depends on, in one pass.
#
#   ./scripts/verify-aar.sh > /tmp/aar-api.txt
#
# Run after every core rebuild. The Kotlin is written against these signatures, and gomobile
# regenerates them from Go on each build — so a Go-side change silently reshapes the Java API
# that Kotlin compiles against. Catching it here costs a minute; catching it in Gradle costs an
# afternoon of unrelated-looking errors.
#
# Two classes of breakage this has already caught:
#   * TunOptions.getDNSServerAddress() went StringBox -> StringIterator AND gained `throws`.
#     Kotlin has no checked exceptions, so the old code compiled and would have failed on device.
#   * Acronym-led getters (getMTU, getHTTPProxyServer) do not map to the Kotlin property names
#     you would expect. Always call the getter.
set -uo pipefail

# scripts/ is Nexus/clients/android/scripts, so the repo root is three levels up, not two.
AAR="${1:-../../../core/build/android/nexus.aar}"
WORK="${WORK:-/tmp/nexus-aar}"

cd "$(dirname "$0")"

# Fall back to an already-extracted tree, so this still works if the AAR has been moved into
# the Gradle project's libs/ or was only ever unzipped by hand.
if [ ! -f "$AAR" ] && [ -f "$WORK/classes.jar" ]; then
  echo "AAR not found at $AAR — using previously extracted $WORK" >&2
  SKIP_EXTRACT=1
elif [ ! -f "$AAR" ]; then
  echo "AAR not found: $AAR" >&2
  echo "Build it:  (cd ../../../core && ./scripts/build-android.sh)" >&2
  echo "Or pass a path:  $0 /path/to/nexus.aar" >&2
  exit 1
fi

command -v javap >/dev/null || { echo "javap required (JDK 17)" >&2; exit 1; }
command -v unzip >/dev/null || { echo "unzip required" >&2; exit 1; }

if [ -z "${SKIP_EXTRACT:-}" ]; then
  rm -rf "$WORK"
  mkdir -p "$WORK"
  unzip -o -q "$AAR" -d "$WORK"
fi

CP="$WORK/classes.jar"
echo "=============================================================="
if [ -f "$AAR" ]; then echo " $AAR ($(ls -la "$AAR" | awk '{print $5}') bytes)"; else echo " (extracted tree: $WORK)"; fi
echo "=============================================================="
echo

dump() {
  echo "########## $1 ##########"
  shift
  for t in "$@"; do
    echo "----- $t -----"
    javap -classpath "$CP" "$t" 2>&1 | sed 's/^/  /'
    echo
  done
}

# Everything NexusVpnService + PlatformInterfaceWrapper touch.
dump "PLATFORM (PlatformInterfaceWrapper.kt, NexusVpnService.kt)" \
  io.nexus.libbox.PlatformInterface \
  io.nexus.libbox.TunOptions \
  io.nexus.libbox.RoutePrefix \
  io.nexus.libbox.RoutePrefixIterator \
  io.nexus.libbox.StringIterator \
  io.nexus.libbox.NetworkInterface \
  io.nexus.libbox.NetworkInterfaceIterator \
  io.nexus.libbox.InterfaceUpdateListener \
  io.nexus.libbox.WIFIState \
  io.nexus.libbox.Notification \
  io.nexus.libbox.StringBox \
  io.nexus.libbox.ConnectionOwner

# Everything NexusPlugin touches for the UI channel.
dump "COMMAND CHANNEL (NexusPlugin.kt)" \
  io.nexus.libbox.Libbox \
  io.nexus.libbox.CommandClient \
  io.nexus.libbox.CommandClientOptions \
  io.nexus.libbox.CommandClientHandler \
  io.nexus.libbox.StatusMessage \
  io.nexus.libbox.OutboundGroupIterator \
  io.nexus.libbox.Connections

# OUR OWN bindings. Never yet verified — gomobile mangles our Go exactly as it mangles
# libbox's, so nexuscore.Service's Java names are generated, not chosen by us.
dump "NEXUSCORE (our Go, as gomobile generated it)" \
  io.nexus.nexuscore.Nexuscore \
  io.nexus.nexuscore.Service

echo "########## Command constants for CommandClientOptions.addCommand(int) ##########"
javap -classpath "$CP" -constants io.nexus.libbox.Libbox 2>/dev/null   | grep -iE "command|int .* = " | sed 's/^/  /'
echo

echo "########## sanity: the three load-bearing PlatformInterface members ##########"
for m in usePlatformAutoDetectInterfaceControl useProcFS openTun; do
  printf '  %-40s ' "$m"
  javap -classpath "$CP" io.nexus.libbox.PlatformInterface 2>/dev/null | grep -c " $m(" | tr -d '\n'
  echo " occurrence(s)"
done
