package probe

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/urltest"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	singjson "github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/service"
)

// ============================================================================================
// Probe engine tests: a REAL local network, no mocks of the proxy path.
//
// One sing-box server box listens on loopback with an inbound per supported protocol (VLESS,
// VLESS+REALITY+Vision, VLESS-WS-TLS, VMess-WS-TLS, Trojan-WS-TLS, Shadowsocks, Hysteria2,
// TUIC) and a direct outbound. An HTTPS target answers HEAD with 204 after a fixed delay. Each
// probe therefore performs the full client handshake and authentication, and its URL test
// reaches the target ONLY through the server under test.
//
// Proxy outbounds are written in the exact shape the app's parser emits (compare
// core/testdata/configs), wrapped in the app's buildConfig shape - including its TUN inbound,
// which the probe must ignore.
//
// Run with the release tags, or QUIC/uTLS protocols are missing from the binary:
//
//	go test -tags "with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api" ./nexuscore/ -run Probe
//
// Nothing here touches routing, TUN or system DNS: every socket is on 127.0.0.1 and the only
// external command is a read-only `netstat`.
// ============================================================================================

const (
	probeTestHost        = "probe.test"
	probeTestRealitySNI  = "www.probe.test"
	probeTestUUID        = "6f1d5b52-6a35-4f0e-9b0e-2b8a1c3d4e5f"
	probeTestBadUUID     = "0e1d2c3b-4a59-4687-8796-a5b4c3d2e1f0"
	probeTestPassword    = "probe-test-password-7f3a"
	probeTestSSKey       = "probe-test-ss-key-91c2"
	probeTestShortID     = "ab"
	probeTestServerDelay = 30 * time.Millisecond
)

var probeTestKinds = []string{
	"vless", "vless-reality-vision", "vless-ws-tls", "vmess-ws", "trojan-ws", "shadowsocks", "hysteria2", "tuic",
}

var probeTestVocabulary = []string{
	probeOK, probeTimeout, probeRefused, probeUnreachable, probeDNSFailed, probeHandshakeFailed,
	probeRejected, probeConfigInvalid, probeCancelled, probeFailed,
}

func TestMain(m *testing.M) {
	code := m.Run()
	if probeHarnessValue != nil {
		probeHarnessValue.close()
	}
	os.Exit(code)
}

// --- harness --------------------------------------------------------------------------------

type probeHarness struct {
	certPEM, keyPEM string
	link            string
	target          *httptest.Server
	realityDest     *httptest.Server

	realityPrivate, realityPublic, realityWrongPublic string

	server  *box.Box
	ports   map[string]int
	deadTCP int
	deadUDP int

	blackhole      net.Listener
	blackholeMu    sync.Mutex
	blackholeConns []net.Conn

	requests       atomic.Int64
	inflight, peak atomic.Int32
	opened, closed atomic.Int64
}

var (
	probeHarnessOnce  sync.Once
	probeHarnessValue *probeHarness
	probeHarnessErr   error
	probeWarmOnce     sync.Once
)

func probeTestHarness(t *testing.T) *probeHarness {
	t.Helper()
	probeHarnessOnce.Do(func() { probeHarnessValue, probeHarnessErr = newProbeHarness() })
	if probeHarnessErr != nil {
		t.Fatalf("start harness: %v", probeHarnessErr)
	}
	return probeHarnessValue
}

func newProbeHarness() (*probeHarness, error) {
	h := &probeHarness{ports: make(map[string]int)}
	certificate, err := h.makeCertificate()
	if err != nil {
		return nil, err
	}

	h.target = httptest.NewUnstartedServer(http.HandlerFunc(h.serveTarget))
	h.target.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
	h.target.Config.ErrorLog = log.New(io.Discard, "", 0) // aborted handshakes are expected here
	h.target.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		switch state {
		case http.StateNew:
			h.opened.Add(1)
		case http.StateClosed, http.StateHijacked:
			h.closed.Add(1)
		}
	}
	h.target.StartTLS()
	h.link = "https://" + h.target.Listener.Addr().String() + "/generate_204"

	// REALITY borrows a real TLS 1.3 handshake from this server.
	h.realityDest = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	h.realityDest.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13}
	h.realityDest.Config.ErrorLog = log.New(io.Discard, "", 0)
	h.realityDest.StartTLS()
	realityDestPort := h.realityDest.Listener.Addr().(*net.TCPAddr).Port

	private, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	other, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	h.realityPrivate = base64.RawURLEncoding.EncodeToString(private.Bytes())
	h.realityPublic = base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes())
	h.realityWrongPublic = base64.RawURLEncoding.EncodeToString(other.PublicKey().Bytes())

	for _, kind := range probeTestKinds {
		if kind == "hysteria2" || kind == "tuic" {
			h.ports[kind], err = probeFreeUDPPort()
		} else {
			h.ports[kind], err = probeFreeTCPPort()
		}
		if err != nil {
			return nil, err
		}
	}
	if h.deadTCP, err = probeFreeTCPPort(); err != nil {
		return nil, err
	}
	if h.deadUDP, err = probeFreeUDPPort(); err != nil {
		return nil, err
	}
	if h.blackhole, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		return nil, err
	}
	go h.swallow()

	tlsIn := map[string]any{
		"enabled": true, "server_name": probeTestHost,
		"certificate": []string{h.certPEM}, "key": []string{h.keyPEM},
	}
	inbound := func(kind string, fields map[string]any) map[string]any {
		fields["tag"] = kind
		fields["listen"] = "127.0.0.1"
		fields["listen_port"] = h.ports[kind]
		return fields
	}
	user := map[string]any{"name": "u", "uuid": probeTestUUID}
	inbounds := []any{
		inbound("vless", map[string]any{"type": "vless", "users": []any{user}}),
		inbound("vless-reality-vision", map[string]any{
			"type":  "vless",
			"users": []any{map[string]any{"name": "u", "uuid": probeTestUUID, "flow": "xtls-rprx-vision"}},
			"tls": map[string]any{
				"enabled": true, "server_name": probeTestRealitySNI,
				"reality": map[string]any{
					"enabled":     true,
					"handshake":   map[string]any{"server": "127.0.0.1", "server_port": realityDestPort},
					"private_key": h.realityPrivate,
					"short_id":    []string{probeTestShortID},
				},
			},
		}),
		inbound("vless-ws-tls", map[string]any{
			"type": "vless", "users": []any{user}, "tls": tlsIn,
			"transport": map[string]any{"type": "ws", "path": "/ws"},
		}),
		inbound("vmess-ws", map[string]any{
			"type": "vmess", "users": []any{map[string]any{"name": "u", "uuid": probeTestUUID, "alterId": 0}}, "tls": tlsIn,
			"transport": map[string]any{"type": "ws", "path": "/vm"},
		}),
		inbound("trojan-ws", map[string]any{
			"type": "trojan", "users": []any{map[string]any{"name": "u", "password": probeTestPassword}}, "tls": tlsIn,
			"transport": map[string]any{"type": "ws", "path": "/tr"},
		}),
		inbound("shadowsocks", map[string]any{
			"type": "shadowsocks", "network": "tcp", "method": "aes-256-gcm", "password": probeTestSSKey,
		}),
		inbound("hysteria2", map[string]any{
			"type": "hysteria2", "users": []any{map[string]any{"name": "u", "password": probeTestPassword}}, "tls": tlsIn,
		}),
		inbound("tuic", map[string]any{
			"type":               "tuic",
			"users":              []any{map[string]any{"name": "u", "uuid": probeTestUUID, "password": probeTestPassword}},
			"congestion_control": "bbr", "tls": tlsIn,
		}),
	}
	h.server, _, err = probeTestBox(map[string]any{
		"log":       map[string]any{"disabled": true},
		"inbounds":  inbounds,
		"outbounds": []any{map[string]any{"type": "direct", "tag": "direct"}},
	})
	if err != nil {
		return nil, fmt.Errorf("server box: %w", err)
	}
	return h, nil
}

