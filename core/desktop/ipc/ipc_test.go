package ipc

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sagernet/sing-box/log"
)

// ---------------------------------------------------------------------------------------
// logRing
// ---------------------------------------------------------------------------------------

func TestLogRingOrdersOldestFirst(t *testing.T) {
	ring := newLogRing(8)
	for _, message := range []string{"first", "second", "third"} {
		ring.write(log.LevelInfo, message)
	}

	lines := ring.read(0)
	if len(lines) != 3 {
		t.Fatalf("got %d lines, expected 3", len(lines))
	}
	// A log view reads top to bottom. Newest-first would look correct in a unit test and
	// backwards on screen.
	for i, expected := range []string{"first", "second", "third"} {
		if !strings.Contains(lines[i], expected) {
			t.Errorf("line %d = %q, expected it to contain %q", i, lines[i], expected)
		}
	}
}

func TestLogRingLimitReturnsTheNewest(t *testing.T) {
	ring := newLogRing(16)
	for _, message := range []string{"old", "middle", "newest"} {
		ring.write(log.LevelInfo, message)
	}

	lines := ring.read(2)
	if len(lines) != 2 {
		t.Fatalf("got %d lines, expected 2", len(lines))
	}
	// "the most recent N", not "the oldest N". Getting this backwards gives a log view that
	// shows the start of the session forever and never the thing that just broke.
	if !strings.Contains(lines[0], "middle") || !strings.Contains(lines[1], "newest") {
		t.Errorf("limit returned the wrong end: %v", lines)
	}
}

func TestLogRingWrapsAndDropsOldest(t *testing.T) {
	ring := newLogRing(3)
	for _, message := range []string{"a", "b", "c", "d", "e"} {
		ring.write(log.LevelInfo, message)
	}

	lines := ring.read(0)
	if len(lines) != 3 {
		t.Fatalf("ring of 3 holds %d lines", len(lines))
	}
	if !strings.Contains(lines[0], "c") || !strings.Contains(lines[2], "e") {
		t.Errorf("wrap kept the wrong lines: %v", lines)
	}
	for _, line := range lines {
		if strings.Contains(line, " a") || strings.Contains(line, " b") {
			t.Errorf("an evicted line survived: %v", lines)
		}
	}
}

func TestLogRingReturnsEmptySliceNotNil(t *testing.T) {
	// nil marshals to JSON `null`, and the log view calls .length on what it gets. A null
	// here is a TypeError in the UI, on a screen whose entire job is showing what went wrong.
	lines := newLogRing(4).read(0)
	if lines == nil {
		t.Fatal("read returned nil")
	}
	if len(lines) != 0 {
		t.Fatalf("a fresh ring held %d lines", len(lines))
	}

	encoded, err := json.Marshal(ReadLogsResult{Lines: lines})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "null") {
		t.Errorf("marshalled to %s", encoded)
	}
}

func TestLogRingClear(t *testing.T) {
	ring := newLogRing(4)
	ring.write(log.LevelInfo, "something")
	ring.clear()

	if lines := ring.read(0); len(lines) != 0 {
		t.Errorf("%d lines survived clear: %v", len(lines), lines)
	}
}

func TestLogRingStripsANSI(t *testing.T) {
	// sing-box hands WriteMessage a message that already carries a colourised level. The
	// destination here is the UI's log view, which renders text — a raw escape sequence shows
	// up as literal junk.
	ring := newLogRing(4)
	ring.WriteMessage(log.LevelDebug, "\x1b[37mDEBUG\x1b[0m[0000] dns: exchanged example.com")

	line := ring.read(0)[0]
	if strings.ContainsRune(line, 0x1b) {
		t.Errorf("an escape sequence survived: %q", line)
	}
	if !strings.Contains(line, "dns: exchanged example.com") {
		t.Errorf("stripping ate the message: %q", line)
	}
	// And the level must not appear twice — sing-box's own "DEBUG" is in the message, so
	// prefixing log.FormatLevel(level) as well produced "debug DEBUG[0000] ...".
	if strings.Count(strings.ToLower(line), "debug") != 1 {
		t.Errorf("the level appears more than once: %q", line)
	}
}

func TestLogRingIsConcurrencySafe(t *testing.T) {
	// WriteMessage is called from core goroutines, on the hot path for anything that logs per
	// connection. Run with -race.
	ring := newLogRing(64)

	var wg sync.WaitGroup
	for writer := 0; writer < 8; writer++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				ring.write(log.LevelInfo, "line")
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			_ = ring.read(10)
		}
	}()
	wg.Wait()
}

// ---------------------------------------------------------------------------------------
// Server / client round trip over a real socket
// ---------------------------------------------------------------------------------------

// start brings up a server on a temp socket and returns a connected client.
//
// A real listener and a real connection, not an in-memory pipe: framing, the scanner's buffer
// limits and the socket's own behaviour are part of what is under test here, and a pipe would
// skip all three.
func start(t *testing.T) (*Server, *Client, *recorder) {
	t.Helper()

	socket := filepath.Join(t.TempDir(), "test.sock")
	listener, err := Listen(socket)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}

	server := NewServer(ServerOptions{StateDir: t.TempDir(), Version: "test"})
	ctx, cancel := context.WithCancel(context.Background())

	served := make(chan struct{})
	go func() { defer close(served); _ = server.Serve(ctx, listener) }()

	events := &recorder{seen: make(map[string]int)}
	client, err := Connect(socket, events.on)
	if err != nil {
		cancel()
		t.Fatalf("Connect: %v", err)
	}

	t.Cleanup(func() {
		_ = client.Close()
		cancel()
		_ = server.Shutdown()
		<-served
	})

	if _, err = client.Hello(3 * time.Second); err != nil {
		t.Fatalf("Hello: %v", err)
	}
	return server, client, events
}

