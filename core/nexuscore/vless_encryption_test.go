//go:build with_utls

package nexuscore

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/mlkem"
	"crypto/rand"
	stdtls "crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sagernet/sing-box/common/vlessenc"
	"github.com/sagernet/sing-vmess/vless"
	"github.com/sagernet/sing/common/logger"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

// Tests for the Nexus VLESS Encryption patch (core/patches/sing-box/v1.14.0/0002): Xray's
// "mlkem768x25519plus" layer, as 3x-ui links carry it in `encryption=`.
//
//	go test -tags with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api \
//	  -ldflags=-checklinkname=0 ./nexuscore/ -run VLESSEncryption -v
//
// Interop with a real Xray server runs when NEXUS_XRAY_BIN points at an xray binary
// (TestVLESSEncryptionAgainstXray); it listens on 127.0.0.1 only.

var b64 = base64.RawURLEncoding.EncodeToString

// encKeys returns a matching (server decryption key, client encryption key) pair, as Xray's
// `xray x25519` / `xray mlkem768` print them.
func encKeys(t *testing.T, kind string) (server, client string) {
	t.Helper()
	switch kind {
	case "x25519":
		k, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		return b64(k.Bytes()), b64(k.PublicKey().Bytes())
	case "mlkem":
		seed := make([]byte, 64)
		_, _ = rand.Read(seed)
		k, err := mlkem.NewDecapsulationKey768(seed)
		if err != nil {
			t.Fatal(err)
		}
		return b64(seed), b64(k.EncapsulationKey().Bytes())
	}
	t.Fatalf("unknown key kind %q", kind)
	return
}

func TestVLESSEncryptionParse(t *testing.T) {
	_, x := encKeys(t, "x25519")
	_, m := encKeys(t, "mlkem")
	valid := []string{
		"mlkem768x25519plus.native.0rtt." + x,
		"mlkem768x25519plus.native.1rtt." + x,
		"mlkem768x25519plus.xorpub.0rtt." + x,
		"mlkem768x25519plus.random.1rtt." + m,
		"mlkem768x25519plus.native.0rtt." + x + "." + m,                       // relayed: two keys
		"mlkem768x25519plus.native.0rtt.100-111-1111.75-0-111.50-0-3333." + x, // with padding
	}
	for _, s := range valid {
		if _, err := vlessenc.NewClient(s); err != nil {
			t.Errorf("valid %q rejected: %v", s[:40], err)
		}
	}
	invalid := map[string]string{
		"wrong scheme":      "mlkem768.native.0rtt." + x,
		"unknown mode":      "mlkem768x25519plus.plain.0rtt." + x,
		"unknown rtt":       "mlkem768x25519plus.native.2rtt." + x,
		"too few fields":    "mlkem768x25519plus.native.0rtt",
		"bad key length":    "mlkem768x25519plus.native.0rtt." + b64(make([]byte, 31)) + "xxxxxxxxxx",
		"server-side key":   "mlkem768x25519plus.native.0rtt." + b64(make([]byte, 64)),
		"bad first padding": "mlkem768x25519plus.native.0rtt.10-1-2." + x,
		// Xray's own split slices past the end for these and panics; here they are errors.
		"padding but no key":      "mlkem768x25519plus.native.0rtt.abc",
		"two paddings but no key": "mlkem768x25519plus.native.0rtt.100-111-1111.75-0-111",
	}
	for name, s := range invalid {
		if _, err := vlessenc.NewClient(s); err == nil {
			t.Errorf("%s: %q accepted", name, s[:min(len(s), 40)])
		}
	}
	for _, s := range []string{"mlkem768x25519plus.native.600s.abc", "mlkem768x25519plus.native.600s.100-111-1111.75-0-111"} {
		if _, err := vlessenc.NewServer(s); err == nil {
			t.Errorf("server value without a key accepted: %q", s)
		}
	}
	if !vlessenc.Disabled("") || !vlessenc.Disabled("none") || vlessenc.Disabled("mlkem768x25519plus") {
		t.Error("Disabled() wrong")
	}
}