func (h *probeHarness) close() {
	h.server.Close()
	h.blackhole.Close()
	h.blackholeMu.Lock()
	for _, conn := range h.blackholeConns {
		conn.Close()
	}
	h.blackholeMu.Unlock()
	h.target.Close()
	h.realityDest.Close()
}

// serveTarget is generate_204 with a fixed delay, so a measured Delay must include it.
func (h *probeHarness) serveTarget(w http.ResponseWriter, _ *http.Request) {
	h.requests.Add(1)
	n := h.inflight.Add(1)
	for {
		peak := h.peak.Load()
		if n <= peak || h.peak.CompareAndSwap(peak, n) {
			break
		}
	}
	time.Sleep(probeTestServerDelay)
	h.inflight.Add(-1)
	w.WriteHeader(http.StatusNoContent)
}

// swallow accepts and never answers: the blackhole. Held connections need no goroutine.
func (h *probeHarness) swallow() {
	for {
		conn, err := h.blackhole.Accept()
		if err != nil {
			return
		}
		h.blackholeMu.Lock()
		h.blackholeConns = append(h.blackholeConns, conn)
		h.blackholeMu.Unlock()
	}
}

func (h *probeHarness) makeCertificate() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: probeTestHost},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{probeTestHost, probeTestRealitySNI},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	h.certPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	h.keyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	return tls.X509KeyPair([]byte(h.certPEM), []byte(h.keyPEM))
}

// outbound is the proxy outbound for kind, in the shape the app's link parser emits.
func (h *probeHarness) outbound(kind, server string) map[string]any {
	tlsOut := func() map[string]any { return map[string]any{"enabled": true, "server_name": probeTestHost} }
	o := map[string]any{"tag": "proxy", "server": server, "server_port": h.ports[kind]}
	switch kind {
	case "vless":
		o["type"], o["uuid"] = "vless", probeTestUUID
	case "vless-reality-vision":
		o["type"], o["uuid"], o["flow"] = "vless", probeTestUUID, "xtls-rprx-vision"
		o["tls"] = map[string]any{
			"enabled": true, "server_name": probeTestRealitySNI,
			"utls":    map[string]any{"enabled": true, "fingerprint": "chrome"},
			"reality": map[string]any{"enabled": true, "public_key": h.realityPublic, "short_id": probeTestShortID},
		}
	case "vless-ws-tls":
		o["type"], o["uuid"], o["tls"] = "vless", probeTestUUID, tlsOut()
		o["transport"] = map[string]any{"type": "ws", "path": "/ws", "headers": map[string]any{"Host": probeTestHost}}
	case "vmess-ws":
		o["type"], o["uuid"], o["security"], o["alter_id"] = "vmess", probeTestUUID, "auto", 0
		tlsConfig := tlsOut()
		tlsConfig["utls"] = map[string]any{"enabled": true, "fingerprint": "chrome"}
		o["tls"] = tlsConfig
		o["transport"] = map[string]any{"type": "ws", "path": "/vm", "headers": map[string]any{"Host": probeTestHost}}
	case "trojan-ws":
		o["type"], o["password"], o["tls"] = "trojan", probeTestPassword, tlsOut()
		o["transport"] = map[string]any{"type": "ws", "path": "/tr"}
	case "shadowsocks":
		o["type"], o["method"], o["password"] = "shadowsocks", "aes-256-gcm", probeTestSSKey
	case "hysteria2":
		o["type"], o["password"], o["tls"] = "hysteria2", probeTestPassword, tlsOut()
	case "tuic":
		o["type"], o["uuid"], o["password"], o["tls"] = "tuic", probeTestUUID, probeTestPassword, tlsOut()
		o["congestion_control"] = "bbr"
	default:
		panic("unknown kind " + kind)
	}
	return o
}

// options is the production configuration plus the seams that point it at the harness:
// its link, its CA, and a policy that admits loopback (and nothing else the real one refuses).
func (h *probeHarness) options(t *testing.T, resolver *probeFakeResolver, timeout time.Duration) probeOptions {
	t.Helper()
	platform := new(probePlatform)
	t.Cleanup(func() {
		if n := platform.openInterfaceCalls.Load(); n != 0 {
			t.Errorf("the probe asked the platform for a TUN %d time(s)", n)
		}
	})
	return probeOptions{
		workers:  probeDefaultWorkers,
		timeout:  timeout,
		resolve:  resolver.Resolve,
		link:     h.link,
		extraCA:  []string{h.certPEM},
		usable:   probeTestUsable,
		platform: platform,
		inspect: func(instance *box.Box, dns adapter.DNSTransportManager) {
			probeCheckEmptyBox(t, instance, dns)
		},
	}
}

// expectTargetConnsClosed waits for every connection that reached the target to be closed.
func (h *probeHarness) expectTargetConnsClosed(t *testing.T) {
	t.Helper()
	if !probeWaitFor(10*time.Second, func() bool { return h.opened.Load() == h.closed.Load() }) {
		t.Errorf("target connections: %d opened, %d closed", h.opened.Load(), h.closed.Load())
	}
}

func probeTestUsable(addr netip.Addr) bool {
	return addr.Unmap().IsLoopback() || probeUsableAddress(addr)
}

// probeCheckEmptyBox runs after a run's last probe, before Close: nothing may be left behind,
// and nothing may ever have been listening.
func probeCheckEmptyBox(t *testing.T, instance *box.Box, dns adapter.DNSTransportManager) {
	if n := len(instance.Inbound().Inbounds()); n != 0 {
		t.Errorf("probe box has %d inbound(s)", n)
	}
	if n := len(instance.Endpoint().Endpoints()); n != 0 {
		t.Errorf("probe box has %d endpoint(s)", n)
	}
	for _, outbound := range instance.Outbound().Outbounds() {
		if strings.HasPrefix(outbound.Tag(), "probe-") {
			t.Errorf("outbound %s was left in the probe box", outbound.Tag())
		}
	}
	for _, transport := range dns.Transports() {
		if transport.Tag() != "probe-none" {
			t.Errorf("DNS server %s was left in the probe box", transport.Tag())
		}
	}
}

// probeTestNodeConfig wraps a proxy outbound the way clients/web singboxConfig.ts buildConfig does.
func probeTestNodeConfig(outbound map[string]any) string {
	server, _ := outbound["server"].(string)
	content, err := json.Marshal(map[string]any{
		"log": map[string]any{"level": "info", "timestamp": true},
		"dns": map[string]any{
			"servers": []any{
				map[string]any{"type": "fakeip", "tag": "dns-fake", "inet4_range": "198.18.0.0/15"},
				map[string]any{"type": "https", "tag": "dns-proxy", "server": "8.8.8.8", "detour": "proxy"},
				map[string]any{"type": "https", "tag": "dns-direct", "server": "1.1.1.1"},
			},
			"rules": []any{
				map[string]any{"domain": []string{server}, "server": "dns-direct"},
				map[string]any{"query_type": []string{"A", "AAAA"}, "server": "dns-fake"},
			},
			"final": "dns-proxy", "strategy": "prefer_ipv4", "independent_cache": true,
		},
		"inbounds": []any{map[string]any{
			"type": "tun", "tag": "tun-in", "address": []string{"172.19.0.1/30", "fdfe:dcba:9876::1/126"},
			"mtu": 9000, "auto_route": true, "strict_route": false, "stack": "gvisor",
		}},
		"outbounds": []any{outbound, map[string]any{"type": "direct", "tag": "direct"}},
		"route": map[string]any{
			"auto_detect_interface":   true,
			"default_domain_resolver": map[string]any{"server": "dns-direct", "strategy": "prefer_ipv4"},
			"rules":                   []any{map[string]any{"action": "sniff"}},
			"final":                   "proxy",
		},
	})
	if err != nil {
		panic(err)
	}
	return string(content)
}

