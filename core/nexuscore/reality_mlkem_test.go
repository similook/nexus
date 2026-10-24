//go:build with_utls

package nexuscore

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"github.com/sagernet/sing-box/common/tls"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/common/logger"

	"golang.org/x/crypto/hkdf"
)

// Tests for the Nexus REALITY patch (core/patches/sing-box): the `support_x25519mlkem768`
// option keeps the X25519MLKEM768 key share, and nothing else about the ClientHello changes.
//
// Each test captures the real ClientHello the core writes, then reads it the way a REALITY
// server does: pick the X25519 share the server would authenticate with, derive the auth key,
// and open the sealed SessionId. Both server rules are emulated from XTLS/REALITY tls.go:
//
//	oldRule  9234c77 (Xray <= v26.7.28): standalone X25519, else X25519 inside X25519MLKEM768
//	newRule  8cdf7bf (Xray >= v26.9.8):  rejects any hello without X25519MLKEM768 before X25519
//
// REALITY lives behind the with_utls tag, so run with the AAR's tags and link flags:
//
//	go test -tags with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api \
//	  -ldflags=-checklinkname=0 ./nexuscore/ -run TestReality -v

const (
	groupX25519         = 0x001d
	groupX25519MLKEM768 = 0x11ec
	mlkemEncapKeySize   = 1184
	extSupportedGroups  = 0x000a
	extKeyShare         = 0x0033
)

type keyShare struct {
	group uint16
	data  []byte
}

type clientHello struct {
	raw       []byte // the handshake message, as REALITY's AAD sees it
	random    []byte
	sessionID []byte
	groups    []uint16
	shares    []keyShare
}

// captureHello runs the core's REALITY client against one end of a pipe and returns the
// ClientHello it writes, plus the server private key matching the configured public key.
func captureHello(t *testing.T, tlsJSON string) (clientHello, *ecdh.PrivateKey) {
	t.Helper()
	serverKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var options option.OutboundTLSOptions
	if err := json.Unmarshal([]byte(tlsJSON), &options); err != nil {
		t.Fatalf("parse tls options: %v", err)
	}
	options.Reality.PublicKey = base64.RawURLEncoding.EncodeToString(serverKey.PublicKey().Bytes())

	config, err := tls.NewClient(context.Background(), logger.NOP(), "www.example.com", options)
	if err != nil {
		t.Fatalf("new reality client: %v", err)
	}
	return captureFromConfig(t, config), serverKey
}

func captureFromConfig(t *testing.T, config tls.Config) clientHello {
	t.Helper()
	client, server := net.Pipe()
	defer server.Close()
	go func() {
		// Fails once the server end closes; only the hello matters here.
		_, _ = tls.ClientHandshake(context.Background(), client, config)
		client.Close()
	}()
	_ = server.SetReadDeadline(time.Now().Add(10 * time.Second))

	header := make([]byte, 5)
	if _, err := io.ReadFull(server, header); err != nil {
		t.Fatalf("read record header: %v", err)
	}
	if header[0] != 0x16 {
		t.Fatalf("first record is type %#x, want handshake", header[0])
	}
	record := make([]byte, binary.BigEndian.Uint16(header[3:]))
	if _, err := io.ReadFull(server, record); err != nil {
		t.Fatalf("read record: %v", err)
	}
	return parseHello(t, record)
}

func parseHello(t *testing.T, msg []byte) clientHello {
	t.Helper()
	if msg[0] != 1 {
		t.Fatalf("handshake type %d, want ClientHello", msg[0])
	}
	length := int(msg[1])<<16 | int(msg[2])<<8 | int(msg[3])
	if length+4 != len(msg) {
		t.Fatalf("ClientHello spans more than one record (%d of %d bytes)", len(msg), length+4)
	}
	hello := clientHello{raw: msg}
	p := 4 + 2 // handshake header, legacy_version
	hello.random = msg[p : p+32]
	p += 32
	if msg[p] != 32 {
		t.Fatalf("session id length %d, want 32", msg[p])
	}
	hello.sessionID = msg[p+1 : p+33]
	p += 33
	p += 2 + int(binary.BigEndian.Uint16(msg[p:])) // cipher_suites
	p += 1 + int(msg[p])                           // compression_methods
	end := p + 2 + int(binary.BigEndian.Uint16(msg[p:]))
	for p += 2; p < end; {
		extType := binary.BigEndian.Uint16(msg[p:])
		extLen := int(binary.BigEndian.Uint16(msg[p+2:]))
		data := msg[p+4 : p+4+extLen]
		p += 4 + extLen
		switch extType {
		case extSupportedGroups:
			for i := 2; i+1 < len(data); i += 2 {
				hello.groups = append(hello.groups, binary.BigEndian.Uint16(data[i:]))
			}
		case extKeyShare:
			for i := 2; i+4 <= len(data); {
				group := binary.BigEndian.Uint16(data[i:])
				size := int(binary.BigEndian.Uint16(data[i+2:]))
				hello.shares = append(hello.shares, keyShare{group, data[i+4 : i+4+size]})
				i += 4 + size
			}
		}
	}
	return hello
}

