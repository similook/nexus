//go:build with_utls

package nexuscore

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	stdtls "crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/sagernet/sing-vmess/vless"
)

// The six "Generate keys" choices of the 3x-ui inbound form - X25519 or ML-KEM-768
// authentication, each in native, xorpub or random mode - against a real Xray server
// (NEXUS_XRAY_BIN), as plain VLESS Encryption and layered under REALITY with and without the
// ML-KEM key share. Everything listens on 127.0.0.1.
//
// REALITY + VLESS Encryption is the shape of a real failing link (`vkytlg8pol`), and it had
// only been covered by its two halves separately.
func TestVLESSEncryptionPanelMatrixAgainstXray(t *testing.T) {
	bin := os.Getenv("NEXUS_XRAY_BIN")
	if bin == "" {
		t.Skip("NEXUS_XRAY_BIN not set")
	}
	const uuid = "11111111-2222-3333-4444-555555555555"
	echoPort := matrixEchoServer(t)
	seconds := map[string]string{"0rtt": "600s", "1rtt": "0s"}
	// Xray >= 26.9.8 (XTLS/REALITY 8cdf7bf) rejects a REALITY hello without the
	// X25519MLKEM768 key share; older servers accept it. Without the share, the REALITY cases
	// must fail against the one and pass against the other - that difference is the finding.
	strict := xrayRejectsWithoutMLKEM(t, bin)
	t.Logf("xray rejects REALITY without the ML-KEM share: %v", strict)

	for _, kind := range []string{"x25519", "mlkem"} {
		for _, mode := range []string{"native", "xorpub", "random"} {
			for _, rtt := range []string{"0rtt", "1rtt"} {
				t.Run(fmt.Sprintf("raw/%s/%s/%s", kind, mode, rtt), func(t *testing.T) {
					serverKey, clientKey := encKeys(t, kind)
					port := startXrayInbound(t, bin, map[string]any{
						"clients":    []any{map[string]any{"id": uuid}},
						"decryption": fmt.Sprintf("mlkem768x25519plus.%s.%s.%s", mode, seconds[rtt], serverKey),
					}, map[string]any{"network": "raw"}, echoPort)
					socks := matrixClientBox(t, port, uuid, fmt.Sprintf("mlkem768x25519plus.%s.%s.%s", mode, rtt, clientKey), "", nil)
					socks5Echo(t, socks, 30_000)
					socks5Echo(t, socks, 3) // second connection: the 0-RTT ticket path for "0rtt"
				})
			}
		}
	}

	// Padding blocks before the key, as Xray documents them, on both sides.
	t.Run("raw/x25519/native/0rtt/padding", func(t *testing.T) {
		const padding = "100-111-1111.75-0-111.50-0-3333."
		serverKey, clientKey := encKeys(t, "x25519")
		port := startXrayInbound(t, bin, map[string]any{
			"clients":    []any{map[string]any{"id": uuid}},
			"decryption": "mlkem768x25519plus.native.600s." + padding + serverKey,
		}, map[string]any{"network": "raw"}, echoPort)
		socks := matrixClientBox(t, port, uuid, "mlkem768x25519plus.native.0rtt."+padding+clientKey, "", nil)
		socks5Echo(t, socks, 30_000)
		socks5Echo(t, socks, 3)
	})

	// Under REALITY, with Vision as 3x-ui sets it up for REALITY inbounds.
	target := matrixTLSTarget(t)
	for _, kind := range []string{"x25519", "mlkem"} {
		for _, mode := range []string{"native", "xorpub", "random"} {
			for _, mlkemShare := range []bool{false, true} {
				t.Run(fmt.Sprintf("reality/mlkem-share=%v/%s/%s/0rtt", mlkemShare, kind, mode), func(t *testing.T) {
					serverKey, clientKey := encKeys(t, kind)
					realityKey, err := ecdh.X25519().GenerateKey(rand.Reader)
					if err != nil {
						t.Fatal(err)
					}
					port := startXrayInbound(t, bin, map[string]any{
						"clients":    []any{map[string]any{"id": uuid, "flow": vless.FlowVision}},
						"decryption": fmt.Sprintf("mlkem768x25519plus.%s.600s.%s", mode, serverKey),
					}, map[string]any{
						"network": "raw", "security": "reality",
						"realitySettings": map[string]any{
							"target":      fmt.Sprintf("127.0.0.1:%d", target),
							"serverNames": []string{"localhost"},
							"privateKey":  b64(realityKey.Bytes()),
							"shortIds":    []string{"ab"},
						},
					}, echoPort)
					reality := map[string]any{"enabled": true, "public_key": b64(realityKey.PublicKey().Bytes()), "short_id": "ab"}
					if mlkemShare {
						reality["support_x25519mlkem768"] = true
					}
					socks := matrixClientBox(t, port, uuid, fmt.Sprintf("mlkem768x25519plus.%s.0rtt.%s", mode, clientKey), vless.FlowVision, map[string]any{
						"enabled": true, "server_name": "localhost",
						"utls":    map[string]any{"enabled": true, "fingerprint": "chrome"},
						"reality": reality,
					})
					realityExpect(t, socks, mlkemShare || !strict)
				})
			}
		}
	}

	// REALITY without VLESS Encryption, both key-share settings: the plain shape most links have.
	for _, mlkemShare := range []bool{false, true} {
		t.Run(fmt.Sprintf("reality/mlkem-share=%v/encryption=none", mlkemShare), func(t *testing.T) {
			realityKey, err := ecdh.X25519().GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			port := startXrayInbound(t, bin, map[string]any{
				"clients":    []any{map[string]any{"id": uuid, "flow": vless.FlowVision}},
				"decryption": "none",
			}, map[string]any{
				"network": "raw", "security": "reality",
				"realitySettings": map[string]any{
					"target":      fmt.Sprintf("127.0.0.1:%d", target),
					"serverNames": []string{"localhost"},
					"privateKey":  b64(realityKey.Bytes()),
					"shortIds":    []string{"ab"},
				},
			}, echoPort)
			reality := map[string]any{"enabled": true, "public_key": b64(realityKey.PublicKey().Bytes()), "short_id": "ab"}
			if mlkemShare {
				reality["support_x25519mlkem768"] = true
			}
			socks := matrixClientBox(t, port, uuid, "none", vless.FlowVision, map[string]any{
				"enabled": true, "server_name": "localhost",
				"utls":    map[string]any{"enabled": true, "fingerprint": "chrome"},
				"reality": reality,
			})
			realityExpect(t, socks, mlkemShare || !strict)
		})
	}
}