func probeTestTarget(id string, outbound map[string]any) probeTarget {
	return probeTarget{ID: id, Fingerprint: "fp-" + id, Config: probeTestNodeConfig(outbound)}
}

// probeTestBox starts a box with the probe's platform stub (no OS monitors) and returns it with
// the context that carries its services.
func probeTestBox(config map[string]any) (*box.Box, context.Context, error) {
	content, err := json.Marshal(config)
	if err != nil {
		return nil, nil, err
	}
	ctx := box.Context(context.Background(), include.InboundRegistry(), include.OutboundRegistry(),
		include.EndpointRegistry(), include.DNSTransportRegistry(), include.ServiceRegistry(),
		include.CertificateProviderRegistry())
	ctx = service.ContextWith[adapter.PlatformInterface](ctx, adapter.PlatformInterface(new(probePlatform)))
	options, err := singjson.UnmarshalExtendedContext[option.Options](ctx, content)
	if err != nil {
		return nil, nil, err
	}
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		return nil, nil, err
	}
	if err = instance.Start(); err != nil {
		instance.Close()
		return nil, nil, err
	}
	return instance, ctx, nil
}

type probeFakeResolver struct {
	mu      sync.Mutex
	answers map[string]string
	calls   map[string]int
	gate    chan struct{} // non-nil: Resolve blocks until it is closed
}

func newProbeResolver() *probeFakeResolver {
	return &probeFakeResolver{
		answers: map[string]string{probeTestHost: "127.0.0.1"},
		calls:   make(map[string]int),
	}
}

func (f *probeFakeResolver) Resolve(host string) string {
	f.mu.Lock()
	f.calls[host]++
	gate, answer := f.gate, f.answers[host]
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	return answer
}

func (f *probeFakeResolver) count(host string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[host]
}

func probeCollect(t *testing.T, ctx context.Context, targets []probeTarget, options probeOptions) map[string]probeResult {
	t.Helper()
	var mu sync.Mutex
	results := make(map[string]probeResult)
	runProbe(ctx, targets, options, func(result probeResult) {
		mu.Lock()
		defer mu.Unlock()
		if _, duplicate := results[result.id]; duplicate {
			t.Errorf("two results for %s", result.id)
		}
		results[result.id] = result
	})
	return results
}

func probeWithField(o map[string]any, path string, value any) map[string]any {
	parts := strings.Split(path, ".")
	current := o
	for _, part := range parts[:len(parts)-1] {
		current = current[part].(map[string]any)
	}
	if value == nil {
		delete(current, parts[len(parts)-1])
	} else {
		current[parts[len(parts)-1]] = value
	}
	return o
}

func probeFreeTCPPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func probeFreeUDPPort() (int, error) {
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port, nil
}

func probeWaitFor(timeout time.Duration, condition func() bool) bool {
	deadline := time.Now().Add(timeout)
	for {
		if condition() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// probeWarm runs one successful batch, so lazily started library goroutines exist before any
// test takes a goroutine baseline.
func probeWarm(t *testing.T, h *probeHarness) {
	t.Helper()
	probeWarmOnce.Do(func() {
		var targets []probeTarget
		for _, kind := range probeTestKinds {
			targets = append(targets, probeTestTarget(kind, h.outbound(kind, probeTestHost)))
		}
		probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 5*time.Second))
		h.expectTargetConnsClosed(t)
	})
}

// probeBaseline is the settled goroutine count: unchanged for 300 ms.
func probeBaseline() int {
	last, stable := runtime.NumGoroutine(), 0
	for i := 0; i < 200 && stable < 6; i++ {
		time.Sleep(50 * time.Millisecond)
		if n := runtime.NumGoroutine(); n == last {
			stable++
		} else {
			last, stable = n, 0
		}
	}
	return last
}

func probeExpectGoroutines(t *testing.T, baseline int) int {
	t.Helper()
	probeWaitFor(10*time.Second, func() bool { return runtime.NumGoroutine() <= baseline })
	n := runtime.NumGoroutine()
	if n > baseline {
		stacks := make([]byte, 1<<20)
		stacks = stacks[:runtime.Stack(stacks, true)]
		if len(stacks) > 30000 {
			stacks = stacks[:30000]
		}
		t.Errorf("%d goroutines remain, baseline %d:\n%s", n, baseline, stacks)
	}
	return n
}

// probeSockets lists this process's sockets from `netstat -ano` (read-only). listening: TCP
// sockets with no remote end; otherwise: bound UDP sockets.
func probeSockets(t *testing.T, listening bool) []string {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("the socket census reads netstat -ano (Windows)")
	}
	protocol := "UDP"
	if listening {
		protocol = "TCP"
	}
	pid := strconv.Itoa(os.Getpid())
	var sockets []string
	for _, family := range []string{protocol, protocol + "v6"} {
		out, err := exec.Command("netstat", "-ano", "-p", family).Output()
		if err != nil {
			t.Fatalf("netstat: %v", err)
		}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 4 || !strings.HasPrefix(fields[0], protocol) || fields[len(fields)-1] != pid {
				continue
			}
			// Language-independent: a listening TCP socket has no remote end.
			if listening && fields[2] != "0.0.0.0:0" && fields[2] != "[::]:0" {
				continue
			}
			sockets = append(sockets, fields[0]+" "+fields[1])
		}
	}
	slices.Sort(sockets)
	return sockets
}

func probeInterfaceNames(t *testing.T) []string {
	t.Helper()
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatalf("interfaces: %v", err)
	}
	names := make([]string, 0, len(interfaces))
	for _, i := range interfaces {
		names = append(names, i.Name)
	}
	slices.Sort(names)
	return names
}

// --- 1. success, every protocol -------------------------------------------------------------

func TestProbeEveryProtocolSucceeds(t *testing.T) {
	h := probeTestHarness(t)
	resolver := newProbeResolver()
	var targets []probeTarget
	for _, kind := range probeTestKinds {
		targets = append(targets, probeTestTarget(kind, h.outbound(kind, probeTestHost)))
	}
	targets = append(targets, probeTestTarget("vless-ip-literal", h.outbound("vless", "127.0.0.1")))

	before := h.requests.Load()
	results := probeCollect(t, context.Background(), targets, h.options(t, resolver, 5*time.Second))
	floor := int32(probeTestServerDelay / time.Millisecond)
	for _, target := range targets {
		result, ok := results[target.ID]
		if !ok {
			t.Errorf("%s: no result", target.ID)
			continue
		}
		t.Logf("%-22s %-8s %4d ms", target.ID, result.status, result.delayMs)
		if result.status != probeOK {
			t.Errorf("%s: status %s, want ok", target.ID, result.status)
			continue
		}
		if result.fingerprint != target.Fingerprint {
			t.Errorf("%s: fingerprint %q, want %q", target.ID, result.fingerprint, target.Fingerprint)
		}
		if result.delayMs < floor || result.delayMs >= 5000 {
			t.Errorf("%s: delay %d ms, want >= %d (the target's own delay) and < the timeout", target.ID, result.delayMs, floor)
		}
	}
	if got := h.requests.Load() - before; got != int64(len(targets)) {
		t.Errorf("target answered %d requests, want %d: exactly one URL test per server", got, len(targets))
	}
	if n := resolver.count(probeTestHost); n != 1 {
		t.Errorf("%s resolved %d times in one run, want once for all servers on it", probeTestHost, n)
	}
}

// --- 2. wrong credentials -------------------------------------------------------------------

