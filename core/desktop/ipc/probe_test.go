package ipc

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	engine "github.com/nexus/nexus-core/desktop/probe"
	"github.com/nexus/nexus-core/desktop/tunnel"
)

// probeClient is start() with every event's payload kept, not just counted.
type probeRecorder struct {
	mu     sync.Mutex
	events []Frame
}

func (r *probeRecorder) on(name string, data json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, Frame{Event: name, Data: append(json.RawMessage(nil), data...)})
}

func (r *probeRecorder) named(name string) []json.RawMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []json.RawMessage
	for _, frame := range r.events {
		if frame.Event == name {
			out = append(out, frame.Data)
		}
	}
	return out
}

func startProbe(t *testing.T) (*Server, *Client, *probeRecorder) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "probe.sock")
	listener, err := Listen(socket)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	server := NewServer(ServerOptions{StateDir: t.TempDir(), Version: "test"})
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan struct{})
	go func() { defer close(served); _ = server.Serve(ctx, listener) }()
	events := &probeRecorder{}
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

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return condition()
}

func nodeConfig(server string) string {
	return `{"outbounds":[{"type":"vless","tag":"proxy","server":"` + server +
		`","server_port":443,"uuid":"6f1d5b52-6a35-4f0e-9b0e-2b8a1c3d4e5f"},{"type":"direct","tag":"direct"}]}`
}

// With no tunnel the run goes out as on Android: results stream as sanitized categories, the
// run ends with one done, and nothing but a run id and a count reaches the log.
func TestProbeServersStreamsResultsOverTheWire(t *testing.T) {
	server, client, events := startProbe(t)
	params := ProbeServersParams{RunID: 41, Targets: []ProbeTarget{
		{ID: "private", Fingerprint: "fp-private", Config: nodeConfig("10.1.2.3")},
		{ID: "broken", Fingerprint: "fp-broken", Config: "{}"},
		// localhost resolves locally to loopback, which the address policy refuses: no packet
		// leaves this machine for any of these.
		{ID: "loopback-name", Fingerprint: "fp-loop", Config: nodeConfig("localhost")},
	}}
	var result ProbeServersResult
	if err := client.Call(MethodProbeServers, params, &result); err != nil {
		t.Fatal(err)
	}
	if result.RunID != 41 {
		t.Errorf("runId %d, want 41", result.RunID)
	}
	if !waitFor(t, 10*time.Second, func() bool { return len(events.named(EventServerProbeDone)) == 1 }) {
		t.Fatal("no serverProbeDone")
	}
	want := map[string]string{"private": "config_invalid", "broken": "config_invalid", "loopback-name": "dns_failed"}
	results := events.named(EventServerProbe)
	if len(results) != len(want) {
		t.Fatalf("%d results, want %d", len(results), len(want))
	}
	for _, raw := range results {
		var result ServerProbeEvent
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		if result.RunID != 41 || want[result.ServerID] != result.Status || result.DelayMS != 0 ||
			!strings.HasPrefix(result.Fingerprint, "fp-") {
			t.Errorf("result %+v", result)
		}
	}
	var done ServerProbeDoneEvent
	_ = json.Unmarshal(events.named(EventServerProbeDone)[0], &done)
	if done.RunID != 41 || done.Cancelled {
		t.Errorf("done %+v", done)
	}
	logs := strings.Join(server.logs.read(50), "\n")
	if !strings.Contains(logs, "probe run 41: 3 servers") || !strings.Contains(logs, "probe run 41 done") {
		t.Errorf("probe log lines missing:\n%s", logs)
	}
	if strings.Contains(logs, "10.1.2.3") || strings.Contains(logs, "6f1d5b52") {
		t.Error("an endpoint or credential reached the log")
	}
}

func TestProbeServersRejectsBadParams(t *testing.T) {
	_, client, _ := startProbe(t)
	if err := client.Call(MethodProbeServers, ProbeServersParams{RunID: 0, Targets: []ProbeTarget{{ID: "x", Config: "{}"}}}, nil); err == nil {
		t.Error("runId 0 accepted")
	}
	if err := client.Call(MethodProbeServers, ProbeServersParams{RunID: 5}, nil); err == nil {
		t.Error("no targets accepted")
	}
}

