package tunnel

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	mDNS "github.com/miekg/dns"
	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing/service"
)

// routingFixture is written by clients/shared/scripts/check-routing.mts from the app's own
// composer (clients/shared/src/core/routing.ts): a real node config with both routing modes,
// VPN and Direct, compiled in. These tests run its rules for real.
//
// Nothing here creates a TUN device or touches the network: the inbound is a loopback SOCKS
// listener, both outbounds are loopback SOCKS recorders, and dns-local is an offline hosts
// server — so the only thing observed is which outbound, or which DNS server, sing-box chose.
const routingFixture = "../../testdata/desktop/routing.json"

// TestRoutingFixtureChecks: the composed config — TUN inbound, REALITY outbound, dns-local,
// both modes' rules — is one sing-box builds.
func TestRoutingFixtureChecks(t *testing.T) {
	if err := Check(context.Background(), read(t, routingFixture)); err != nil {
		t.Fatalf("Check: %v", err)
	}
}

// TestRoutingModesRouteAsComposed switches one live tunnel VPN -> Direct -> VPN -> Direct and
// checks where each destination goes. The switch is SetMode, never a restart: the same inbound
// serves every probe, and the tunnel reports started throughout.
func TestRoutingModesRouteAsComposed(t *testing.T) {
	h := newHarness(t, "", "")

	probes := []struct {
		host string
		vpn  string // outbound in VPN mode; Direct mode sends everything direct
	}{
		{"example.test", "proxy"},
		{"www.example.test", "proxy"},
		{"203.0.113.5", "proxy"},
		// Private and LAN addresses stay direct in VPN mode.
		{"192.168.50.9", "direct"},
		{"10.1.2.3", "direct"},
	}

	current, modes, ok := h.tunnel.Mode()
	if !ok || current != "VPN" {
		t.Fatalf("started in %q (ok=%v), expected the fixture's default VPN", current, ok)
	}
	if strings.Join(modes, ",") != "VPN,Direct" {
		t.Fatalf("mode list %v, expected exactly VPN and Direct", modes)
	}

	for _, mode := range []string{"VPN", "Direct", "VPN", "Direct"} {
		if err := h.tunnel.SetMode(mode); err != nil {
			t.Fatalf("SetMode(%s): %v", mode, err)
		}
		if got, _, _ := h.tunnel.Mode(); got != mode {
			t.Fatalf("Mode() = %q after SetMode(%q)", got, mode)
		}
		if !h.tunnel.Started() {
			t.Fatalf("the tunnel is not running after switching to %s", mode)
		}
		for _, p := range probes {
			want := p.vpn
			if mode == "Direct" {
				want = "direct"
			}
			if got := h.route(t, p.host); got != want {
				t.Errorf("%s: %s went %s, expected %s", mode, p.host, got, want)
			}
		}
	}
}

// TestSwitchKeepsConnectionsUntilClosed pins sing-box's split between the two calls, both ways
// round: SetMode changes where NEW connections go and leaves open ones alone; CloseConnections
// ends them, and the tunnel stays up.
func TestSwitchKeepsConnectionsUntilClosed(t *testing.T) {
	h := newHarness(t, "", "")

	for _, step := range []struct{ from, to, heldVia, newVia string }{
		{"VPN", "Direct", "proxy", "direct"},
		{"Direct", "VPN", "direct", "proxy"},
	} {
		if err := h.tunnel.SetMode(step.from); err != nil {
			t.Fatalf("SetMode(%s): %v", step.from, err)
		}
		held, err := h.connect("example.test")
		if err != nil {
			t.Fatalf("connect: %v", err)
		}
		if got := h.await(t); got != step.heldVia {
			t.Fatalf("%s sent example.test %s, expected %s", step.from, got, step.heldVia)
		}

		if err = h.tunnel.SetMode(step.to); err != nil {
			t.Fatalf("SetMode(%s): %v", step.to, err)
		}
		if !stillOpen(held, 300*time.Millisecond) {
			t.Fatalf("%s -> %s: SetMode closed an open connection; closing is CloseConnections' job", step.from, step.to)
		}
		if got := h.route(t, "example.test"); got != step.newVia {
			t.Fatalf("%s -> %s: a new connection went %s, expected %s", step.from, step.to, got, step.newVia)
		}

		if closed := h.tunnel.CloseConnections(); closed == 0 {
			t.Errorf("%s -> %s: CloseConnections reported nothing to close", step.from, step.to)
		}
		if stillOpen(held, 2*time.Second) {
			t.Fatalf("%s -> %s: CloseConnections left a connection open", step.from, step.to)
		}
		held.Close()
		if !h.tunnel.Started() {
			t.Fatalf("%s -> %s: CloseConnections took the tunnel down", step.from, step.to)
		}
	}
}

