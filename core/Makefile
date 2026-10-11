.PHONY: verify android apple desktop test test-desktop test-desktop-race clean

# Always run verify before a first build or after a version bump — see core/README.md.
verify:
	./scripts/verify-api.sh

android:
	./scripts/build-android.sh

apple:
	./scripts/build-apple.sh

# The desktop daemon (ADR-0003). Plain `go build` - no gomobile, no NDK, and deliberately no
# -checklinkname=0, because nexusd does not link libbox. Host platform by default; set TARGETS
# to cross-compile.
desktop:
	./scripts/build-desktop.sh

test:
	go test ./nexuscore/...

# Separate from `test` because these BIND A LOOPBACK PORT (127.0.0.1:12080) and start a real
# sing-box. No privileges and no routing changes - but it is a side effect, and a target named
# `test` should not surprise anyone with one.
test-desktop:
	go test -tags "with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api" -count=1 ./desktop/...

# The same suite under the race detector.
#
# Separate because -race requires cgo and therefore a C compiler, which the Windows dev box
# does not have. It matters here more than most places: logRing.WriteMessage is called from
# sing-box's own goroutines on the per-connection path, and ipc.Server fans events out to
# every client from a ticker while request handlers mutate the same state. Run this on Linux
# or in CI before trusting a change to either.
test-desktop-race:
	CGO_ENABLED=1 go test -race -tags "with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api" -count=1 ./desktop/...

clean:
	rm -rf build/