func TestProbeWrongCredentialsFail(t *testing.T) {
	h := probeTestHarness(t)
	rejected := []string{probeRejected}
	rejectedOrTimeout := []string{probeRejected, probeTimeout}
	cases := []struct {
		id, kind, field string
		value           any
		want            []string // empty: any failure
	}{
		{"vless-bad-uuid", "vless", "uuid", probeTestBadUUID, rejected},
		{"reality-bad-uuid", "vless-reality-vision", "uuid", probeTestBadUUID, rejected},
		{"reality-bad-public-key", "vless-reality-vision", "tls.reality.public_key", h.realityWrongPublic, []string{probeHandshakeFailed}},
		{"reality-bad-short-id", "vless-reality-vision", "tls.reality.short_id", "cd", []string{probeHandshakeFailed}},
		{"vless-ws-bad-uuid", "vless-ws-tls", "uuid", probeTestBadUUID, rejected},
		// VMess and Shadowsocks servers may drain a bad request before closing, which can
		// outlast the timeout instead.
		{"vmess-bad-uuid", "vmess-ws", "uuid", probeTestBadUUID, rejectedOrTimeout},
		{"trojan-bad-password", "trojan-ws", "password", "wrong-password", rejected},
		{"ss-bad-password", "shadowsocks", "password", "wrong-password", rejectedOrTimeout},
		{"hysteria2-bad-password", "hysteria2", "password", "wrong-password", rejected},
		{"tuic-bad-password", "tuic", "password", "wrong-password", rejected},
		{"tuic-bad-uuid", "tuic", "uuid", probeTestBadUUID, rejected},
	}
	var targets []probeTarget
	for _, c := range cases {
		targets = append(targets, probeTestTarget(c.id, probeWithField(h.outbound(c.kind, probeTestHost), c.field, c.value)))
	}
	before := h.requests.Load()
	results := probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 3*time.Second))
	for _, c := range cases {
		result := results[c.id]
		t.Logf("%-24s %s", c.id, result.status)
		switch {
		case result.status == probeOK || result.status == probeCancelled || result.status == probeConfigInvalid || result.status == "":
			t.Errorf("%s: status %q, want a failure", c.id, result.status)
		case len(c.want) > 0 && !slices.Contains(c.want, result.status):
			t.Errorf("%s: status %s, want one of %v", c.id, result.status, c.want)
		}
		if result.delayMs != 0 {
			t.Errorf("%s: a failure reported a delay of %d ms", c.id, result.delayMs)
		}
	}
	if got := h.requests.Load() - before; got != 0 {
		t.Errorf("target answered %d requests through servers that refused the credentials", got)
	}
}

// --- 3. dead server / 4. blackhole ----------------------------------------------------------

func TestProbeDeadServer(t *testing.T) {
	h := probeTestHarness(t)
	targets := []probeTarget{
		probeTestTarget("vless-dead", probeWithField(h.outbound("vless", probeTestHost), "server_port", h.deadTCP)),
		probeTestTarget("trojan-dead", probeWithField(h.outbound("trojan-ws", probeTestHost), "server_port", h.deadTCP)),
		probeTestTarget("hysteria2-dead", probeWithField(h.outbound("hysteria2", probeTestHost), "server_port", h.deadUDP)),
		probeTestTarget("tuic-dead", probeWithField(h.outbound("tuic", probeTestHost), "server_port", h.deadUDP)),
	}
	results := probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 2*time.Second))
	for _, target := range targets {
		t.Logf("%-16s %s", target.ID, results[target.ID].status)
	}
	for _, id := range []string{"vless-dead", "trojan-dead"} {
		if status := results[id].status; status != probeRefused {
			t.Errorf("%s: status %s, want refused", id, status)
		}
	}
	for _, id := range []string{"hysteria2-dead", "tuic-dead"} {
		// UDP has no refusal on the wire QUIC acts on; the attempt simply never completes.
		if status := results[id].status; status == probeOK || status == probeCancelled || status == "" {
			t.Errorf("%s: status %q, want a failure", id, status)
		}
	}
}

func TestProbeBlackholeTimesOut(t *testing.T) {
	h := probeTestHarness(t)
	port := h.blackhole.Addr().(*net.TCPAddr).Port
	targets := []probeTarget{
		probeTestTarget("vless-blackhole", probeWithField(h.outbound("vless", probeTestHost), "server_port", port)),
		probeTestTarget("vmess-blackhole", probeWithField(h.outbound("vmess-ws", probeTestHost), "server_port", port)),
		probeTestTarget("trojan-blackhole", probeWithField(h.outbound("trojan-ws", probeTestHost), "server_port", port)),
	}
	const timeout = 1500 * time.Millisecond
	start := time.Now()
	results := probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), timeout))
	elapsed := time.Since(start)
	for _, target := range targets {
		if status := results[target.ID].status; status != probeTimeout {
			t.Errorf("%s: status %s, want timeout", target.ID, status)
		}
	}
	if elapsed < timeout-100*time.Millisecond || elapsed > timeout+2*time.Second {
		t.Errorf("run took %v with a %v per-server timeout", elapsed, timeout)
	}
	t.Logf("3 blackholed servers, %v timeout each, run took %v", timeout, elapsed.Round(time.Millisecond))
}

// --- 5. malformed configs / address policy --------------------------------------------------

func TestProbeRejectsMalformedConfigs(t *testing.T) {
	h := probeTestHarness(t)
	node := func(field string, value any) string {
		return probeTestNodeConfig(probeWithField(h.outbound("vless", "127.0.0.1"), field, value))
	}
	configs := map[string]string{
		"not-json":             "{not json",
		"empty-object":         "{}",
		"outbounds-not-array":  `{"outbounds":{"tag":"proxy"}}`,
		"no-proxy-outbound":    `{"outbounds":[{"type":"direct","tag":"direct"}]}`,
		"proxy-is-direct":      `{"outbounds":[{"type":"direct","tag":"proxy","server":"127.0.0.1"}]}`,
		"proxy-without-server": node("server", nil),
		"unknown-type":         node("type", "nope"),
		// (Not a bad uuid: VLESS maps any non-UUID string to a UUIDv5 id, as Xray does, so
		// that is a wrong credential, not a malformed config.)
		"unknown-ss-method": probeTestNodeConfig(probeWithField(h.outbound("shadowsocks", "127.0.0.1"), "method", "nope-cipher")),
		"bad-reality-key":   probeTestNodeConfig(probeWithField(h.outbound("vless-reality-vision", "127.0.0.1"), "tls.reality.public_key", "!!!")),
		"port-not-a-number": node("server_port", "x"),
		"detour":            node("detour", "direct"),
	}
	var targets []probeTarget
	for id, config := range configs {
		targets = append(targets, probeTarget{ID: id, Fingerprint: "fp-" + id, Config: config})
	}
	resolver := newProbeResolver()
	start := time.Now()
	results := probeCollect(t, context.Background(), targets, h.options(t, resolver, 5*time.Second))
	for id := range configs {
		if status := results[id].status; status != probeConfigInvalid {
			t.Errorf("%s: status %s, want config_invalid", id, status)
		}
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("rejecting %d malformed configs took %v; none of them should dial", len(configs), elapsed)
	}
	if n := resolver.count(probeTestHost); n != 0 {
		t.Errorf("a malformed config was resolved %d times", n)
	}
}

// The production address policy (options.usable == nil), same as ConfigGuard: no probe may be
// pointed at loopback, private, link-local, multicast or unspecified addresses.
func TestProbeRefusesPrivateAndLocalServers(t *testing.T) {
	h := probeTestHarness(t)
	literals := []string{"127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1"}
	var targets []probeTarget
	for _, literal := range literals {
		targets = append(targets, probeTestTarget("literal-"+literal, h.outbound("vless", literal)))
	}
	targets = append(targets, probeTestTarget("host-to-loopback", h.outbound("vless", probeTestHost)))

	options := h.options(t, newProbeResolver(), 3*time.Second)
	options.usable = nil
	before := h.requests.Load()
	results := probeCollect(t, context.Background(), targets, options)
	for _, literal := range literals {
		if status := results["literal-"+literal].status; status != probeConfigInvalid {
			t.Errorf("server %s: status %s, want config_invalid", literal, status)
		}
	}
	if status := results["host-to-loopback"].status; status != probeDNSFailed {
		t.Errorf("hostname answered with loopback: status %s, want dns_failed", status)
	}
	if got := h.requests.Load() - before; got != 0 {
		t.Errorf("%d requests reached a refused address", got)
	}
}