// encPair builds a matching server and client for one mode.
func encPair(t *testing.T, mode, rtt, kind, padding string) (*vlessenc.ServerInstance, *vlessenc.ClientInstance) {
	t.Helper()
	var serverKeys, clientKeys []string
	for _, k := range strings.Split(kind, "+") {
		s, c := encKeys(t, k)
		serverKeys, clientKeys = append(serverKeys, s), append(clientKeys, c)
	}
	seconds := "600s"
	if rtt == "1rtt" {
		seconds = "0s"
	}
	pad := ""
	if padding != "" {
		pad = padding + "."
	}
	server, err := vlessenc.NewServer(fmt.Sprintf("mlkem768x25519plus.%s.%s.%s%s", mode, seconds, pad, strings.Join(serverKeys, ".")))
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	t.Cleanup(func() { server.Close() })
	client, err := vlessenc.NewClient(fmt.Sprintf("mlkem768x25519plus.%s.%s.%s%s", mode, rtt, pad, strings.Join(clientKeys, ".")))
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	return server, client
}

// echoServer accepts connections, runs the server handshake and echoes everything back.
func echoServer(t *testing.T, server *vlessenc.ServerInstance) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				c, err := server.Handshake(conn, nil)
				if err != nil {
					return
				}
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().String()
}

func roundTrip(t *testing.T, addr string, client *vlessenc.ClientInstance, size int) {
	t.Helper()
	raw, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	_ = raw.SetDeadline(time.Now().Add(20 * time.Second))
	conn, err := client.Handshake(raw)
	if err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	go func() { _, _ = conn.Write(payload) }()
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("echo differs from what was sent")
	}
}

func TestVLESSEncryptionRoundTrip(t *testing.T) {
	for _, mode := range []string{"native", "xorpub", "random"} {
		for _, rtt := range []string{"0rtt", "1rtt"} {
			for _, kind := range []string{"x25519", "mlkem", "x25519+mlkem"} {
				for _, padding := range []string{"", "100-200-300.50-10-20.80-0-100"} {
					name := fmt.Sprintf("%s/%s/%s/pad=%v", mode, rtt, kind, padding != "")
					t.Run(name, func(t *testing.T) {
						server, client := encPair(t, mode, rtt, kind, padding)
						addr := echoServer(t, server)
						// Larger than one 8192-byte record, so chunking is exercised; a second
						// connection uses the 0-RTT ticket the first one obtained.
						roundTrip(t, addr, client, 40_000)
						roundTrip(t, addr, client, 1)
					})
				}
			}
		}
	}
}

// vlessEchoHandler answers every VLESS TCP request by echoing the connection.
type vlessEchoHandler struct{}

func (vlessEchoHandler) NewConnectionEx(ctx context.Context, conn net.Conn, source M.Socksaddr, destination M.Socksaddr, onClose N.CloseHandlerFunc) {
	defer conn.Close()
	_, _ = io.Copy(conn, conn)
}

func (vlessEchoHandler) NewPacketConnectionEx(ctx context.Context, conn N.PacketConn, source M.Socksaddr, destination M.Socksaddr, onClose N.CloseHandlerFunc) {
	conn.Close()
}

// socks5Connect opens a SOCKS5 CONNECT through the box's mixed inbound (to a placeholder
// destination; the servers in these tests route everything to their echo server).
func socks5Connect(t *testing.T, socks string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", socks, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	_, _ = conn.Write([]byte{5, 1, 0})
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		t.Fatalf("socks greeting: %v %v", reply, err)
	}
	request := []byte{5, 1, 0, 1, 10, 0, 0, 1, 0, 0}
	binary.BigEndian.PutUint16(request[8:], 80)
	_, _ = conn.Write(request)
	head := make([]byte, 10)
	if _, err := io.ReadFull(conn, head); err != nil || head[1] != 0 {
		t.Fatalf("socks connect: %v %v", head, err)
	}
	return conn
}

