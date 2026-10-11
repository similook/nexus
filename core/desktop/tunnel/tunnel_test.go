package tunnel

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The configs under core/testdata/desktop. socksOnly is the one these tests run for real: it
// binds a loopback port and touches nothing else, so it exercises the whole box lifecycle —
// construct, start, serve, tear down — on any machine, in CI, with no privileges and no risk
// to the host's routing.
//
// tunDesktop is only ever validated, never started. Starting it would create a TUN device and
// take over the default route of whatever machine ran `go test`.
const (
	socksOnly  = "../../testdata/desktop/socks-only.json"
	tunDesktop = "../../testdata/desktop/tun-desktop.json"
)

func read(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.FromSlash(path))
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(content)
}

// TestCheckAcceptsDesktopConfigs covers the configs we intend to ship.
//
// tun-desktop.json is the important one: it has strict_route:true, which ADR-0003 §3.4 flags
// as the value Android deliberately sets to false. This asserts sing-box actually accepts the
// desktop shape, so the difference is a decision rather than a guess.
func TestCheckAcceptsDesktopConfigs(t *testing.T) {
	for _, path := range []string{socksOnly, tunDesktop} {
		t.Run(filepath.Base(path), func(t *testing.T) {
			if err := Check(context.Background(), read(t, path)); err != nil {
				t.Fatalf("Check: %v", err)
			}
		})
	}
}

// TestCheckRejectsBadConfig guards the negative case.
//
// A validator that accepts everything passes every positive test ever written, so at least one
// test has to prove it can say no.
func TestCheckRejectsBadConfig(t *testing.T) {
	err := Check(context.Background(), `{"outbounds":[{"type":"nonsense","tag":"x"}]}`)
	if err == nil {
		t.Fatal("Check accepted an unknown outbound type")
	}
	if !strings.Contains(err.Error(), "nonsense") {
		t.Errorf("error should name the offending type, got: %v", err)
	}
}

// TestLifecycle is the real one: start a tunnel, prove it is serving, tear it down, prove it
// let go.
//
// The port check after Close is the part that matters and is easy to omit. "Close returned
// nil" only says the call came back; it does not say the listener is gone. On desktop the
// equivalent question for a real tunnel is whether the routes came back out, and this is the
// closest a privilege-free test can get to asking it.
func TestLifecycle(t *testing.T) {
	instance, err := Open(context.Background(), read(t, socksOnly))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if instance.Started() {
		t.Error("Started() is true before Start()")
	}

	if err = instance.Start(); err != nil {
		_ = instance.Close()
		t.Fatalf("Start: %v", err)
	}

	if !instance.Started() {
		t.Error("Started() is false after a successful Start()")
	}

	// Serving, not merely constructed.
	connection, err := net.DialTimeout("tcp", "127.0.0.1:12080", 2*time.Second)
	if err != nil {
		_ = instance.Close()
		t.Fatalf("the inbound is not accepting connections: %v", err)
	}
	_ = connection.Close()

	if err = instance.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if instance.Started() {
		t.Error("Started() is true after Close()")
	}

	// The listener is actually gone. Without this the test would pass against a Close that
	// returns nil and leaks the port — which is exactly the failure that makes the NEXT start
	// fail with "address already in use" and look like a different bug.
	if !portFree(t, "127.0.0.1:12080") {
		t.Error("port 12080 is still bound after Close()")
	}
}

// TestCloseIsIdempotent — teardown runs from more than one place (a signal, an IPC request,
// a deferred call on an error path) and they can race. A second Close must be a no-op, not a
// double-free or a nil dereference.
func TestCloseIsIdempotent(t *testing.T) {
	instance, err := Open(context.Background(), read(t, socksOnly))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err = instance.Start(); err != nil {
		_ = instance.Close()
		t.Fatalf("Start: %v", err)
	}

	if err = instance.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err = instance.Close(); err != nil {
		t.Fatalf("second Close should be a no-op, got: %v", err)
	}
}

// TestStartAfterCloseFails — a Tunnel is single-use. Restarting a closed box would mean
// reasoning about half-released state; the caller constructs a new one instead. This asserts
// the refusal is explicit rather than an obscure panic from inside sing-box.
func TestStartAfterCloseFails(t *testing.T) {
	instance, err := Open(context.Background(), read(t, socksOnly))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err = instance.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if err = instance.Start(); err == nil {
		_ = instance.Close()
		t.Fatal("Start succeeded on a closed tunnel")
	}
}

// TestSequentialTunnelsShareCacheFile is the desktop rehearsal for switching servers.
//
// On Android this exact sequence produced `initialize cache-file: timeout`: sing-box takes an
// exclusive bbolt flock on cache.db, and opening the next instance before the previous one
// released it deadlocked the swap, leaving a tunnel with no core
// (NexusVpnService.CACHE_LOCK_ATTEMPTS exists because of it).
//
// Nothing about that is Android-specific — it is bbolt and sing-box — so the desktop daemon
// will hit it the moment Phase 3 adds a `start` that replaces a running tunnel. This asserts
// the contract Close is supposed to provide: once it returns, the next Open/Start works.
func TestSequentialTunnelsShareCacheFile(t *testing.T) {
	config := read(t, socksOnly)

	for round := 1; round <= 3; round++ {
		instance, err := Open(context.Background(), config)
		if err != nil {
			t.Fatalf("round %d Open: %v", round, err)
		}
		if err = instance.Start(); err != nil {
			_ = instance.Close()
			t.Fatalf("round %d Start: %v  (a cache-file timeout here means Close did not "+
				"release the bbolt lock before returning)", round, err)
		}
		if err = instance.Close(); err != nil {
			t.Fatalf("round %d Close: %v", round, err)
		}
	}
}

// TestPermissionErrorWording pins that privilege failures are relabelled as such.
//
// CORRECTED 2026-09-23: this once claimed the UI matches /permission denied/i to render the
// failure as "you need to allow this". It did not — that regex hid the error as a declined
// Android consent dialog, and clients/shared now matches only 'VPN permission denied'. What
// this test still guards is real: every shape of privilege failure is turned into one
// actionable sentence, and an unrelated failure is never relabelled as one.
func TestPermissionErrorWording(t *testing.T) {
	cases := []error{
		os.ErrPermission,
		errors.New("create tun: operation not permitted"),
		errors.New("configure tun interface: Access is denied."),
	}

	for _, input := range cases {
		got := permissionError(input)
		if !strings.Contains(strings.ToLower(got.Error()), "permission denied") {
			t.Errorf("permissionError(%q) = %q, which the UI regex will not match", input, got)
		}
	}

	// And the negative: an ordinary failure must NOT be relabelled, or every error becomes a
	// permission prompt and the distinction is worthless.
	ordinary := errors.New("dial tcp 10.0.0.1:443: connection refused")
	if strings.Contains(strings.ToLower(permissionError(ordinary).Error()), "permission denied") {
		t.Error("permissionError relabelled an unrelated failure as a permission problem")
	}
}

func portFree(t *testing.T, address string) bool {
	t.Helper()

	// One retry: the OS can hold a listening socket briefly after the owner closes it, and a
	// flaky test here would train people to ignore a real leak.
	for attempt := 0; attempt < 2; attempt++ {
		listener, err := net.Listen("tcp", address)
		if err == nil {
			_ = listener.Close()
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}