// --- 6. DNS ---------------------------------------------------------------------------------

func TestProbeDNSFailures(t *testing.T) {
	h := probeTestHarness(t)
	resolver := newProbeResolver()
	resolver.answers["nx.probe.test"] = ""
	resolver.answers["garbage.probe.test"] = "not-an-ip, also-not"
	resolver.answers["poisoned.probe.test"] = "10.0.0.1,192.168.0.1,169.254.0.1,0.0.0.0,224.0.0.1,fe80::1,fd00::1"
	// One poisoned answer among usable ones is filtered, not fatal (ConfigGuard keeps the rest).
	resolver.answers["mixed.probe.test"] = "10.0.0.1, 127.0.0.1"
	resolver.answers["shared.probe.test"] = "127.0.0.1"

	targets := []probeTarget{
		probeTestTarget("nx", h.outbound("vless", "nx.probe.test")),
		probeTestTarget("garbage", h.outbound("vless", "garbage.probe.test")),
		probeTestTarget("poisoned", h.outbound("vless", "poisoned.probe.test")),
		probeTestTarget("mixed", h.outbound("vless", "mixed.probe.test")),
	}
	for i := range 3 {
		targets = append(targets, probeTestTarget(fmt.Sprintf("shared-%d", i), h.outbound("vless", "shared.probe.test")))
	}
	results := probeCollect(t, context.Background(), targets, h.options(t, resolver, 5*time.Second))
	for _, id := range []string{"nx", "garbage", "poisoned"} {
		if status := results[id].status; status != probeDNSFailed {
			t.Errorf("%s: status %s, want dns_failed", id, status)
		}
	}
	for _, id := range []string{"mixed", "shared-0", "shared-1", "shared-2"} {
		if status := results[id].status; status != probeOK {
			t.Errorf("%s: status %s, want ok", id, status)
		}
	}
	if n := resolver.count("shared.probe.test"); n != 1 {
		t.Errorf("a hostname shared by 3 servers was resolved %d times, want 1", n)
	}
}

// --- 7. cancellation ------------------------------------------------------------------------

func TestProbeCancellation(t *testing.T) {
	h := probeTestHarness(t)
	port := h.blackhole.Addr().(*net.TCPAddr).Port

	t.Run("in flight", func(t *testing.T) {
		var targets []probeTarget
		for i := range 12 {
			targets = append(targets, probeTestTarget(fmt.Sprintf("blackhole-%d", i),
				probeWithField(h.outbound("vless", probeTestHost), "server_port", port)))
		}
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(300*time.Millisecond, cancel)
		start := time.Now()
		results := probeCollect(t, ctx, targets, h.options(t, newProbeResolver(), 20*time.Second))
		elapsed := time.Since(start)
		if elapsed > 2300*time.Millisecond {
			t.Errorf("cancelled run returned after %v", elapsed)
		}
		if len(results) != probeDefaultWorkers {
			t.Errorf("%d results, want %d (the in-flight servers; the rest never start)", len(results), probeDefaultWorkers)
		}
		for id, result := range results {
			if result.status != probeCancelled {
				t.Errorf("%s: status %s, want cancelled", id, result.status)
			}
		}
		t.Logf("cancel at 300 ms; run returned at %v", elapsed.Round(time.Millisecond))
	})

	t.Run("during DNS", func(t *testing.T) {
		resolver := newProbeResolver()
		resolver.gate = make(chan struct{})
		defer close(resolver.gate)
		targets := []probeTarget{
			probeTestTarget("slow-dns-0", h.outbound("vless", probeTestHost)),
			probeTestTarget("slow-dns-1", h.outbound("trojan-ws", probeTestHost)),
		}
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(200*time.Millisecond, cancel)
		start := time.Now()
		results := probeCollect(t, ctx, targets, h.options(t, resolver, 20*time.Second))
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Errorf("a run stuck in DNS returned %v after cancel", elapsed)
		}
		for id, result := range results {
			if result.status != probeCancelled {
				t.Errorf("%s: status %s, want cancelled", id, result.status)
			}
		}
	})
}

// --- 8. many at once ------------------------------------------------------------------------

func TestProbeManySimultaneous(t *testing.T) {
	h := probeTestHarness(t)
	var targets []probeTarget
	for round := range 3 {
		for _, kind := range probeTestKinds {
			targets = append(targets, probeTestTarget(fmt.Sprintf("%s-%d", kind, round), h.outbound(kind, probeTestHost)))
		}
	}
	h.peak.Store(0)
	start := time.Now()
	results := probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 10*time.Second))
	elapsed := time.Since(start)
	for _, target := range targets {
		if status := results[target.ID].status; status != probeOK {
			t.Errorf("%s: status %s, want ok", target.ID, status)
		}
	}
	peak := h.peak.Load()
	if peak > probeDefaultWorkers || peak < 2 {
		t.Errorf("peak concurrent URL tests %d, want 2..%d", peak, probeDefaultWorkers)
	}
	t.Logf("%d servers, %d workers: peak %d concurrent URL tests, run took %v", len(targets), probeDefaultWorkers, peak, elapsed.Round(time.Millisecond))
}

// --- 9-12. cleanup and growth ---------------------------------------------------------------

func probeTestMixedFailures(h *probeHarness) []probeTarget {
	port := h.blackhole.Addr().(*net.TCPAddr).Port
	return []probeTarget{
		probeTestTarget("f-wrong-uuid", probeWithField(h.outbound("vless", probeTestHost), "uuid", probeTestBadUUID)),
		probeTestTarget("f-wrong-hy2", probeWithField(h.outbound("hysteria2", probeTestHost), "password", "nope")),
		probeTestTarget("f-wrong-reality", probeWithField(h.outbound("vless-reality-vision", probeTestHost), "tls.reality.public_key", h.realityWrongPublic)),
		probeTestTarget("f-dead", probeWithField(h.outbound("vless", probeTestHost), "server_port", h.deadTCP)),
		probeTestTarget("f-blackhole", probeWithField(h.outbound("trojan-ws", probeTestHost), "server_port", port)),
		probeTestTarget("f-dns", h.outbound("vless", "nx.probe.test")),
		{ID: "f-malformed", Fingerprint: "fp", Config: "{"},
	}
}

func TestProbeCleansUpAfterSuccess(t *testing.T) {
	h := probeTestHarness(t)
	probeWarm(t, h)
	baseline := probeBaseline()
	var udpBefore []string
	if runtime.GOOS == "windows" {
		udpBefore = probeSockets(t, false)
	}
	var targets []probeTarget
	for _, kind := range probeTestKinds {
		targets = append(targets, probeTestTarget(kind, h.outbound(kind, probeTestHost)))
	}
	results := probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 5*time.Second))
	for _, target := range targets {
		if results[target.ID].status != probeOK {
			t.Fatalf("%s: %s", target.ID, results[target.ID].status)
		}
	}
	h.expectTargetConnsClosed(t)
	probeExpectGoroutines(t, baseline)
	if runtime.GOOS == "windows" {
		var udpAfter []string
		probeWaitFor(5*time.Second, func() bool {
			udpAfter = probeSockets(t, false)
			return slices.Equal(udpBefore, udpAfter)
		})
		if !slices.Equal(udpBefore, udpAfter) {
			t.Errorf("UDP sockets before %v, after %v: a QUIC client socket was left open", udpBefore, udpAfter)
		}
	}
}