// REALITY compatibility beyond the key share, found on a panel running Xray 26.7.28
// (2026-10-22): the client version the server checks, and an ML-KEM opt-in on a fingerprint
// whose uTLS Client Hello has no X25519MLKEM768 share. Both failed as "reality verification
// failed" while Xray clients worked.
func TestRealityCompatAgainstXray(t *testing.T) {
	bin := os.Getenv("NEXUS_XRAY_BIN")
	if bin == "" {
		t.Skip("NEXUS_XRAY_BIN not set")
	}
	const uuid = "11111111-2222-3333-4444-555555555555"
	strict := xrayRejectsWithoutMLKEM(t, bin)
	old := xrayRejectsMLKEMShare(t, bin)
	t.Logf("xray refuses the ML-KEM share: %v; refuses its absence: %v", old, strict)
	echoPort := matrixEchoServer(t)
	target := matrixTLSTarget(t)
	cases := []struct {
		name         string
		minClientVer string
		fingerprint  string
		mlkemShare   bool
		works        bool
	}{
		// The server as installed, nothing set.
		{"default/mlkem-share=true", "", "chrome", true, !old},
		{"default/mlkem-share=false", "", "chrome", false, !strict},
		// What Xray v26.7.11 to v26.7.28 apply when minClientVer is empty (Xray-core af7eb680),
		// set explicitly so every Xray binary checks it. Upstream sing-box reports 1.8.1.
		{"minClientVer=26.3.27/mlkem-share=false", "26.3.27", "chrome", false, !strict},
		{"minClientVer=26.3.27/mlkem-share=true", "26.3.27", "chrome", true, !old},
		// No X25519MLKEM768 share in uTLS's firefox or safari: the opt-in falls back to Chrome.
		{"fingerprint=firefox/mlkem-share=true", "", "firefox", true, !old},
		{"fingerprint=safari/mlkem-share=true", "", "safari", true, !old},
		{"fingerprint=firefox/mlkem-share=false", "", "firefox", false, !strict},
	}
	for _, c := range cases {
		t.Run("reality/"+c.name, func(t *testing.T) {
			realityKey, err := ecdh.X25519().GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			// "dest" and "tcp" for Xray before v24.x ("target" and "raw" are the newer names;
			// newer releases read both), so this test runs against old panels' servers too.
			settings := map[string]any{
				"target":      fmt.Sprintf("127.0.0.1:%d", target),
				"dest":        fmt.Sprintf("127.0.0.1:%d", target),
				"serverNames": []string{"localhost"},
				"privateKey":  b64(realityKey.Bytes()),
				"shortIds":    []string{"ab"},
			}
			if c.minClientVer != "" {
				settings["minClientVer"] = c.minClientVer
			}
			port := startXrayInbound(t, bin, map[string]any{
				"clients":    []any{map[string]any{"id": uuid, "flow": vless.FlowVision}},
				"decryption": "none",
			}, map[string]any{"network": "tcp", "security": "reality", "realitySettings": settings}, echoPort)
			reality := map[string]any{"enabled": true, "public_key": b64(realityKey.PublicKey().Bytes()), "short_id": "ab"}
			if c.mlkemShare {
				reality["support_x25519mlkem768"] = true
			}
			socks := matrixClientBox(t, port, uuid, "none", vless.FlowVision, map[string]any{
				"enabled": true, "server_name": "localhost",
				"utls":    map[string]any{"enabled": true, "fingerprint": c.fingerprint},
				"reality": reality,
			})
			realityExpect(t, socks, c.works)
		})
	}
}