// oldRule is XTLS/REALITY 9234c77's choice of the X25519 public key to authenticate with.
func oldRule(shares []keyShare) []byte {
	for _, s := range shares {
		if s.group == groupX25519 && len(s.data) == 32 {
			return s.data
		}
	}
	for _, s := range shares {
		if s.group == groupX25519MLKEM768 && len(s.data) == mlkemEncapKeySize+32 {
			return s.data[mlkemEncapKeySize:]
		}
	}
	return nil
}

// newRule is XTLS/REALITY 8cdf7bf's choice; nil means the server rejects the hello.
func newRule(shares []keyShare) []byte {
	var peerPub, peerPub2 []byte
	for _, s := range shares {
		if s.group == groupX25519MLKEM768 && len(s.data) == mlkemEncapKeySize+32 {
			if peerPub2 != nil {
				return nil
			}
			peerPub2 = s.data[mlkemEncapKeySize:]
			continue
		}
		if s.group == groupX25519 && len(s.data) == 32 {
			peerPub = s.data
			break
		}
	}
	if peerPub2 == nil {
		return nil // "reject outdated/strange Client Hello"
	}
	if peerPub == nil {
		return peerPub2
	}
	return peerPub
}

// openSessionID does what a REALITY server does with the chosen share: derive the auth key and
// open the sealed SessionId. It returns the 16-byte plaintext: version, reserved, time, short id.
func openSessionID(t *testing.T, hello clientHello, serverKey *ecdh.PrivateKey, peerPub []byte) []byte {
	t.Helper()
	pub, err := ecdh.X25519().NewPublicKey(peerPub)
	if err != nil {
		t.Fatal(err)
	}
	authKey, err := serverKey.ECDH(pub)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hkdf.New(sha256.New, authKey, hello.random[:20], []byte("REALITY")).Read(authKey); err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(authKey)
	aead, _ := cipher.NewGCM(block)
	aad := bytes.Clone(hello.raw)
	copy(aad[39:71], make([]byte, 32)) // the SessionId is zero when the client seals it
	plain, err := aead.Open(nil, hello.random[20:], hello.sessionID, aad)
	if err != nil {
		t.Fatalf("server cannot open the SessionId with the share it would choose: %v", err)
	}
	return plain
}

func shareIndex(shares []keyShare, group uint16) int {
	for i, s := range shares {
		if s.group == group {
			return i
		}
	}
	return -1
}

func hasGroup(groups []uint16, group uint16) bool {
	for _, g := range groups {
		if g == group {
			return true
		}
	}
	return false
}

func tlsOptionsJSON(fingerprint, mlkemField string) string {
	return `{"enabled":true,"server_name":"www.example.com","utls":{"enabled":true,"fingerprint":"` +
		fingerprint + `"},"reality":{"enabled":true,"short_id":"ab"` + mlkemField + `}}`
}

// assertAuthenticates checks that a server applying rule would accept the hello's credentials
// and read the expected client version (unchanged 1.8.1) and short id back out of it.
func assertAuthenticates(t *testing.T, hello clientHello, serverKey *ecdh.PrivateKey, rule string, peerPub []byte) {
	t.Helper()
	if peerPub == nil {
		t.Fatalf("%s: server would reject this ClientHello", rule)
	}
	plain := openSessionID(t, hello, serverKey, peerPub)
	// Not upstream's fixed 1.8.1, which Xray v26.7.11-v26.7.28 servers refuse by default.
	if !bytes.Equal(plain[:3], tls.RealityClientVersion[:]) {
		t.Errorf("%s: advertised client version %v, want %v", rule, plain[:3], tls.RealityClientVersion)
	}
	if !bytes.Equal(plain[8:16], []byte{0xab, 0, 0, 0, 0, 0, 0, 0}) {
		t.Errorf("%s: short id %x, want ab00000000000000", rule, plain[8:16])
	}
}

// Absent option: the upstream behaviour. No X25519MLKEM768 anywhere, so an Xray >= v26.9.8
// server rejects it, and older servers authenticate it exactly as before.
func TestRealityDefaultStripsMLKEM(t *testing.T) {
	for _, field := range []string{"", `,"support_x25519mlkem768":false`} {
		hello, serverKey := captureHello(t, tlsOptionsJSON("chrome", field))
		if hasGroup(hello.groups, groupX25519MLKEM768) || shareIndex(hello.shares, groupX25519MLKEM768) >= 0 {
			t.Fatalf("option %q: X25519MLKEM768 present, want stripped", field)
		}
		if shareIndex(hello.shares, groupX25519) < 0 {
			t.Fatalf("option %q: no X25519 key share", field)
		}
		if newRule(hello.shares) != nil {
			t.Errorf("option %q: a v26.9.8+ server would accept this hello; the default must be unchanged", field)
		}
		assertAuthenticates(t, hello, serverKey, "old server", oldRule(hello.shares))
	}
}