func TestProbeCleansUpAfterFailure(t *testing.T) {
	h := probeTestHarness(t)
	probeWarm(t, h)
	baseline := probeBaseline()
	targets := probeTestMixedFailures(h)
	results := probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 1500*time.Millisecond))
	for _, target := range targets {
		if status := results[target.ID].status; status == probeOK || status == "" {
			t.Errorf("%s: status %q, want a failure", target.ID, status)
		}
	}
	h.expectTargetConnsClosed(t)
	probeExpectGoroutines(t, baseline)
}

func TestProbeCleansUpAfterCancel(t *testing.T) {
	h := probeTestHarness(t)
	probeWarm(t, h)
	baseline := probeBaseline()
	resolver := newProbeResolver()
	resolver.answers["gated.probe.test"] = "127.0.0.1"
	gate := make(chan struct{})
	var targets []probeTarget
	for _, kind := range probeTestKinds {
		targets = append(targets, probeTestTarget(kind, h.outbound(kind, probeTestHost)))
	}
	targets = append(targets, probeTestMixedFailures(h)...)
	targets = append(targets, probeTestTarget("gated", h.outbound("vless", "gated.probe.test")))
	options := h.options(t, resolver, 10*time.Second)
	options.resolve = func(host string) string {
		if host == "gated.probe.test" {
			<-gate
		}
		return resolver.Resolve(host)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(150*time.Millisecond, cancel)
	results := probeCollect(t, ctx, targets, options)
	close(gate) // the abandoned platform lookup returns; its goroutine must then end
	t.Logf("cancelled after 150 ms with %d of %d results", len(results), len(targets))
	h.expectTargetConnsClosed(t)
	probeExpectGoroutines(t, baseline)
}

func TestProbeRepeatedRunsDoNotGrow(t *testing.T) {
	h := probeTestHarness(t)
	probeWarm(t, h)
	baseline := probeBaseline()
	var stats runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&stats)
	heapStart := stats.HeapInuse

	counts := make([]int, 0, 10)
	for range 10 {
		var targets []probeTarget
		for _, kind := range probeTestKinds {
			targets = append(targets, probeTestTarget(kind, h.outbound(kind, probeTestHost)))
		}
		targets = append(targets, probeTestMixedFailures(h)[:4]...)
		probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 3*time.Second))
		h.expectTargetConnsClosed(t)
		counts = append(counts, probeExpectGoroutines(t, baseline))
	}
	runtime.GC()
	runtime.ReadMemStats(&stats)
	t.Logf("goroutines: baseline %d, after each of 10 runs %v; heap in use %d KiB -> %d KiB",
		baseline, counts, heapStart>>10, stats.HeapInuse>>10)
}

// --- 13. nothing sensitive crosses the boundary ---------------------------------------------

func TestProbeNeverExposesSecrets(t *testing.T) {
	h := probeTestHarness(t)
	targets := []probeTarget{
		probeTestTarget("ok", h.outbound("vless-reality-vision", probeTestHost)),
		probeTestTarget("ok-hy2", h.outbound("hysteria2", probeTestHost)),
	}
	targets = append(targets, probeTestMixedFailures(h)...)
	options := h.options(t, newProbeResolver(), 1500*time.Millisecond)

	// Anything the engine or the core prints while it works.
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = writer, writer
	captured := make(chan []byte, 1)
	go func() {
		content, _ := io.ReadAll(reader)
		captured <- content
	}()
	var mu sync.Mutex
	var results []probeResult
	runProbe(context.Background(), targets, options, func(result probeResult) {
		mu.Lock()
		results = append(results, result)
		mu.Unlock()
	})
	apiErr := ProbeServers(1, `[{"id":"x","config":"`+probeTestPassword+`"`, 0, 0, newProbeResolver(), &probeRecorder{})
	os.Stdout, os.Stderr = stdout, stderr
	writer.Close()
	output := string(<-captured)

	secrets := []string{
		probeTestUUID, probeTestBadUUID, probeTestPassword, probeTestSSKey,
		h.realityPrivate, h.realityPublic, h.realityWrongPublic, probeTestHost, "127.0.0.1",
	}
	for _, port := range h.ports {
		secrets = append(secrets, ":"+strconv.Itoa(port))
	}
	byID := make(map[string]probeTarget)
	for _, target := range targets {
		byID[target.ID] = target
	}
	if len(results) != len(targets) {
		t.Errorf("%d results for %d targets", len(results), len(targets))
	}
	for _, result := range results {
		if !slices.Contains(probeTestVocabulary, result.status) {
			t.Errorf("%s: status %q is not in the sanitized vocabulary", result.id, result.status)
		}
		if target, ok := byID[result.id]; !ok || result.fingerprint != target.Fingerprint {
			t.Errorf("result %q does not echo its target's id and fingerprint", result.id)
		}
	}
	if apiErr == nil || strings.Contains(apiErr.Error(), probeTestPassword) {
		t.Errorf("malformed targets: error %v must exist and must not quote the input", apiErr)
	}
	for _, secret := range secrets {
		if strings.Contains(output, secret) {
			t.Errorf("process output contains a credential or endpoint (%d chars of output)", len(output))
			break
		}
	}
	t.Logf("%d results, all in the vocabulary; %d bytes printed during the run", len(results), len(output))
}

// --- 14. no listener / 15. no TUN -----------------------------------------------------------

func TestProbeOpensNoListener(t *testing.T) {
	h := probeTestHarness(t)
	before := probeSockets(t, true)

	// This node's config carries a local proxy inbound besides its TUN. Neither may appear.
	mixedPort, err := probeFreeTCPPort()
	if err != nil {
		t.Fatal(err)
	}
	var withMixed map[string]any
	if err := json.Unmarshal([]byte(probeTestNodeConfig(h.outbound("vless", probeTestHost))), &withMixed); err != nil {
		t.Fatal(err)
	}
	withMixed["inbounds"] = append(withMixed["inbounds"].([]any),
		map[string]any{"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": mixedPort})
	mixedConfig, _ := json.Marshal(withMixed)

	port := h.blackhole.Addr().(*net.TCPAddr).Port
	targets := []probeTarget{{ID: "with-mixed-inbound", Fingerprint: "fp", Config: string(mixedConfig)}}
	for i := range 5 {
		targets = append(targets, probeTestTarget(fmt.Sprintf("blackhole-%d", i),
			probeWithField(h.outbound("vless", probeTestHost), "server_port", port)))
	}
	done := make(chan map[string]probeResult, 1)
	go func() {
		done <- probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 4*time.Second))
	}()

	time.Sleep(700 * time.Millisecond) // the box is up and five probes are in flight
	during := probeSockets(t, true)
	conn, dialErr := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(mixedPort), time.Second)
	if dialErr == nil {
		conn.Close()
	}
	results := <-done
	after := probeSockets(t, true)

	if !slices.Equal(before, during) || !slices.Equal(before, after) {
		t.Errorf("listening sockets changed:\n before %v\n during %v\n after  %v", before, during, after)
	}
	if dialErr == nil {
		t.Errorf("the node config's mixed inbound was listening during the probe")
	}
	if status := results["with-mixed-inbound"].status; status != probeOK {
		t.Errorf("node with an extra inbound: status %s, want ok (the inbound is ignored, not fatal)", status)
	}
	t.Logf("listening sockets owned by this process: %d before, %d during, %d after", len(before), len(during), len(after))
}