// TestDirectModeDNS: what DNS does in each mode, and why Direct needs its own DNS rule.
//
// Address lookups get a fake IP in both modes — that is what keeps a live switch correct, and
// it is unchanged. Every OTHER query (HTTPS, SVCB, TXT…) goes to dns-proxy, a DoH server pinned
// to the proxy outbound, whatever the route says. So in Direct mode, without a DNS rule of its
// own, part of the DNS still travels through the VPN. The A/B below shows it: with the Direct
// DNS rule stripped, the proxy receives the DoH connection; with the composed config, dns-local
// answers and the proxy sees nothing.
func TestDirectModeDNS(t *testing.T) {
	h := newHarness(t, "", "")
	router := service.FromContext[adapter.DNSRouter](h.tunnel.ctx)
	if router == nil {
		t.Fatal("no DNS router in the tunnel's context")
	}

	for _, mode := range []string{"VPN", "Direct"} {
		if err := h.tunnel.SetMode(mode); err != nil {
			t.Fatalf("SetMode(%s): %v", mode, err)
		}
		// Address lookups: a fake IP, answered locally, in both modes.
		answer, err := exchange(router, "example.test.", mDNS.TypeA)
		if err != nil {
			t.Fatalf("%s: A query: %v", mode, err)
		}
		if address := firstA(answer); !netip.MustParsePrefix("198.18.0.0/15").Contains(address) {
			t.Errorf("%s: A answer %v, expected a fake IP from 198.18.0.0/15", mode, address)
		}
		if h.sawDNSOverProxy(200 * time.Millisecond) {
			t.Errorf("%s: an A lookup went out through the proxy", mode)
		}
	}

	// Other queries: through the VPN in VPN mode, as today...
	if err := h.tunnel.SetMode("VPN"); err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = exchange(router, "example.test.", mDNS.TypeTXT) }()
	if !h.sawDNSOverProxy(3 * time.Second) {
		t.Error("VPN: a TXT query did not go to dns-proxy through the tunnel")
	}

	// ...and over the normal connection in Direct mode.
	if err := h.tunnel.SetMode("Direct"); err != nil {
		t.Fatal(err)
	}
	answer, err := exchange(router, "example.test.", mDNS.TypeTXT)
	if err != nil || answer.Rcode != mDNS.RcodeNameError {
		t.Errorf("Direct: TXT query answered %v (err %v); expected dns-local's offline NXDOMAIN", answer, err)
	}
	if h.sawDNSOverProxy(500 * time.Millisecond) {
		t.Error("Direct: a TXT query went out through the proxy")
	}
}

// TestDirectDNSRuleIsWhatKeepsDNSOffTheVPN is the control half of TestDirectModeDNS: the same
// config with the Direct DNS rule removed sends Direct-mode TXT queries through the proxy.
func TestDirectDNSRuleIsWhatKeepsDNSOffTheVPN(t *testing.T) {
	h := newHarnessWith(t, "", "", func(config map[string]any) {
		dns := config["dns"].(map[string]any)
		var kept []any
		for _, rule := range dns["rules"].([]any) {
			if mode, _ := rule.(map[string]any)["clash_mode"].(string); mode != "Direct" {
				kept = append(kept, rule)
			}
		}
		if len(kept) == len(dns["rules"].([]any)) {
			t.Fatal("the fixture has no Direct DNS rule to remove")
		}
		dns["rules"] = kept
	})
	if err := h.tunnel.SetMode("Direct"); err != nil {
		t.Fatal(err)
	}
	router := service.FromContext[adapter.DNSRouter](h.tunnel.ctx)
	go func() { _, _ = exchange(router, "example.test.", mDNS.TypeTXT) }()
	if !h.sawDNSOverProxy(3 * time.Second) {
		t.Fatal("premise: without the Direct DNS rule a TXT query should reach dns-proxy through the " +
			"proxy; if it does not, the rule may no longer be needed")
	}
}