type recorder struct {
	mu   sync.Mutex
	seen map[string]int
}

func (r *recorder) on(name string, _ json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen[name]++
}

func (r *recorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.seen[name]
}

func TestHelloAndInitialState(t *testing.T) {
	_, client, events := start(t)

	hello, err := client.Hello(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if hello.Protocol != Protocol {
		t.Errorf("protocol %d, expected %d", hello.Protocol, Protocol)
	}

	// The daemon pushes current state on connect so a client attaching to an already-running
	// tunnel never renders "disconnected" over a live one.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && events.count(EventServiceState) == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if events.count(EventServiceState) == 0 {
		t.Error("no serviceState was pushed on connect")
	}
}

func TestGetStatusRoundTrip(t *testing.T) {
	_, client, _ := start(t)

	status, err := client.GetStatus()
	if err != nil {
		t.Fatal(err)
	}
	if status.State != StateStopped {
		t.Errorf("state %q, expected %q on a fresh server", status.State, StateStopped)
	}
	// No tunnel, so nothing has moved: a known zero, not an unknown one (see Server.status).
	if !status.TrafficAvailable {
		t.Error("trafficAvailable is false with no tunnel running; zero traffic is known")
	}
	if status.Uplink != 0 || status.Downlink != 0 || status.UplinkTotal != 0 || status.DownlinkTotal != 0 {
		t.Errorf("traffic reported with no tunnel: %+v", status)
	}
}

func TestUnknownMethodIsRefused(t *testing.T) {
	_, client, _ := start(t)

	err := client.Call("noSuchMethod", nil, nil)
	if err == nil {
		t.Fatal("an unknown method was accepted")
	}
	if !strings.Contains(err.Error(), "unknown method") {
		t.Errorf("refused unhelpfully: %v", err)
	}
}

func TestGuardRejectionCrossesTheWire(t *testing.T) {
	// The security boundary, end to end: a hostile config sent by a client must come back as
	// a refusal with the reason intact, not as a generic failure.
	_, client, _ := start(t)

	hostile := `{"inbounds":[{"type":"mixed","tag":"in","listen":"0.0.0.0","listen_port":11080}],` +
		`"outbounds":[{"type":"direct","tag":"direct"}]}`

	err := client.Start(hostile, "hostile")
	if err == nil {
		t.Fatal("SECURITY: the daemon accepted a 0.0.0.0 listener over IPC")
	}
	if !strings.Contains(err.Error(), "open relay") {
		t.Errorf("the guard's reason did not survive the round trip: %v", err)
	}
}

func TestFailedStartSettlesOnStopped(t *testing.T) {
	server, client, _ := start(t)

	_ = client.Start(`{"inbounds":[{"type":"tproxy","tag":"in","listen":"127.0.0.1","listen_port":1}]}`, "bad")

	// A failed start must reach a terminal state. Left on "starting", the UI's connect button
	// spins forever with nothing behind it.
	status, err := client.GetStatus()
	if err != nil {
		t.Fatal(err)
	}
	if status.State != StateStopped {
		t.Errorf("state %q after a failed start, expected %q", status.State, StateStopped)
	}
	if server.active != nil {
		t.Error("a failed start left a tunnel behind")
	}
}

func TestStopIsIdempotent(t *testing.T) {
	// Stop arrives from a button, a tray item and a signal, and they race. A second stop must
	// be a no-op, not an error the UI renders in red.
	_, client, _ := start(t)

	for i := 0; i < 3; i++ {
		if err := client.Stop(); err != nil {
			t.Fatalf("stop %d: %v", i+1, err)
		}
	}
}

func TestTCPPingSurvivesADeadTarget(t *testing.T) {
	// One bad entry in a subscription must not fail "Test All" for the rest.
	_, client, _ := start(t)

	results, err := client.TCPPing([]PingTarget{
		{ID: "dead", Server: "127.0.0.1", Port: 9},
		{ID: "alsodead", Server: "127.0.0.1", Port: 10},
	})
	if err != nil {
		t.Fatalf("a sweep of dead targets returned an error: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("got %d results, expected 2", len(results))
	}
	for _, result := range results {
		if result.MS != -1 {
			t.Errorf("%s reported %d ms, expected -1", result.ID, result.MS)
		}
	}
}

func TestConcurrentCallsGetTheirOwnReplies(t *testing.T) {
	// Responses are matched by id and may arrive out of order. If the client ever matched by
	// arrival order instead, this is what would catch it.
	_, client, _ := start(t)

	var wg sync.WaitGroup
	errs := make(chan error, 16)

	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, err := client.GetStatus()
			if err != nil {
				errs <- err
				return
			}
			if status.State == "" {
				errs <- errStateEmpty
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Errorf("concurrent call: %v", err)
	}
}

var errStateEmpty = errStr("a reply arrived with an empty state - replies may be crossed")

type errStr string

func (e errStr) Error() string { return string(e) }

func TestStatusEventsRespectR4(t *testing.T) {
	_, _, events := start(t)

	time.Sleep(2500 * time.Millisecond)
	count := events.count(EventStatus)

	if count == 0 {
		t.Fatal("no status events in 2.5s")
	}
	// R4 is a ceiling. More than ~1 Hz means something is pushing per-change rather than on
	// a tick, which is a bridge-crossing cost the whole contract is shaped to avoid.
	if count > 5 {
		t.Errorf("%d status events in 2.5s - faster than 1 Hz, R4 violated", count)
	}
}