func TestProbeNeverOpensTUN(t *testing.T) {
	h := probeTestHarness(t)
	before := probeInterfaceNames(t)
	resolver := newProbeResolver()
	options := h.options(t, resolver, 5*time.Second) // its Cleanup asserts zero OpenInterface calls
	var targets []probeTarget
	for _, kind := range probeTestKinds {
		targets = append(targets, probeTestTarget(kind, h.outbound(kind, probeTestHost)))
	}
	for _, target := range targets {
		if !strings.Contains(target.Config, `"type":"tun"`) {
			t.Fatalf("%s: node config has no TUN inbound to ignore", target.ID)
		}
	}
	var during []string
	options.inspect = func(instance *box.Box, dns adapter.DNSTransportManager) {
		during = probeInterfaceNames(t)
		probeCheckEmptyBox(t, instance, dns)
	}
	results := probeCollect(t, context.Background(), targets, options)
	after := probeInterfaceNames(t)
	for _, target := range targets {
		if results[target.ID].status != probeOK {
			t.Errorf("%s: %s", target.ID, results[target.ID].status)
		}
	}
	if !slices.Equal(before, during) || !slices.Equal(before, after) {
		t.Errorf("network interfaces changed:\n before %v\n during %v\n after  %v", before, during, after)
	}
}

// --- 16. a running instance is not touched --------------------------------------------------