// socks5Echo checks that size random bytes sent through the tunnel come back unchanged.
func socks5Echo(t *testing.T, socks string, size int) {
	t.Helper()
	conn := socks5Connect(t, socks)
	defer conn.Close()
	echoCheck(t, conn, size)
}

func echoCheck(t *testing.T, conn net.Conn, size int) {
	t.Helper()
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	go func() { _, _ = conn.Write(payload) }()
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("echo through VLESS: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("echo through VLESS differs")
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func encClientBox(t *testing.T, serverPort int, uuid, encryption, flow string) string {
	t.Helper()
	socksPort := freePort(t)
	outbound := map[string]any{
		"type": "vless", "tag": "proxy", "server": "127.0.0.1", "server_port": serverPort,
		"uuid": uuid, "encryption": encryption, "packet_encoding": "xudp",
	}
	if flow != "" {
		outbound["flow"] = flow
	}
	instance, _, err := probeTestBox(map[string]any{
		"log":       map[string]any{"level": "error"},
		"inbounds":  []any{map[string]any{"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": socksPort}},
		"outbounds": []any{outbound},
		"route":     map[string]any{"final": "proxy"},
	})
	if err != nil {
		t.Fatalf("box: %v", err)
	}
	t.Cleanup(func() { instance.Close() })
	return fmt.Sprintf("127.0.0.1:%d", socksPort)
}

// The sing-box VLESS outbound, configured from JSON the way the app's generated config does,
// against the server half of the protocol with a real VLESS request on top. With flow vision
// this also covers the CommonConn registration Vision needs.
func TestVLESSEncryptionOutbound(t *testing.T) {
	const uuid = "11111111-2222-3333-4444-555555555555"
	for _, flow := range []string{"", vless.FlowVision} {
		for _, rtt := range []string{"0rtt", "1rtt"} {
			t.Run(fmt.Sprintf("flow=%q/%s", flow, rtt), func(t *testing.T) {
				serverKey, clientKey := encKeys(t, "x25519")
				seconds := map[string]string{"0rtt": "600s", "1rtt": "0s"}[rtt]
				server, err := vlessenc.NewServer("mlkem768x25519plus.native." + seconds + "." + serverKey)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { server.Close() })
				service := vless.NewService[int](logger.NOP(), vlessEchoHandler{})
				service.UpdateUsers([]int{1}, []string{uuid}, []string{flow})
				ln, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { ln.Close() })
				go func() {
					for {
						conn, err := ln.Accept()
						if err != nil {
							return
						}
						go func() {
							c, err := server.Handshake(conn, nil)
							if err != nil {
								conn.Close()
								return
							}
							if err := service.NewConnection(context.Background(), c, M.SocksaddrFromNet(conn.RemoteAddr()), nil); err != nil {
								conn.Close()
							}
						}()
					}
				}()
				socks := encClientBox(t, ln.Addr().(*net.TCPAddr).Port, uuid, "mlkem768x25519plus.native."+rtt+"."+clientKey, flow)
				socks5Echo(t, socks, 30_000)
				socks5Echo(t, socks, 3)
			})
		}
	}
	// No encryption: the outbound must still be the plain VLESS it always was.
	t.Run("encryption=none", func(t *testing.T) {
		service := vless.NewService[int](logger.NOP(), vlessEchoHandler{})
		service.UpdateUsers([]int{1}, []string{uuid}, []string{""})
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				go func() { _ = service.NewConnection(context.Background(), conn, M.Socksaddr{}, nil) }()
			}
		}()
		socks := encClientBox(t, ln.Addr().(*net.TCPAddr).Port, uuid, "none", "")
		socks5Echo(t, socks, 5000)
	})
}

