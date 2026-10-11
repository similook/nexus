package ipc

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/nexus/nexus-core/desktop/tunnel"
)

// The rate half of the traffic counters: totals in, bytes per second out.
func TestTrafficMeterRates(t *testing.T) {
	first, second := &tunnel.Tunnel{}, &tunnel.Tunnel{}
	start := time.Unix(1000, 0)
	var meter trafficMeter

	check := func(label string, up, down, wantUp, wantDown int64) {
		t.Helper()
		if up != wantUp || down != wantDown {
			t.Errorf("%s: got %d/%d B/s, want %d/%d", label, up, down, wantUp, wantDown)
		}
	}

	up, down := meter.sample(first, 500, 700, start)
	check("first sample has nothing to compare with", up, down, 0, 0)

	up, down = meter.sample(first, 1500, 5700, start.Add(time.Second))
	check("one second later", up, down, 1000, 5000)

	up, down = meter.sample(first, 4500, 5700, start.Add(3*time.Second))
	check("a late tick reports per second, not per tick", up, down, 1500, 0)

	up, down = meter.sample(second, 100, 100, start.Add(4*time.Second))
	check("a new tunnel starts from its own zero", up, down, 0, 0)

	up, down = meter.sample(second, 50, 100, start.Add(5*time.Second))
	check("counters that went backwards are not a rate", up, down, 0, 0)
}

// The whole path the UI reads, through a real daemon running a loopback-only tunnel (no TUN, no
// routes): bytes pushed through its inbound to a local echo server come back as totals from
// getStatus and as rates on the status events.
func TestTrafficOverTheWire(t *testing.T) {
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

	var mu sync.Mutex
	var maxUp, maxDown int64
	client, err := Connect(socket, func(name string, data json.RawMessage) {
		var status StatusSnapshot
		if name != EventStatus || json.Unmarshal(data, &status) != nil {
			return
		}
		mu.Lock()
		maxUp, maxDown = max(maxUp, status.Uplink), max(maxDown, status.Downlink)
		mu.Unlock()
	})
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

	config, inbound := trafficConfig(t, stateDir, startSocksEcho(t))
	if err = client.Start(config, "traffic-test"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if status, _ := client.GetStatus(); !status.TrafficAvailable || status.UplinkTotal != 0 || status.DownlinkTotal != 0 {
		t.Fatalf("a fresh tunnel should report known zeros: %+v", status)
	}

	// VPN mode sends example.test to the proxy outbound, which is the echo server.
	connection := socksConnect(t, inbound, "example.test")
	defer connection.Close()
	chunk := make([]byte, 32*1024)
	var sent int64
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err = connection.Write(chunk); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err = io.ReadFull(connection, chunk); err != nil {
			t.Fatalf("read the echo: %v", err)
		}
		sent += int64(len(chunk))
		time.Sleep(50 * time.Millisecond)
	}

	status, err := client.GetStatus()
	if err != nil {
		t.Fatal(err)
	}
	if !status.TrafficAvailable {
		t.Fatal("trafficAvailable is false over a running tunnel")
	}
	if status.UplinkTotal < sent || status.DownlinkTotal < sent {
		t.Errorf("totals %d up / %d down, but %d bytes went each way", status.UplinkTotal, status.DownlinkTotal, sent)
	}
	mu.Lock()
	up, down := maxUp, maxDown
	mu.Unlock()
	if up <= 0 || down <= 0 {
		t.Errorf("no status event carried a rate while traffic flowed: peak %d up / %d down B/s", up, down)
	}

	// Stopped: nothing is moving. Started again: a new tunnel counts from zero.
	if err = client.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if status, _ = client.GetStatus(); status.UplinkTotal != 0 || status.DownlinkTotal != 0 || status.Uplink != 0 || status.Downlink != 0 {
		t.Errorf("traffic reported after stop: %+v", status)
	}
	if err = client.Start(config, "traffic-test"); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if status, _ = client.GetStatus(); status.UplinkTotal != 0 || status.DownlinkTotal != 0 {
		t.Errorf("a reconnect should count from zero: %d up / %d down", status.UplinkTotal, status.DownlinkTotal)
	}
	_ = client.Stop()
}

// trafficConfig is routingConfig with a known inbound port and the proxy outbound pointed at
// proxyPort.
func trafficConfig(t *testing.T, stateDir string, proxyPort int) (config, inbound string) {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(routingConfig(t, stateDir, "VPN")), &decoded); err != nil {
		t.Fatalf("config: %v", err)
	}
	port := freeTCPPort(t)
	decoded["inbounds"].([]any)[0].(map[string]any)["listen_port"] = port
	decoded["outbounds"].([]any)[0].(map[string]any)["server_port"] = proxyPort
	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	return string(encoded), net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}

// startSocksEcho is a SOCKS5 server that accepts any CONNECT and echoes what it receives.
func startSocksEcho(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				if socksAccept(c) == nil {
					_, _ = io.Copy(c, c)
				}
			}(connection)
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

func socksAccept(c net.Conn) error {
	head := make([]byte, 2)
	if _, err := io.ReadFull(c, head); err != nil {
		return err
	}
	if _, err := io.ReadFull(c, make([]byte, head[1])); err != nil {
		return err
	}
	if _, err := c.Write([]byte{5, 0}); err != nil {
		return err
	}
	request := make([]byte, 4)
	if _, err := io.ReadFull(c, request); err != nil {
		return err
	}
	if err := skipSocksAddress(c, request[3]); err != nil {
		return err
	}
	_, err := c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	return err
}

// socksConnect asks the SOCKS5 inbound at address for host:443.
func socksConnect(t *testing.T, address, host string) net.Conn {
	t.Helper()
	connection, err := net.DialTimeout("tcp", address, 2*time.Second)
	if err != nil {
		t.Fatalf("dial the inbound: %v", err)
	}
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	request := append([]byte{5, 1, 0, 5, 1, 0, 3, byte(len(host))}, host...)
	request = append(request, 0x01, 0xbb)
	if _, err = connection.Write(request); err != nil {
		t.Fatalf("socks request: %v", err)
	}
	reply := make([]byte, 2+4)
	if _, err = io.ReadFull(connection, reply); err != nil || reply[3] != 0 {
		t.Fatalf("socks reply %v: %v", reply, err)
	}
	if err = skipSocksAddress(connection, reply[5]); err != nil {
		t.Fatalf("socks reply address: %v", err)
	}
	return connection
}

func skipSocksAddress(c net.Conn, kind byte) error {
	var size int
	switch kind {
	case 1:
		size = 4 + 2
	case 4:
		size = 16 + 2
	case 3:
		length := make([]byte, 1)
		if _, err := io.ReadFull(c, length); err != nil {
			return err
		}
		size = int(length[0]) + 2
	default:
		return io.ErrUnexpectedEOF
	}
	_, err := io.ReadFull(c, make([]byte, size))
	return err
}