// TestDefaultModeWinsOverTheSavedMode is the A/B for applyDefaultMode.
//
// A: sing-box on its own restores the mode saved in cache.db and ignores default_mode — so a
// user who last used Direct would reconnect in Direct while choosing VPN.
// B: a Tunnel starts in the mode its config asks for.
func TestDefaultModeWinsOverTheSavedMode(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache.db")

	first := newHarness(t, cache, "VPN")
	if err := first.tunnel.SetMode("Direct"); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	first.close(t)

	bare := startBareBox(t, harnessConfig(t, cache, "VPN", freePort(t), freePort(t), freePort(t), nil))
	clash := service.FromContext[adapter.ClashServer](bare.ctx)
	if clash == nil || clash.Mode() != "Direct" {
		mode := "<no clash server>"
		if clash != nil {
			mode = clash.Mode()
		}
		t.Fatalf("premise: a bare box came up in %q; expected the saved Direct to override "+
			"default_mode VPN. If sing-box stopped restoring it, applyDefaultMode may be moot.", mode)
	}
	if err := bare.instance.Close(); err != nil {
		t.Fatalf("close bare box: %v", err)
	}

	second := newHarness(t, cache, "VPN")
	if got, _, _ := second.tunnel.Mode(); got != "VPN" {
		t.Fatalf("Tunnel came up in %q, expected its default_mode VPN", got)
	}
}

// TestSetModeRefusesWhatCannotBeApplied: a mode the config does not define — including every
// name the removed three-mode design used — and any mode with no running tunnel, are errors,
// never a silent no-op the caller would read as success.
func TestSetModeRefusesWhatCannotBeApplied(t *testing.T) {
	instance, err := Open(context.Background(), harnessConfig(t, "", "", freePort(t), freePort(t), freePort(t), nil))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err = instance.SetMode("Direct"); err == nil {
		t.Error("SetMode before Start was accepted")
	}
	if _, _, ok := instance.Mode(); ok {
		t.Error("Mode() reported a mode before Start")
	}
	if err = instance.Start(); err != nil {
		_ = instance.Close()
		t.Fatalf("Start: %v", err)
	}
	for _, unknown := range []string{"Global", "Whitelist", "Blacklist", "Rule", ""} {
		if err = instance.SetMode(unknown); err == nil || !strings.Contains(err.Error(), "available") {
			t.Errorf("SetMode(%q) = %v, expected a refusal naming the available modes", unknown, err)
		}
	}
	if err = instance.SetMode("direct"); err != nil {
		t.Errorf("mode names match case-insensitively, as sing-box's rules do: %v", err)
	}
	if err = instance.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err = instance.SetMode("VPN"); err == nil {
		t.Error("SetMode after Close was accepted")
	}
}

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

type harness struct {
	tunnel  *Tunnel
	inbound string
	proxy   *socksRecorder
	direct  *socksRecorder
}

func newHarness(t *testing.T, cachePath, defaultMode string) *harness {
	return newHarnessWith(t, cachePath, defaultMode, nil)
}

func newHarnessWith(t *testing.T, cachePath, defaultMode string, edit func(map[string]any)) *harness {
	t.Helper()
	proxy := newSocksRecorder(t)
	direct := newSocksRecorder(t)
	inboundPort := freePort(t)

	instance, err := Open(context.Background(),
		harnessConfig(t, cachePath, defaultMode, inboundPort, proxy.port(), direct.port(), edit))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err = instance.Start(); err != nil {
		_ = instance.Close()
		t.Fatalf("Start: %v", err)
	}
	h := &harness{
		tunnel:  instance,
		inbound: net.JoinHostPort("127.0.0.1", strconv.Itoa(inboundPort)),
		proxy:   proxy,
		direct:  direct,
	}
	t.Cleanup(func() { _ = instance.Close() })
	return h
}