// The device equivalent is the safety gate (:core PID, tun0, active server). In process, this
// proves the probe adds nothing to, and takes nothing from, another live instance - one built
// like the tunnel's, with its single "proxy" outbound carrying traffic throughout.
func TestProbeLeavesARunningInstanceAlone(t *testing.T) {
	h := probeTestHarness(t)
	running, ctx, err := probeTestBox(map[string]any{
		"log":         map[string]any{"disabled": true},
		"certificate": map[string]any{"certificate": []string{h.certPEM}},
		"outbounds":   []any{h.outbound("vless", "127.0.0.1"), map[string]any{"type": "direct", "tag": "direct"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer running.Close()
	tags := func() []string {
		var list []string
		for _, outbound := range running.Outbound().Outbounds() {
			list = append(list, outbound.Type()+"/"+outbound.Tag())
		}
		return list
	}
	proxy, ok := running.Outbound().Outbound("proxy")
	if !ok {
		t.Fatal("running instance has no proxy outbound")
	}
	tagsBefore := tags()
	if _, err := urltest.URLTest(ctx, h.link, proxy); err != nil {
		t.Fatalf("running instance cannot carry traffic before the probe: %v", err)
	}

	stop := make(chan struct{})
	var carried, failed atomic.Int32
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := urltest.URLTest(ctx, h.link, proxy); err != nil {
				failed.Add(1)
			} else {
				carried.Add(1)
			}
		}
	}()

	var targets []probeTarget
	for _, kind := range probeTestKinds {
		targets = append(targets, probeTestTarget(kind, h.outbound(kind, probeTestHost)))
	}
	targets = append(targets, probeTestMixedFailures(h)...)
	probeCollect(t, context.Background(), targets, h.options(t, newProbeResolver(), 2*time.Second))
	cancelled, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	probeCollect(t, cancelled, targets, h.options(t, newProbeResolver(), 2*time.Second))
	close(stop)
	wg.Wait()

	if n := failed.Load(); n != 0 {
		t.Errorf("running instance failed %d of %d URL tests while probes ran", n, n+carried.Load())
	}
	if after, _ := running.Outbound().Outbound("proxy"); after != proxy {
		t.Error("running instance's proxy outbound was replaced")
	}
	if tagsAfter := tags(); !slices.Equal(tagsBefore, tagsAfter) {
		t.Errorf("running instance's outbounds changed: %v -> %v", tagsBefore, tagsAfter)
	}
	if _, err := urltest.URLTest(ctx, h.link, proxy); err != nil {
		t.Errorf("running instance cannot carry traffic after the probe: %v", err)
	}
	t.Logf("running instance carried %d URL tests during two probe runs, 0 failed", carried.Load())
}

// --- the gomobile surface -------------------------------------------------------------------

type probeRecorder struct {
	mu      sync.Mutex
	inCall  atomic.Bool
	overlap atomic.Bool
	events  []string
	done    chan string
}

func newProbeRecorder() *probeRecorder { return &probeRecorder{done: make(chan string, 8)} }

func (r *probeRecorder) enter() {
	if !r.inCall.CompareAndSwap(false, true) {
		r.overlap.Store(true)
	}
}

func (r *probeRecorder) OnResult(runID int64, serverID string, fingerprint string, status string, delayMs int32) {
	r.enter()
	defer r.inCall.Store(false)
	r.mu.Lock()
	r.events = append(r.events, fmt.Sprintf("result %d %s %s %s %d", runID, serverID, fingerprint, status, delayMs))
	r.mu.Unlock()
}

func (r *probeRecorder) OnDone(runID int64, cancelled bool) {
	r.enter()
	defer r.inCall.Store(false)
	event := fmt.Sprintf("done %d %t", runID, cancelled)
	r.mu.Lock()
	r.events = append(r.events, event)
	r.mu.Unlock()
	if r.done != nil {
		r.done <- event
	}
}

func (r *probeRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.events)
}

func (r *probeRecorder) waitDone(t *testing.T, timeout time.Duration) string {
	t.Helper()
	select {
	case event := <-r.done:
		return event
	case <-time.After(timeout):
		t.Fatalf("no OnDone within %v; events %v", timeout, r.snapshot())
		return ""
	}
}

func probeTargetsJSON(t *testing.T, targets []probeTarget) string {
	t.Helper()
	content, err := json.Marshal(targets)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func TestProbeServersAPI(t *testing.T) {
	h := probeTestHarness(t)

	t.Run("results then done, production policy", func(t *testing.T) {
		recorder := newProbeRecorder()
		targets := []probeTarget{
			probeTestTarget("a", h.outbound("vless", probeTestHost)), // resolves to loopback: refused
			probeTestTarget("b", h.outbound("vless", "10.0.0.1")),    // private literal: refused
			{ID: "c", Fingerprint: "fp-c", Config: "{}"},
		}
		if err := ProbeServers(101, probeTargetsJSON(t, targets), 0, 0, newProbeResolver(), recorder); err != nil {
			t.Fatal(err)
		}
		if event := recorder.waitDone(t, 5*time.Second); event != "done 101 false" {
			t.Errorf("got %q", event)
		}
		events := recorder.snapshot()
		want := map[string]bool{
			"result 101 a fp-a dns_failed 0":     true,
			"result 101 b fp-b config_invalid 0": true,
			"result 101 c fp-c config_invalid 0": true,
		}
		if len(events) != 4 || events[3] != "done 101 false" {
			t.Fatalf("events %v", events)
		}
		for _, event := range events[:3] {
			if !want[event] {
				t.Errorf("unexpected event %q", event)
			}
		}
		time.Sleep(300 * time.Millisecond)
		if n := len(recorder.snapshot()); n != 4 {
			t.Errorf("%d events after OnDone", n-4)
		}
		if recorder.overlap.Load() {
			t.Error("handler calls overlapped")
		}
	})

	t.Run("rejects bad arguments", func(t *testing.T) {
		recorder := newProbeRecorder()
		if err := ProbeServers(1, "[", 0, 0, newProbeResolver(), recorder); err == nil {
			t.Error("malformed JSON accepted")
		}
		if err := ProbeServers(1, "[]", 0, 0, nil, recorder); err == nil {
			t.Error("nil resolver accepted")
		}
		if err := ProbeServers(1, "[]", 0, 0, newProbeResolver(), nil); err == nil {
			t.Error("nil handler accepted")
		}
		time.Sleep(100 * time.Millisecond)
		if events := recorder.snapshot(); len(events) != 0 {
			t.Errorf("rejected calls produced events %v", events)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		recorder := newProbeRecorder()
		resolver := newProbeResolver()
		resolver.gate = make(chan struct{})
		defer close(resolver.gate)
		targets := []probeTarget{
			probeTestTarget("x", h.outbound("vless", probeTestHost)),
			probeTestTarget("y", h.outbound("trojan-ws", probeTestHost)),
		}
		if err := ProbeServers(201, probeTargetsJSON(t, targets), 0, 0, resolver, recorder); err != nil {
			t.Fatal(err)
		}
		time.Sleep(200 * time.Millisecond)
		CancelProbe(999) // another run's id: no effect
		select {
		case event := <-recorder.done:
			t.Fatalf("CancelProbe for another run ended this one: %s", event)
		case <-time.After(300 * time.Millisecond):
		}
		start := time.Now()
		CancelProbe(201)
		if event := recorder.waitDone(t, 2*time.Second); event != "done 201 true" {
			t.Errorf("got %q", event)
		}
		for _, event := range recorder.snapshot() {
			if strings.HasPrefix(event, "result") && !strings.Contains(event, " cancelled ") {
				t.Errorf("result after cancel: %q", event)
			}
		}
		t.Logf("CancelProbe -> OnDone in %v", time.Since(start).Round(time.Millisecond))
	})

	t.Run("a new run supersedes the old one", func(t *testing.T) {
		recorder := newProbeRecorder()
		resolver := newProbeResolver()
		resolver.gate = make(chan struct{})
		defer close(resolver.gate)
		if err := ProbeServers(301, probeTargetsJSON(t, []probeTarget{probeTestTarget("old", h.outbound("vless", probeTestHost))}), 0, 0, resolver, recorder); err != nil {
			t.Fatal(err)
		}
		time.Sleep(200 * time.Millisecond)
		fresh := []probeTarget{{ID: "new", Fingerprint: "fp-new", Config: "{}"}}
		if err := ProbeServers(302, probeTargetsJSON(t, fresh), 0, 0, newProbeResolver(), recorder); err != nil {
			t.Fatal(err)
		}
		first := recorder.waitDone(t, 3*time.Second)
		second := recorder.waitDone(t, 3*time.Second)
		if first != "done 301 true" || second != "done 302 false" {
			t.Errorf("done events %q, %q", first, second)
		}
		events := recorder.snapshot()
		oldDone := slices.Index(events, "done 301 true")
		for i, event := range events {
			if strings.HasPrefix(event, "result 302") && i < oldDone {
				t.Errorf("run 302 reported before run 301 was closed: %v", events)
			}
		}
		if recorder.overlap.Load() {
			t.Error("handler calls overlapped")
		}
	})
}

// --- the app's own link shapes --------------------------------------------------------------

// Every link shape the app emits (core/testdata/configs, generated by check-configs.sh from
// the real TypeScript assembler) must be buildable as a probe outbound. Each is pointed at a
// closed local port: the outcome must be a network failure, never config_invalid.
func TestProbeAcceptsEveryGeneratedLinkShape(t *testing.T) {
	h := probeTestHarness(t)
	dir := filepath.Join("..", "testdata", "configs")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		t.Skip("no generated fixtures; run core/scripts/check-configs.sh")
	}
	resolver := newProbeResolver()
	resolver.answers["example.com"] = "127.0.0.1"
	var targets []probeTarget
	quic := map[string]bool{}
	// gRPC dials lazily and reports a dead server as a closed pipe, not a refusal.
	lazy := map[string]bool{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := probeOutbound(string(content)); err != nil {
			t.Errorf("%s: proxy outbound not extracted", entry.Name())
			continue
		}
		var config map[string]any
		if err := json.Unmarshal(content, &config); err != nil {
			t.Fatal(err)
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		for _, raw := range config["outbounds"].([]any) {
			outbound := raw.(map[string]any)
			if outbound["tag"] != "proxy" {
				continue
			}
			if outbound["server"] != "example.com" {
				t.Fatalf("%s: fixture server is not the placeholder host", id)
			}
			transport, _ := outbound["transport"].(map[string]any)
			if transport != nil && transport["type"] == "grpc" {
				lazy[id] = true
			}
			// V2Ray's quic transport rides UDP like the QUIC protocols: a dead UDP port times out
			// rather than refusing.
			if outbound["type"] == "hysteria2" || outbound["type"] == "tuic" || (transport != nil && transport["type"] == "quic") {
				outbound["server_port"], quic[id] = h.deadUDP, true
			} else {
				outbound["server_port"] = h.deadTCP
			}
		}
		retargeted, _ := json.Marshal(config)
		targets = append(targets, probeTarget{ID: id, Fingerprint: "fp", Config: string(retargeted)})
	}
	results := probeCollect(t, context.Background(), targets, h.options(t, resolver, 2*time.Second))
	for _, target := range targets {
		status := results[target.ID].status
		t.Logf("%-26s %s", target.ID, status)
		switch {
		case status == probeConfigInvalid || status == probeOK || status == "":
			t.Errorf("%s: status %q", target.ID, status)
		case lazy[target.ID] && status != probeRefused && status != probeFailed:
			t.Errorf("%s: status %s, want refused or failed", target.ID, status)
		case !quic[target.ID] && !lazy[target.ID] && status != probeRefused:
			t.Errorf("%s: status %s, want refused (a TCP server that is not there)", target.ID, status)
		}
	}
}

// --- units ----------------------------------------------------------------------------------

func TestProbeUsableAddressMatchesConfigGuard(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1": false, "::1": false, "0.0.0.0": false, "::": false,
		"169.254.1.1": false, "fe80::1": false, "224.0.0.1": false, "ff02::1": false,
		"10.0.0.1": false, "172.16.0.1": false, "192.168.1.1": false, "fec0::1": false, "fd00::1": false,
		"::ffff:10.0.0.1": false, "::ffff:8.8.8.8": true,
		"8.8.8.8": true, "203.0.113.9": true, "2001:4860:4860::8888": true, "100.64.0.1": true,
	}
	for literal, want := range cases {
		if got := probeUsableAddress(netip.MustParseAddr(literal)); got != want {
			t.Errorf("%s: usable %t, want %t", literal, got, want)
		}
	}
}

func TestProbeClassify(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, probeTimeout},
		{fmt.Errorf("dial tcp 203.0.113.9:443: %w", os.ErrDeadlineExceeded), probeTimeout},
		{&net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, probeRefused},
		{&net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ENETUNREACH)}, probeUnreachable},
		{errors.New("dial tcp 203.0.113.9:443: connect: no route to host"), probeUnreachable},
		{errors.New("authentication failed, status code: 404"), probeRejected},
		{errors.New("tls: failed to verify certificate: x509: certificate signed by unknown authority"), probeHandshakeFailed},
		{errors.New("reality verification failed"), probeHandshakeFailed},
		{fmt.Errorf("read response: %w", io.EOF), probeRejected},
		{errors.New("wsarecv: An existing connection was forcibly closed by the remote host."), probeRejected},
		{errors.New("lookup example.com: no such host"), probeDNSFailed},
		{errors.New("Application error 0x0 (remote)"), probeRejected},
		{errors.New("something else entirely"), probeFailed},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases, struct {
			err  error
			want string
		}{&net.OpError{Op: "dial", Err: os.NewSyscallError("connectex", syscall.Errno(10061))}, probeRefused})
	}
	for _, c := range cases {
		if got := probeClassify(c.err); got != c.want {
			t.Errorf("%q: %s, want %s", c.err, got, c.want)
		}
	}
}

func TestProbeOutboundExtraction(t *testing.T) {
	outbound := map[string]any{
		"type": "vless", "tag": "proxy", "server": "203.0.113.9", "server_port": 443, "uuid": probeTestUUID,
		"domain_resolver": map[string]any{"server": "dns-direct"},
		"transport":       map[string]any{"type": "ws", "path": "/p"},
	}
	fields, server, err := probeOutbound(probeTestNodeConfig(outbound))
	if err != nil || server != "203.0.113.9" {
		t.Fatalf("extract: %v, server %q", err, server)
	}
	if _, kept := fields["domain_resolver"]; kept {
		t.Error("the node's domain_resolver names a server the probe box does not have; it must be dropped")
	}
	if string(fields["transport"]) != `{"path":"/p","type":"ws"}` {
		t.Errorf("transport changed: %s", fields["transport"])
	}
}