// Opted in: X25519MLKEM768 is offered before X25519 in both extensions, both server rules
// accept the hello, and the auth key is what it was.
func TestRealityOptInKeepsMLKEM(t *testing.T) {
	hello, serverKey := captureHello(t, tlsOptionsJSON("chrome", `,"support_x25519mlkem768":true`))
	if !hasGroup(hello.groups, groupX25519MLKEM768) {
		t.Fatalf("supported_groups %#x lacks X25519MLKEM768", hello.groups)
	}
	mlkem, x25519 := shareIndex(hello.shares, groupX25519MLKEM768), shareIndex(hello.shares, groupX25519)
	if mlkem < 0 || x25519 < 0 || mlkem > x25519 {
		t.Fatalf("key_share order: X25519MLKEM768 at %d, X25519 at %d; want MLKEM first, both present", mlkem, x25519)
	}
	if size := len(hello.shares[mlkem].data); size != mlkemEncapKeySize+32 {
		t.Fatalf("X25519MLKEM768 share is %d bytes, want %d", size, mlkemEncapKeySize+32)
	}
	assertAuthenticates(t, hello, serverKey, "new server", newRule(hello.shares))
	assertAuthenticates(t, hello, serverKey, "old server", oldRule(hello.shares))
	if !bytes.Equal(newRule(hello.shares), hello.shares[x25519].data) {
		t.Error("auth must use the standalone X25519 share")
	}
}

// Clone() must carry the option: the core clones TLS configs per connection.
func TestRealityOptInSurvivesClone(t *testing.T) {
	serverKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	var options option.OutboundTLSOptions
	if err := json.Unmarshal([]byte(tlsOptionsJSON("chrome", `,"support_x25519mlkem768":true`)), &options); err != nil {
		t.Fatal(err)
	}
	options.Reality.PublicKey = base64.RawURLEncoding.EncodeToString(serverKey.PublicKey().Bytes())
	config, err := tls.NewClient(context.Background(), logger.NOP(), "www.example.com", options)
	if err != nil {
		t.Fatal(err)
	}
	hello := captureFromConfig(t, config.Clone())
	if shareIndex(hello.shares, groupX25519MLKEM768) < 0 {
		t.Fatal("cloned config dropped X25519MLKEM768")
	}
}

// A fingerprint whose uTLS Client Hello has no X25519MLKEM768 share sends that hello unless the
// outbound opts in. Opted in, it falls back to Chrome's: the share is offered before X25519 and
// both server rules accept the hello. Without the fallback the opt-in sent nothing new, and
// servers since XTLS/REALITY 8cdf7bf refused the node while Xray clients connected.
func TestRealityOptInFallsBackToChromeForOtherFingerprints(t *testing.T) {
	for _, fingerprint := range []string{"firefox", "safari", "ios", "edge"} {
		off, _ := captureHello(t, tlsOptionsJSON(fingerprint, ""))
		if shareIndex(off.shares, groupX25519MLKEM768) >= 0 {
			t.Errorf("%s: X25519MLKEM768 offered without the opt-in", fingerprint)
		}
		on, serverKey := captureHello(t, tlsOptionsJSON(fingerprint, `,"support_x25519mlkem768":true`))
		mlkem, x25519 := shareIndex(on.shares, groupX25519MLKEM768), shareIndex(on.shares, groupX25519)
		if mlkem < 0 || x25519 < 0 || mlkem > x25519 {
			t.Errorf("%s opted in: X25519MLKEM768 at %d, X25519 at %d; want MLKEM first, both present", fingerprint, mlkem, x25519)
			continue
		}
		assertAuthenticates(t, on, serverKey, fingerprint+" new server", newRule(on.shares))
		assertAuthenticates(t, on, serverKey, fingerprint+" old server", oldRule(on.shares))
	}
}

// The JSON name is the contract with the link parser (clients/web/src/core/subscription.ts).
func TestRealityOptionJSONName(t *testing.T) {
	var options option.OutboundRealityOptions
	if err := json.Unmarshal([]byte(`{"enabled":true,"support_x25519mlkem768":true}`), &options); err != nil {
		t.Fatal(err)
	}
	if !options.SupportX25519MLKEM768 {
		t.Fatal("support_x25519mlkem768 did not set the option")
	}
	encoded, err := json.Marshal(option.OutboundRealityOptions{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("x25519mlkem768")) {
		t.Fatalf("unset option is serialised: %s", encoded)
	}
}