func (h *harness) close(t *testing.T) {
	t.Helper()
	if err := h.tunnel.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// harnessConfig is the fixture with its TUN inbound, its two outbounds and dns-local swapped for
// loopback and offline test doubles. The route rules, the other DNS servers and rules, and
// experimental are the composer's, untouched — except auto_detect_interface: binding a loopback
// dial to the physical adapter is not something these tests are about.
func harnessConfig(t *testing.T, cachePath, defaultMode string, inboundPort, proxyPort, directPort int, edit func(map[string]any)) string {
	t.Helper()
	var config map[string]any
	if err := json.Unmarshal([]byte(read(t, routingFixture)), &config); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	config["inbounds"] = []any{map[string]any{
		"type": "mixed", "tag": "local-in", "listen": "127.0.0.1", "listen_port": inboundPort,
	}}
	config["outbounds"] = []any{
		map[string]any{"type": "socks", "tag": "proxy", "server": "127.0.0.1", "server_port": proxyPort},
		map[string]any{"type": "socks", "tag": "direct", "server": "127.0.0.1", "server_port": directPort},
	}
	config["route"].(map[string]any)["auto_detect_interface"] = false

	// dns-local asks the physical adapter's DNS servers. Here it answers offline instead.
	dns := config["dns"].(map[string]any)
	for i, server := range dns["servers"].([]any) {
		if server.(map[string]any)["tag"] == "dns-local" {
			dns["servers"].([]any)[i] = map[string]any{"type": "hosts", "tag": "dns-local"}
		}
	}

	experimental := config["experimental"].(map[string]any)
	if cachePath != "" {
		experimental["cache_file"] = map[string]any{"enabled": true, "path": cachePath}
	}
	if defaultMode != "" {
		experimental["clash_api"].(map[string]any)["default_mode"] = defaultMode
	}
	if edit != nil {
		edit(config)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return string(encoded)
}

type bareBox struct {
	ctx      context.Context
	instance *box.Box
}

// startBareBox is sing-box without the Tunnel wrapper: the control half of an A/B.
func startBareBox(t *testing.T, config string) bareBox {
	t.Helper()
	ctx := BaseContext(context.Background())
	options, err := parse(ctx, config)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		t.Fatalf("box.New: %v", err)
	}
	if err = instance.Start(); err != nil {
		_ = instance.Close()
		t.Fatalf("box Start: %v", err)
	}
	return bareBox{ctx: ctx, instance: instance}
}

func exchange(router adapter.DNSRouter, name string, qtype uint16) (*mDNS.Msg, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	message := new(mDNS.Msg)
	message.SetQuestion(name, qtype)
	return router.Exchange(ctx, message, adapter.DNSQueryOptions{})
}

func firstA(message *mDNS.Msg) netip.Addr {
	if message == nil {
		return netip.Addr{}
	}
	for _, record := range message.Answer {
		if a, ok := record.(*mDNS.A); ok {
			address, _ := netip.AddrFromSlice(a.A.To4())
			return address
		}
	}
	return netip.Addr{}
}

// sawDNSOverProxy reports whether the proxy outbound was asked to reach dns-proxy's server
// (8.8.8.8) within the wait — i.e. whether a DNS query went out through the tunnel.
func (h *harness) sawDNSOverProxy(wait time.Duration) bool {
	deadline := time.After(wait)
	for {
		select {
		case host := <-h.proxy.requests:
			if host == "8.8.8.8" {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

// route opens a connection to host through the tunnel, reports which outbound received it,
// and closes it again.
func (h *harness) route(t *testing.T, host string) string {
	t.Helper()
	connection, err := h.connect(host)
	if err != nil {
		t.Fatalf("connect %s: %v", host, err)
	}
	defer connection.Close()
	return h.await(t)
}

func (h *harness) await(t *testing.T) string {
	t.Helper()
	select {
	case <-h.proxy.requests:
		return "proxy"
	case <-h.direct.requests:
		return "direct"
	case <-time.After(5 * time.Second):
		t.Fatal("no outbound received the connection")
		return ""
	}
}

// connect speaks SOCKS5 to the tunnel's inbound and asks for host:443.
func (h *harness) connect(host string) (net.Conn, error) {
	connection, err := net.DialTimeout("tcp", h.inbound, 2*time.Second)
	if err != nil {
		return nil, err
	}
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	request := []byte{5, 1, 0, 5, 1, 0}
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		request = append(append(request, 1), ip.To4()...)
	} else {
		request = append(append(request, 3, byte(len(host))), host...)
	}
	request = append(request, 0x01, 0xbb)
	if _, err = connection.Write(request); err != nil {
		connection.Close()
		return nil, err
	}
	// Method selection, then the reply to CONNECT.
	reply := make([]byte, 2+4)
	if _, err = io.ReadFull(connection, reply); err != nil || reply[3] != 0 {
		connection.Close()
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	var rest int
	switch reply[5] {
	case 1:
		rest = 4 + 2
	case 4:
		rest = 16 + 2
	default:
		length := make([]byte, 1)
		if _, err = io.ReadFull(connection, length); err != nil {
			connection.Close()
			return nil, err
		}
		rest = int(length[0]) + 2
	}
	if _, err = io.ReadFull(connection, make([]byte, rest)); err != nil {
		connection.Close()
		return nil, err
	}
	_ = connection.SetDeadline(time.Time{})
	return connection, nil
}

// stillOpen reports whether a read on connection is still waiting after the given time.
func stillOpen(connection net.Conn, wait time.Duration) bool {
	_ = connection.SetReadDeadline(time.Now().Add(wait))
	_, err := connection.Read(make([]byte, 1))
	if netError, ok := err.(net.Error); ok && netError.Timeout() {
		_ = connection.SetReadDeadline(time.Time{})
		return true
	}
	return false
}

// socksRecorder is a SOCKS5 server that records each CONNECT and holds the connection open
// until the other side closes it, so a test can also see a connection being ended.
type socksRecorder struct {
	listener net.Listener
	requests chan string

	mu    sync.Mutex
	conns []net.Conn
}

func newSocksRecorder(t *testing.T) *socksRecorder {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	recorder := &socksRecorder{listener: listener, requests: make(chan string, 64)}
	go recorder.serve()
	t.Cleanup(func() {
		_ = listener.Close()
		recorder.mu.Lock()
		for _, connection := range recorder.conns {
			_ = connection.Close()
		}
		recorder.mu.Unlock()
	})
	return recorder
}

func (r *socksRecorder) port() int { return r.listener.Addr().(*net.TCPAddr).Port }

func (r *socksRecorder) serve() {
	for {
		connection, err := r.listener.Accept()
		if err != nil {
			return
		}
		r.mu.Lock()
		r.conns = append(r.conns, connection)
		r.mu.Unlock()
		go r.handle(connection)
	}
}

func (r *socksRecorder) handle(connection net.Conn) {
	defer connection.Close()
	header := make([]byte, 2)
	if _, err := io.ReadFull(connection, header); err != nil || header[0] != 5 {
		return
	}
	if _, err := io.ReadFull(connection, make([]byte, header[1])); err != nil {
		return
	}
	if _, err := connection.Write([]byte{5, 0}); err != nil {
		return
	}
	request := make([]byte, 4)
	if _, err := io.ReadFull(connection, request); err != nil {
		return
	}
	var host string
	switch request[3] {
	case 1, 4:
		size := 4
		if request[3] == 4 {
			size = 16
		}
		address := make([]byte, size)
		if _, err := io.ReadFull(connection, address); err != nil {
			return
		}
		host = net.IP(address).String()
	case 3:
		length := make([]byte, 1)
		if _, err := io.ReadFull(connection, length); err != nil {
			return
		}
		name := make([]byte, length[0])
		if _, err := io.ReadFull(connection, name); err != nil {
			return
		}
		host = string(name)
	default:
		return
	}
	if _, err := io.ReadFull(connection, make([]byte, 2)); err != nil {
		return
	}
	if _, err := connection.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	r.requests <- host
	_, _ = io.Copy(io.Discard, connection)
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
