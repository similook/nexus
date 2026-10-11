package ipc

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The routing selector's side of the wire: setClashMode, closeConnections and the clashMode
// event, through a real daemon on a real socket, running the composed routing fixture.
//
// The fixture's TUN inbound and outbounds are swapped for loopback ones, so the tunnel started
// here touches nothing on the machine; the guard still runs on it, exactly as for a client.

type modeEvents struct {
	mu     sync.Mutex
	events []ClashModeEvent
}

func (m *modeEvents) on(name string, data json.RawMessage) {
	if name != EventClashMode {
		return
	}
	var event ClashModeEvent
	if json.Unmarshal(data, &event) == nil {
		m.mu.Lock()
		m.events = append(m.events, event)
		m.mu.Unlock()
	}
}

// waitFor returns the first clashMode event after `after` events whose Current is mode.
func (m *modeEvents) waitFor(t *testing.T, after int, mode string) ClashModeEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		for _, event := range m.events[min(after, len(m.events)):] {
			if event.Current == mode {
				m.mu.Unlock()
				return event
			}
		}
		m.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no clashMode event reporting %q", mode)
	return ClashModeEvent{}
}

func (m *modeEvents) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.events)
}

func TestRoutingModesOverTheWire(t *testing.T) {
	stateDir := t.TempDir()
	socket := filepath.Join(t.TempDir(), "test.sock")
	listener, err := Listen(socket)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	server := NewServer(ServerOptions{StateDir: stateDir, Version: "test"})
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan struct{})
	go func() { defer close(served); _ = server.Serve(ctx, listener) }()

	events := &modeEvents{}
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

	// No tunnel: nothing to switch, nothing to report, nothing to close.
	if err = client.SetClashMode("Direct"); err == nil {
		t.Error("setClashMode with no tunnel was accepted")
	}
	if err = client.CloseConnections(); err != nil {
		t.Errorf("closeConnections with no tunnel: %v", err)
	}
	if status, _ := client.GetStatus(); status.ClashMode != "" {
		t.Errorf("status reports mode %q with no tunnel", status.ClashMode)
	}

	// Start in Direct — the daemon's cache.db lives in the state dir, where the guard allows
	// it, so a saved mode from another run cannot leak in here.
	if err = client.Start(routingConfig(t, stateDir, "Direct"), "routing-test"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	started := events.waitFor(t, 0, "Direct")

	// The log the Logs screen shows describes the proxy outbound without naming its server.
	described := ""
	for _, line := range server.logs.read(0) {
		if strings.Contains(line, "guard: proxy outbound: ") {
			described = line
		}
	}
	if !strings.Contains(described, `"server":"[redacted]"`) || strings.Contains(described, "127.0.0.1") {
		t.Errorf("the proxy outbound log line does not withhold the server: %q", described)
	}
	if strings.Join(started.Modes, ",") != "VPN,Direct" {
		t.Errorf("modes %v, expected exactly VPN and Direct", started.Modes)
	}
	if status, _ := client.GetStatus(); status.ClashMode != "Direct" || len(status.ClashModes) != 2 {
		t.Errorf("status reports %q %v, expected Direct and two modes", status.ClashMode, status.ClashModes)
	}

	// A second client attaching to the running tunnel is told the mode unprompted.
	late := &modeEvents{}
	second, err := Connect(socket, late.on)
	if err != nil {
		t.Fatalf("second Connect: %v", err)
	}
	defer second.Close()
	late.waitFor(t, 0, "Direct")

	// Switch live, both ways.
	for _, mode := range []string{"VPN", "Direct", "VPN"} {
		before := events.count()
		if err = client.SetClashMode(mode); err != nil {
			t.Fatalf("setClashMode(%s): %v", mode, err)
		}
		events.waitFor(t, before, mode)
		if status, _ := client.GetStatus(); status.ClashMode != mode || status.State != StateStarted {
			t.Errorf("after switching to %s: state %q mode %q", mode, status.State, status.ClashMode)
		}
	}
	late.waitFor(t, 0, "VPN")

	// Names the config does not define — including the removed three-mode design's — are
	// refused, and nothing changes.
	for _, unknown := range []string{"Global", "Whitelist", "Blacklist"} {
		if err = client.SetClashMode(unknown); err == nil {
			t.Errorf("setClashMode(%s) was accepted", unknown)
		}
	}
	if status, _ := client.GetStatus(); status.ClashMode != "VPN" {
		t.Errorf("a refused switch changed the mode to %q", status.ClashMode)
	}

	if err = client.CloseConnections(); err != nil {
		t.Errorf("closeConnections: %v", err)
	}

	if err = client.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err = client.SetClashMode("Direct"); err == nil {
		t.Error("setClashMode after stop was accepted")
	}
	if status, _ := client.GetStatus(); status.ClashMode != "" {
		t.Errorf("status still reports mode %q after stop", status.ClashMode)
	}
}

// routingConfig is the composed fixture made safe to start: loopback inbound, loopback
// outbounds (nothing listens on them; no traffic is sent), and cache.db in the state dir.
func routingConfig(t *testing.T, stateDir, defaultMode string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash("../../testdata/desktop/routing.json"))
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var config map[string]any
	if err = json.Unmarshal(raw, &config); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	config["inbounds"] = []any{map[string]any{
		"type": "mixed", "tag": "local-in", "listen": "127.0.0.1", "listen_port": freeTCPPort(t),
	}}
	config["outbounds"] = []any{
		map[string]any{"type": "socks", "tag": "proxy", "server": "127.0.0.1", "server_port": freeTCPPort(t)},
		map[string]any{"type": "socks", "tag": "direct", "server": "127.0.0.1", "server_port": freeTCPPort(t)},
	}
	config["route"].(map[string]any)["auto_detect_interface"] = false
	experimental := config["experimental"].(map[string]any)
	experimental["cache_file"] = map[string]any{"enabled": true, "path": filepath.Join(stateDir, "cache.db")}
	experimental["clash_api"].(map[string]any)["default_mode"] = defaultMode
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return string(encoded)
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