// A tunnel whose upstream interface is unknown must not be probed through: the run is
// refused and TCP reports nothing, rather than measuring the tunnel.
func TestProbesRefuseATunnelWithNoUpstream(t *testing.T) {
	server, client, _ := startProbe(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port

	server.mu.Lock()
	server.active = &tunnel.Tunnel{} // present, never started: no upstream interface
	server.mu.Unlock()
	defer func() {
		server.mu.Lock()
		server.active = nil
		server.mu.Unlock()
	}()

	err = client.Call(MethodProbeServers, ProbeServersParams{RunID: 7, Targets: []ProbeTarget{{ID: "a", Config: nodeConfig("10.0.0.1")}}}, nil)
	if err == nil || !strings.Contains(err.Error(), "no network interface") {
		t.Errorf("probeServers with an unknown upstream: %v", err)
	}
	results, err := client.TCPPing([]PingTarget{{ID: "local", Server: "127.0.0.1", Port: port}})
	if err != nil || len(results) != 1 || results[0].MS != -1 {
		t.Errorf("tcpPing with an unknown upstream: %v %+v", err, results)
	}
}

// A run that began in one network state must not report from another.
func TestProbeResultsAreDroppedWhenTheTunnelChanges(t *testing.T) {
	server, _, events := startProbe(t)
	handler := &probeEvents{server: server, tunnel: nil}
	handler.OnResult(9, "a", "fp", "ok", 120)
	if !waitFor(t, 2*time.Second, func() bool { return len(events.named(EventServerProbe)) == 1 }) {
		t.Fatal("a result in an unchanged state was not delivered")
	}
	server.mu.Lock()
	server.active = &tunnel.Tunnel{}
	server.mu.Unlock()
	defer func() {
		server.mu.Lock()
		server.active = nil
		server.mu.Unlock()
	}()
	handler.OnResult(9, "b", "fp", "ok", 130)
	handler.OnDone(9, false)
	if !waitFor(t, 2*time.Second, func() bool { return len(events.named(EventServerProbeDone)) == 1 }) {
		t.Fatal("no done")
	}
	if n := len(events.named(EventServerProbe)); n != 1 {
		t.Errorf("%d results delivered, want 1: the one after the tunnel changed must be dropped", n)
	}
	var done ServerProbeDoneEvent
	_ = json.Unmarshal(events.named(EventServerProbeDone)[0], &done)
	if !done.Cancelled {
		t.Error("a run cut short by a tunnel change must end as cancelled")
	}
}

type blockingResolver struct{ release chan struct{} }

func (r blockingResolver) Resolve(string) string { <-r.release; return "" }

// The GUI drops its link while hidden (R1); the run it started is cancelled, as Android's is
// in handleOnPause.
func TestDepartingClientCancelsItsRun(t *testing.T) {
	server, _, events := startProbe(t)
	resolver := blockingResolver{release: make(chan struct{})}
	defer close(resolver.release)
	owner := &client{}
	handler := &probeEvents{server: server}
	server.probes.mu.Lock()
	server.probes.runID, server.probes.owner = 77, owner
	server.probes.mu.Unlock()
	targets, _ := json.Marshal([]ProbeTarget{{ID: "slow", Fingerprint: "fp", Config: nodeConfig("slow.example")}})
	if err := engine.ProbeServers(77, string(targets), 0, 20000, resolver, handler); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	server.cancelProbeOf(&client{}) // someone else leaving changes nothing
	time.Sleep(200 * time.Millisecond)
	if len(events.named(EventServerProbeDone)) != 0 {
		t.Fatal("another client's departure ended the run")
	}
	server.cancelProbeOf(owner)
	if !waitFor(t, 2*time.Second, func() bool { return len(events.named(EventServerProbeDone)) == 1 }) {
		t.Fatal("the owner's departure did not end its run")
	}
	var done ServerProbeDoneEvent
	_ = json.Unmarshal(events.named(EventServerProbeDone)[0], &done)
	if done.RunID != 77 || !done.Cancelled {
		t.Errorf("done %+v", done)
	}
}

func TestBindProxyOutbound(t *testing.T) {
	config := `{"log":{"level":"info"},"outbounds":[{"type":"vless","tag":"proxy","server":"203.0.113.9","server_port":443},{"type":"direct","tag":"direct"}],"route":{"final":"proxy"}}`
	var root struct {
		Log       json.RawMessage              `json:"log"`
		Outbounds []map[string]json.RawMessage `json:"outbounds"`
		Route     json.RawMessage              `json:"route"`
	}
	if err := json.Unmarshal([]byte(bindProxyOutbound(config, "Wi-Fi")), &root); err != nil {
		t.Fatal(err)
	}
	if got := string(root.Outbounds[0]["bind_interface"]); got != `"Wi-Fi"` {
		t.Errorf("proxy bind_interface %s", got)
	}
	if _, bound := root.Outbounds[1]["bind_interface"]; bound {
		t.Error("a non-proxy outbound was bound")
	}
	if string(root.Outbounds[0]["server_port"]) != "443" || string(root.Route) != `{"final":"proxy"}` {
		t.Error("other fields were not passed through unchanged")
	}
	for _, unchanged := range []string{"not json", `{}`, `{"outbounds":{}}`} {
		if bindProxyOutbound(unchanged, "x") != unchanged {
			t.Errorf("%q was rewritten", unchanged)
		}
	}
}

func TestResolverHelpers(t *testing.T) {
	servers := []netip.Addr{netip.MustParseAddr("192.0.2.53"), netip.MustParseAddr("2001:db8::53")}
	if !isServer(servers, "192.0.2.53:53") || !isServer(servers, "[2001:db8::53]:53") {
		t.Error("a physical server was not recognised")
	}
	if isServer(servers, "172.19.0.2:53") || isServer(servers, "nonsense") {
		t.Error("a foreign server was taken for a physical one")
	}
	if got := joinAddrs([]netip.Addr{netip.MustParseAddr("::ffff:203.0.113.9"), netip.MustParseAddr("2001:db8::1")}); got != "203.0.113.9,2001:db8::1" {
		t.Errorf("joinAddrs %q", got)
	}
	if !fakeIPRange.Contains(netip.MustParseAddr("198.19.255.1")) || fakeIPRange.Contains(netip.MustParseAddr("198.20.0.1")) {
		t.Error("fakeip range wrong")
	}
	if runtime.GOOS == "windows" && physicalDNSServers(-1) != nil {
		t.Error("an interface that does not exist has DNS servers")
	}
}