// startXrayInbound runs an Xray VLESS inbound on 127.0.0.1 with the given settings and stream
// settings, routing every request to the echo server on target, and returns its port.
func startXrayInbound(t *testing.T, bin string, settings, stream map[string]any, target int) int {
	t.Helper()
	port := freePort(t)
	config := map[string]any{
		"log": map[string]any{"loglevel": "debug"},
		"inbounds": []any{map[string]any{
			"listen": "127.0.0.1", "port": port, "protocol": "vless",
			"settings": settings, "streamSettings": stream,
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
			return port
		}
		if time.Now().After(deadline) {
			t.Fatalf("xray did not start:\n%s", stderr.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// matrixClientBox is encClientBox with an optional tls block, so the same outbound can be
// layered under REALITY the way the app's generated config does it.
func matrixClientBox(t *testing.T, serverPort int, uuid, encryption, flow string, tlsOptions map[string]any) string {
	t.Helper()
	socksPort := freePort(t)
	outbound := map[string]any{
		"type": "vless", "tag": "proxy", "server": "127.0.0.1", "server_port": serverPort,
		"uuid": uuid, "encryption": encryption, "packet_encoding": "xudp",
	}
	if flow != "" {
		outbound["flow"] = flow
	}
	if tlsOptions != nil {
		outbound["tls"] = tlsOptions
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

func matrixEchoServer(t *testing.T) int {
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
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// matrixTLSTarget is the site REALITY borrows its handshake from: a local TLS 1.3 server, whose
// Go stack also accepts the X25519MLKEM768 key share.
func matrixTLSTarget(t *testing.T) int {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := stdtls.Listen("tcp", "127.0.0.1:0", &stdtls.Config{
		MinVersion: stdtls.VersionTLS13, Certificates: []stdtls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
	})
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
			go func() { defer conn.Close(); _, _ = io.Copy(io.Discard, conn) }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// realityExpect checks a REALITY tunnel either carries data both ways (twice, the second time
// on the 0-RTT ticket path) or, when the server must refuse the hello, carries nothing.
func realityExpect(t *testing.T, socks string, works bool) {
	t.Helper()
	if works {
		socks5Echo(t, socks, 30_000)
		socks5Echo(t, socks, 3)
		return
	}
	if socks5EchoWorks(socks, 3_000) {
		t.Fatal("the server accepted this REALITY hello; want it refused")
	}
}

// socks5EchoWorks is socks5Echo without failing the test: true when the bytes came back intact.
func socks5EchoWorks(socks string, size int) bool {
	conn, err := net.DialTimeout("tcp", socks, 5*time.Second)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	_, _ = conn.Write([]byte{5, 1, 0})
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		return false
	}
	_, _ = conn.Write([]byte{5, 1, 0, 1, 10, 0, 0, 1, 0, 80})
	head := make([]byte, 10)
	if _, err := io.ReadFull(conn, head); err != nil || head[1] != 0 {
		return false
	}
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	go func() { _, _ = conn.Write(payload) }()
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		return false
	}
	return bytes.Equal(got, payload)
}

// xrayRejectsWithoutMLKEM reports whether the Xray binary is v26.9.8 or newer: those refuse a
// REALITY hello without the X25519MLKEM768 key share.
func xrayRejectsWithoutMLKEM(t *testing.T, bin string) bool {
	t.Helper()
	return xrayVersionAtLeast(t, bin, [3]int{26, 9, 8})
}

// xrayRejectsMLKEMShare reports whether the Xray binary is older than v25.5.16: those refuse a
// REALITY hello WITH the X25519MLKEM768 key share. Found by bisecting builds of each release
// (2026-10-22): 1.8.24, 24.12.31 and 25.1.30 to 25.4.30 refuse it; 25.5.16 and every later
// release tested accept it. So no single key-share setting suits every server.
func xrayRejectsMLKEMShare(t *testing.T, bin string) bool {
	t.Helper()
	return !xrayVersionAtLeast(t, bin, [3]int{25, 5, 16})
}

// xrayVersionAtLeast compares the binary's `xray version` ("Xray 26.9.9 (Xray, Penetrates
// Everything.) ...") with want.
func xrayVersionAtLeast(t *testing.T, bin string, want [3]int) bool {
	t.Helper()
	out, err := exec.Command(bin, "version").Output()
	if err != nil {
		t.Fatalf("xray version: %v", err)
	}
	m := regexp.MustCompile(`Xray (\d+)\.(\d+)\.(\d+)`).FindSubmatch(out)
	if m == nil {
		t.Fatalf("xray version: no version in %q", out)
	}
	v := [3]int{}
	for i := range v {
		v[i], _ = strconv.Atoi(string(m[i+1]))
	}
	for i := range v {
		if v[i] != want[i] {
			return v[i] > want[i]
		}
	}
	return true
}