// startXrayEnc runs an Xray VLESS inbound with the given decryption on 127.0.0.1, routing every
// request to target, and returns its port.
func startXrayEnc(t *testing.T, bin, uuid, flow, decryption string, target int) int {
	t.Helper()
	port := freePort(t)
	config := map[string]any{
		"log": map[string]any{"loglevel": "debug"},
		"inbounds": []any{map[string]any{
			"listen": "127.0.0.1", "port": port, "protocol": "vless",
			"settings": map[string]any{
				"clients":    []any{map[string]any{"id": uuid, "flow": flow}},
				"decryption": decryption,
			},
			"streamSettings": map[string]any{"network": "raw"},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom", "settings": map[string]any{
			"redirect":   fmt.Sprintf("127.0.0.1:%d", target),
			"finalRules": []any{map[string]any{"action": "allow", "ip": []string{"127.0.0.1/32"}}},
		}}},
	}
	content, _ := json.Marshal(config)
	path := filepath.Join(t.TempDir(), "server.json")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command(bin, "run", "-c", path)
	cmd.Stdout, cmd.Stderr = &stderr, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("xray output:\n%s", stderr.String())
		}
	})
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for {
		// Wait for the listener with a plain TCP connect: Xray logs it as a failed handshake.
		if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond); err == nil {
			c.Close()
			return port
		}
		if time.Now().After(deadline) {
			t.Fatalf("xray did not start:\n%s", stderr.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// Vision's whole point is the inner TLS: after the inner handshake it stops padding and copies
// directly beneath the "TLS" layer - with VLESS Encryption, beneath CommonConn. Random echo
// bytes never trigger that, so this runs a real TLS 1.3 session through the tunnel, both
// directions, past the switch.
func TestVLESSEncryptionVisionInnerTLSAgainstXray(t *testing.T) {
	bin := os.Getenv("NEXUS_XRAY_BIN")
	if bin == "" {
		t.Skip("NEXUS_XRAY_BIN not set")
	}
	const uuid = "11111111-2222-3333-4444-555555555555"
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	tlsLn, err := stdtls.Listen("tcp", "127.0.0.1:0", &stdtls.Config{
		MinVersion: stdtls.VersionTLS13, Certificates: []stdtls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tlsLn.Close() })
	go func() {
		for {
			conn, err := tlsLn.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	for _, rtt := range []string{"0rtt", "1rtt"} {
		for _, mode := range []string{"native", "random"} {
			t.Run(mode+"/"+rtt, func(t *testing.T) {
				serverKey, clientKey := encKeys(t, "x25519")
				seconds := map[string]string{"0rtt": "600s", "1rtt": "0s"}[rtt]
				port := startXrayEnc(t, bin, uuid, vless.FlowVision, "mlkem768x25519plus."+mode+"."+seconds+"."+serverKey, tlsLn.Addr().(*net.TCPAddr).Port)
				socks := encClientBox(t, port, uuid, "mlkem768x25519plus."+mode+"."+rtt+"."+clientKey, vless.FlowVision)
				for i := 0; i < 2; i++ { // the second session takes the 0-RTT ticket path for "0rtt"
					raw := socks5Connect(t, socks)
					inner := stdtls.Client(raw, &stdtls.Config{ServerName: "localhost", InsecureSkipVerify: true, MinVersion: stdtls.VersionTLS13})
					if err := inner.Handshake(); err != nil {
						t.Fatalf("inner TLS handshake through Vision: %v", err)
					}
					echoCheck(t, inner, 200_000)
					inner.Close()
				}
			})
		}
	}
}

// A server that accepts the connection and never answers the 1-RTT handshake must cost one
// timeout (the dial's deadline, else sing-box's 15 s TCP timeout), not a connection held open
// for as long as the peer likes.
func TestVLESSEncryptionHandshakeStallReleased(t *testing.T) {
	_, clientKey := encKeys(t, "x25519")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	released := make(chan time.Duration, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		start := time.Now()
		_, _ = io.Copy(io.Discard, conn) // read the client hello, answer nothing, wait for close
		released <- time.Since(start)
		conn.Close()
	}()
	socks := encClientBox(t, ln.Addr().(*net.TCPAddr).Port, "11111111-2222-3333-4444-555555555555", "mlkem768x25519plus.native.1rtt."+clientKey, "")
	conn, err := net.DialTimeout("tcp", socks, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte{5, 1, 0})
	_, _ = conn.Write([]byte{5, 1, 0, 1, 10, 0, 0, 1, 0, 80})
	select {
	case held := <-released:
		if held > 20*time.Second {
			t.Fatalf("stalled handshake held the connection for %v", held)
		}
		t.Logf("stalled handshake released after %v", held.Round(time.Second))
	case <-time.After(40 * time.Second):
		t.Fatal("stalled handshake never released the connection")
	}
}

// Interop with the real thing: an Xray server (NEXUS_XRAY_BIN, e.g. built from v26.9.9 with
// `go install github.com/xtls/xray-core/main@<commit>`) with VLESS Encryption on 127.0.0.1,
// routing to a local echo server; Nexus's sing-box outbound connects through it.
func TestVLESSEncryptionAgainstXray(t *testing.T) {
	bin := os.Getenv("NEXUS_XRAY_BIN")
	if bin == "" {
		t.Skip("NEXUS_XRAY_BIN not set")
	}
	const uuid = "11111111-2222-3333-4444-555555555555"
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { echo.Close() })
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	echoPort := echo.Addr().(*net.TCPAddr).Port

	cases := []struct{ mode, rtt, kind, flow string }{
		{"native", "0rtt", "x25519", ""}, // the shape of the user's failing link
		{"native", "1rtt", "x25519", ""},
		{"xorpub", "0rtt", "mlkem", ""},
		{"random", "1rtt", "x25519", ""},
		{"native", "0rtt", "x25519", vless.FlowVision},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%s/%s/%s/flow=%q", c.mode, c.rtt, c.kind, c.flow), func(t *testing.T) {
			serverKey, clientKey := encKeys(t, c.kind)
			seconds := map[string]string{"0rtt": "600s", "1rtt": "0s"}[c.rtt]
			port := freePort(t)
			config := map[string]any{
				"log": map[string]any{"loglevel": "debug"},
				"inbounds": []any{map[string]any{
					"listen": "127.0.0.1", "port": port, "protocol": "vless",
					"settings": map[string]any{
						"clients":    []any{map[string]any{"id": uuid, "flow": c.flow}},
						"decryption": fmt.Sprintf("mlkem768x25519plus.%s.%s.%s", c.mode, seconds, serverKey),
					},
					"streamSettings": map[string]any{"network": "raw"},
				}},
				"outbounds": []any{map[string]any{"protocol": "freedom", "settings": map[string]any{
					"redirect": fmt.Sprintf("127.0.0.1:%d", echoPort),
					// Xray 26 freedom refuses loopback targets unless a final rule allows them.
					"finalRules": []any{map[string]any{"action": "allow", "ip": []string{"127.0.0.1/32"}}},
				}}},
			}
			dir := t.TempDir()
			content, _ := json.Marshal(config)
			path := filepath.Join(dir, "server.json")
			if err := os.WriteFile(path, content, 0o600); err != nil {
				t.Fatal(err)
			}
			var stderr bytes.Buffer
			cmd := exec.Command(bin, "run", "-c", path)
			cmd.Stdout, cmd.Stderr = &stderr, &stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			// Cleanups run last-registered first: kill Xray, then show what it said.
			t.Cleanup(func() {
				if t.Failed() {
					t.Logf("xray output:\n%s", stderr.String())
				}
			})
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			deadline := time.Now().Add(10 * time.Second)
			for {
				if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond); err == nil {
					c.Close()
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("xray did not start:\n%s", stderr.String())
				}
				time.Sleep(100 * time.Millisecond)
			}
			socks := encClientBox(t, port, uuid, fmt.Sprintf("mlkem768x25519plus.%s.%s.%s", c.mode, c.rtt, clientKey), c.flow)
			socks5Echo(t, socks, 30_000)
			socks5Echo(t, socks, 3) // second connection: 0-RTT ticket path for "0rtt"
		})
	}
}
