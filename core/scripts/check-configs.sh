#!/usr/bin/env bash
# Validate every link shape the app claims to support, against the core that actually ships.
#
#   ./core/scripts/check-configs.sh
#
# Two steps, and both matter:
#
#   1. Regenerate the fixtures through the SAME TypeScript assembler the app uses, so this
#      tests the real code path rather than hand-written JSON that drifts.
#   2. Hand each one to libbox.CheckConfig - the same function ConfigGuard calls on device.
#
# THE BUILD TAGS ARE NOT OPTIONAL. Without them the checker links a core that has no QUIC and
# no uTLS, so Hysteria2, TUIC and every REALITY node fail with "not included in this build" -
# a failure about the test binary, not about the config. They are read from build-android.sh so
# the checker can never drift from the AAR.
set -euo pipefail

cd "$(dirname "$0")/.."
TAGS=$(grep -oP '(?<=^TAGS=")[^"]+' scripts/build-android.sh)

echo "==> regenerating fixtures"
(cd ../clients/web && npx tsx scripts/emit-config-fixtures.mts)

echo "==> checking against sing-box (tags: $TAGS)"
go test -tags "$TAGS" -count=1 ./nexuscore/ -run TestGeneratedConfigsPass -v 2>&1 |
  grep -E "^(=== RUN|--- (PASS|FAIL)|ok|FAIL|PASS)" || true

go test -tags "$TAGS" -count=1 ./nexuscore/ -run TestGeneratedConfigsPass >/dev/null
echo "==> all link shapes accepted by the core"
