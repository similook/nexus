package guard

import (
	"context"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeResolver returns whatever a test tells it to, so the poisoned-answer path can be
// exercised without a DNS server and without depending on what the machine's real resolver
// happens to say today.
type fakeResolver struct {
	answers map[string][]netip.Addr
	err     error
}

func (f fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if f.err != nil {
		return nil, f.err
	}
	addresses, ok := f.answers[host]
	if !ok {
		return nil, &net_NotFound{host}
	}
	return addresses, nil
}

type net_NotFound struct{ host string }

func (e *net_NotFound) Error() string { return "no such host: " + e.host }

func enforce(t *testing.T, configJSON string, options Options) (*Result, error) {
	t.Helper()
	return Enforce(context.Background(), configJSON, options)
}

func mustEnforce(t *testing.T, configJSON string, options Options) *Result {
	t.Helper()
	result, err := enforce(t, configJSON, options)
	if err != nil {
		t.Fatalf("Enforce: %v", err)
	}
	return result
}

// ---------------------------------------------------------------------------------------
// Parity with ConfigGuard.kt
// ---------------------------------------------------------------------------------------

// TestConstantsMatchKotlin pins the two numbers that exist in two languages.
//
// clients/android/.../ConfigGuard.kt declares MIN_HEALTH_CHECK_SECONDS = 600 and
// PREFERRED_STACK = "system". Both encode ADR-0001 decisions, and both are now duplicated
// because clients/web is frozen and Android still needs its own guard.
//
// A duplicated constant that nothing checks is a constant that will drift. This test does not
// prevent that — it cannot read Kotlin — but it makes the Go side impossible to change
// silently: whoever edits it has to edit this too, and the diff names the Kotlin file.
func TestConstantsMatchKotlin(t *testing.T) {
	if MinHealthCheckSeconds != 600 {
		t.Errorf("MinHealthCheckSeconds = %d; ConfigGuard.kt says 600", MinHealthCheckSeconds)
	}
	if PreferredStack != "system" {
		t.Errorf("PreferredStack = %q; ConfigGuard.kt says \"system\"", PreferredStack)
	}
}

func TestClampsShortHealthCheckInterval(t *testing.T) {
	result := mustEnforce(t, `{
		"outbounds":[
			{"type":"urltest","tag":"auto","interval":"60s"},
			{"type":"selector","tag":"pick"},
			{"type":"direct","tag":"direct"}
		]}`, Options{})

	if result.Clamped != 2 {
		t.Fatalf("clamped %d, expected 2 (the short one and the one with no interval)", result.Clamped)
	}

	var root map[string]any
	if err := json.Unmarshal([]byte(result.Config), &root); err != nil {
		t.Fatal(err)
	}
	for _, raw := range root["outbounds"].([]any) {
		outbound := raw.(map[string]any)
		kind := outbound["type"].(string)
		if kind != "urltest" && kind != "selector" {
			continue
		}
		if got := outbound["interval"]; got != "600s" {
			t.Errorf("%s interval = %v, expected 600s", kind, got)
		}
	}
}

func TestLeavesGenerousIntervalAlone(t *testing.T) {
	// The floor is a floor, not a target. Clamping 1h down to 600s would make the policy
	// worse, which is the kind of bug a one-sided test never catches.
	result := mustEnforce(t,
		`{"outbounds":[{"type":"urltest","tag":"auto","interval":"1h"}]}`, Options{})

	if result.Clamped != 0 {
		t.Errorf("clamped %d, expected 0", result.Clamped)
	}
	if !strings.Contains(result.Config, `"1h"`) {
		t.Errorf("1h interval was rewritten: %s", result.Config)
	}
}

func TestPinsAbsentTunStack(t *testing.T) {
	// Absent means the core's default, which can change between sing-box releases. Pinning
	// it means the log always names what actually ran.
	result := mustEnforce(t, `{"inbounds":[{"type":"tun","tag":"tun-in"}]}`, Options{})

	if !strings.Contains(result.Config, `"stack":"system"`) {
		t.Errorf("absent stack was not pinned: %s", result.Config)
	}
}

func TestWarnsButAcceptsNonPreferredStack(t *testing.T) {
	// This used to be a rejection. On device that rule turned out to be enforcing a stack
	// which carried UDP and dropped TCP entirely, so the guard was protecting a battery
	// policy on a tunnel that moved no traffic. Warn, do not reject.
	result := mustEnforce(t,
		`{"inbounds":[{"type":"tun","tag":"tun-in","stack":"gvisor"}]}`, Options{})

	if !strings.Contains(result.Config, `"stack":"gvisor"`) {
		t.Error("gvisor was rewritten; the guard must not silently change a stack")
	}
	if !hasWarning(result, "gvisor") {
		t.Errorf("no warning about the non-preferred stack: %v", result.Warnings)
	}
}

// ---------------------------------------------------------------------------------------
// Safety — the checks that only matter across a privilege boundary
// ---------------------------------------------------------------------------------------

func TestRejectsNonLoopbackListener(t *testing.T) {
	// THE sharpest edge. nexusd runs as root; an unprivileged caller that could make it bind
	// 0.0.0.0 would turn the machine into an open relay with root's privileges and the
	// user's IP address, from a config that looks entirely ordinary.
	for _, listen := range []string{"0.0.0.0", "::", "192.168.1.10"} {
		config := `{"inbounds":[{"type":"mixed","tag":"in","listen":"` + listen + `","listen_port":1080}]}`
		_, err := enforce(t, config, Options{})
		if err == nil {
			t.Fatalf("SECURITY: accepted a listener on %s", listen)
		}
		if !strings.Contains(err.Error(), "open relay") {
			t.Errorf("rejected %s, but not for the stated reason: %v", listen, err)
		}
	}
}

func TestAcceptsLoopbackListener(t *testing.T) {
	for _, listen := range []string{"127.0.0.1", "::1"} {
		config := `{"inbounds":[{"type":"mixed","tag":"in","listen":"` + listen + `","listen_port":1080}]}`
		if _, err := enforce(t, config, Options{}); err != nil {
			t.Errorf("rejected loopback %s: %v", listen, err)
		}
	}
}

func TestRejectsPrivilegedAndUnknownInbounds(t *testing.T) {
	for _, kind := range []string{"tproxy", "redirect", "direct", "shadowsocks", "vless"} {
		config := `{"inbounds":[{"type":"` + kind + `","tag":"in","listen":"127.0.0.1","listen_port":1080}]}`
		if _, err := enforce(t, config, Options{}); err == nil {
			t.Errorf("SECURITY: accepted inbound type %q", kind)
		}
	}
}

func TestAllowsPrivilegedInboundWhenAskedFor(t *testing.T) {
	config := `{"inbounds":[{"type":"tproxy","tag":"in","listen":"127.0.0.1","listen_port":1080}]}`
	if _, err := enforce(t, config, Options{AllowPrivilegedInbounds: true}); err != nil {
		t.Errorf("the opt-in did not work: %v", err)
	}
}

func TestRejectsPathsOutsideTheStateDir(t *testing.T) {
	stateDir := t.TempDir()

	escapes := []string{
		filepath.Join(stateDir, "..", "..", "etc", "passwd"),
		filepath.Join(os.TempDir(), "somewhere-else", "cache.db"),
	}

	for _, path := range escapes {
		config := `{"experimental":{"cache_file":{"path":` + quote(path) + `}}}`
		_, err := enforce(t, config, Options{StateDir: stateDir})
		if err == nil {
			t.Errorf("SECURITY: accepted a cache path outside the state dir: %s", path)
			continue
		}
		if !strings.Contains(err.Error(), "outside the daemon's state directory") {
			t.Errorf("rejected %s, but not for the stated reason: %v", path, err)
		}
	}
}

func TestAcceptsPathsInsideTheStateDir(t *testing.T) {
	stateDir := t.TempDir()
	config := `{"experimental":{"cache_file":{"path":` +
		quote(filepath.Join(stateDir, "cache.db")) + `}}}`

	if _, err := enforce(t, config, Options{StateDir: stateDir}); err != nil {
		t.Errorf("rejected a path inside the state dir: %v", err)
	}
}

func TestPathCheckIsSkippedWithoutAStateDir(t *testing.T) {
	// `nexusd check` run by hand has no state dir and no privilege boundary. Enforcing paths
	// there would make a legitimate config unvalidatable.
	config := `{"experimental":{"cache_file":{"path":"/anywhere/at/all.db"}}}`
	if _, err := enforce(t, config, Options{}); err != nil {
		t.Errorf("path checking fired with no StateDir set: %v", err)
	}
}

// ---------------------------------------------------------------------------------------
// DNS pre-resolution
// ---------------------------------------------------------------------------------------

func TestRejectsPoisonedAnswers(t *testing.T) {
	// Each of these is a shape a filtering resolver actually returns. 10.10.34.35 is the one
	// that cost a full debug cycle on Android: the tunnel connected to it, every flow closed
	// after ~200 ms having moved nothing, and the app reported "connected" throughout.
	poisoned := map[string]string{
		"10.10.34.35": "private (RFC1918)",
		"127.0.0.1":   "loopback",
		"0.0.0.0":     "wildcard",
		"169.254.1.1": "link-local",
		"224.0.0.1":   "multicast",
	}

	for address, reason := range poisoned {
		resolver := fakeResolver{answers: map[string][]netip.Addr{
			"proxy.example.net": {netip.MustParseAddr(address)},
		}}
		config := `{"outbounds":[{"type":"trojan","tag":"proxy","server":"proxy.example.net","server_port":443}]}`

		_, err := enforce(t, config, Options{Resolver: resolver})
		if err == nil {
			t.Errorf("accepted a %s answer (%s)", reason, address)
			continue
		}
		if !strings.Contains(err.Error(), reason) {
			t.Errorf("%s rejected, but the message does not name %q: %v", address, reason, err)
		}
		if !strings.Contains(err.Error(), "being intercepted") {
			t.Errorf("%s rejected without telling the user what to do: %v", address, err)
		}
	}
}

// withDNS is the shape every app-generated config has: a dns block whose default is chosen
// by `final`, not by position. The hosts server is injected into it.
const withDNS = `"dns":{"servers":[{"type":"https","tag":"dns-direct","server":"1.1.1.1"}],"final":"dns-direct"}`

func TestPreResolvesKeepsHostnameAndPinsResolution(t *testing.T) {
	// Parity with ConfigGuard.kt v1.2.0+. `server` KEEPS the hostname - overwriting it with
	// an IP is what broke REALITY on Android - and the answer is handed to the core as a
	// `hosts` DNS server the outbound is pinned to. tls.server_name is still back-filled.
	resolver := fakeResolver{answers: map[string][]netip.Addr{
		"proxy.example.net": {netip.MustParseAddr("203.0.113.10"), netip.MustParseAddr("203.0.113.11")},
	}}

	result := mustEnforce(t, `{`+withDNS+`,"outbounds":[{
		"type":"vless","tag":"proxy","server":"proxy.example.net","server_port":443,
		"tls":{"enabled":true}
	}]}`, Options{Resolver: resolver})

	if result.Resolved != 1 {
		t.Fatalf("resolved %d, expected 1", result.Resolved)
	}

	outbound := firstOutbound(t, result.Config)
	if got := outbound["server"]; got != "proxy.example.net" {
		t.Errorf("server = %v; the hostname must be kept, not replaced with an IP", got)
	}
	resolverRef, _ := outbound["domain_resolver"].(map[string]any)
	if resolverRef["server"] != hostsDNSTag || resolverRef["strategy"] != "prefer_ipv4" {
		t.Errorf("domain_resolver = %v, expected {server:%s, strategy:prefer_ipv4}", outbound["domain_resolver"], hostsDNSTag)
	}
	tls := outbound["tls"].(map[string]any)
	if got := tls["server_name"]; got != "proxy.example.net" {
		t.Errorf("tls.server_name = %v, expected the original hostname", got)
	}

	servers := dnsServers(t, result.Config)
	if len(servers) != 2 {
		t.Fatalf("dns.servers has %d entries, expected the hosts server plus the original", len(servers))
	}
	hosts := servers[0].(map[string]any)
	if hosts["type"] != "hosts" || hosts["tag"] != hostsDNSTag {
		t.Fatalf("dns.servers[0] = %v, expected the injected hosts server", hosts)
	}
	predefined := hosts["predefined"].(map[string]any)
	got, _ := json.Marshal(predefined["proxy.example.net"])
	if string(got) != `["203.0.113.10","203.0.113.11"]` {
		t.Errorf("predefined answer = %s; every usable address must be kept so the core can retry", got)
	}
	if servers[1].(map[string]any)["tag"] != "dns-direct" {
		t.Errorf("the original dns server was not preserved after the injected one: %v", servers[1])
	}
}

func TestDropsPoisonedAnswersButKeepsTheRest(t *testing.T) {
	// One bad address among several is a filter doing half a job, not a reason to refuse the
	// connection. The previous Go port checked only the FIRST answer, so this exact response
	// was rejected on desktop while Android connected.
	resolver := fakeResolver{answers: map[string][]netip.Addr{
		"proxy.example.net": {netip.MustParseAddr("10.10.34.35"), netip.MustParseAddr("203.0.113.10")},
	}}

	result := mustEnforce(t, `{`+withDNS+`,"outbounds":[{"type":"trojan","tag":"proxy","server":"proxy.example.net","server_port":443}]}`,
		Options{Resolver: resolver})

	hosts := dnsServers(t, result.Config)[0].(map[string]any)
	got, _ := json.Marshal(hosts["predefined"].(map[string]any)["proxy.example.net"])
	if string(got) != `["203.0.113.10"]` {
		t.Errorf("predefined answer = %s; the poisoned address must be dropped and the good one kept", got)
	}
}

func TestRejectsWhenEveryAnswerIsPoisoned(t *testing.T) {
	// The multi-address form of TestRejectsPoisonedAnswers: nothing usable survives, so the
	// config is refused, naming the first answer's reason.
	resolver := fakeResolver{answers: map[string][]netip.Addr{
		"proxy.example.net": {netip.MustParseAddr("10.10.34.35"), netip.MustParseAddr("127.0.0.1")},
	}}

	_, err := enforce(t, `{`+withDNS+`,"outbounds":[{"type":"trojan","tag":"proxy","server":"proxy.example.net","server_port":443}]}`,
		Options{Resolver: resolver})
	if err == nil {
		t.Fatal("accepted a config whose every answer was poisoned")
	}
	if !strings.Contains(err.Error(), "private (RFC1918)") {
		t.Errorf("rejection does not name the first answer's reason: %v", err)
	}
}

func TestSharedHostnameIsResolvedOnce(t *testing.T) {
	// Several nodes on one panel hostname: one lookup, one predefined entry, every outbound
	// pinned to it.
	resolver := &countingResolver{answers: map[string][]netip.Addr{
		"panel.example.net": {netip.MustParseAddr("203.0.113.10")},
	}}

	result := mustEnforce(t, `{`+withDNS+`,"outbounds":[
		{"type":"trojan","tag":"a","server":"panel.example.net","server_port":443},
		{"type":"trojan","tag":"proxy","server":"panel.example.net","server_port":8443}
	]}`, Options{Resolver: resolver})

	if resolver.calls != 1 {
		t.Errorf("looked up %d times, expected once", resolver.calls)
	}
	if result.Resolved != 1 {
		t.Errorf("resolved %d, expected 1 (hostnames, not outbounds)", result.Resolved)
	}

	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Config), &decoded); err != nil {
		t.Fatal(err)
	}
	for _, raw := range decoded["outbounds"].([]any) {
		outbound := raw.(map[string]any)
		if _, ok := outbound["domain_resolver"]; !ok {
			t.Errorf("outbound %v was not pinned to the hosts server", outbound["tag"])
		}
	}
	if n := len(dnsServers(t, result.Config)); n != 2 {
		t.Errorf("dns.servers has %d entries; a shared hostname must produce one hosts server", n)
	}
}

func TestNoDNSBlockLeavesTheHostnameUnpinned(t *testing.T) {
	// The one deliberate difference from ConfigGuard.kt. Kotlin sets domain_resolver even
	// without a dns block and then skips the hosts server, leaving a reference sing-box would
	// refuse at start. Android never produces such a config; nexusctl and tests do. Here the
	// poisoned-answer check still runs, but nothing is pinned.
	resolver := fakeResolver{answers: map[string][]netip.Addr{
		"proxy.example.net": {netip.MustParseAddr("203.0.113.10")},
	}}

	result := mustEnforce(t, `{"outbounds":[{
		"type":"vless","tag":"proxy","server":"proxy.example.net","server_port":443,
		"tls":{"enabled":true}
	}]}`, Options{Resolver: resolver})

	outbound := firstOutbound(t, result.Config)
	if got := outbound["server"]; got != "proxy.example.net" {
		t.Errorf("server = %v; the hostname must be kept", got)
	}
	if _, ok := outbound["domain_resolver"]; ok {
		t.Errorf("domain_resolver set with no dns block to hold its server: %v", outbound["domain_resolver"])
	}
	if !hasWarning(result, "no dns block") {
		t.Errorf("no warning that the answers were not pinned: %v", result.Warnings)
	}
	if got := outbound["tls"].(map[string]any)["server_name"]; got != "proxy.example.net" {
		t.Errorf("tls.server_name = %v; SNI back-fill must not depend on the dns block", got)
	}
}

// countingResolver records how many lookups were made.
type countingResolver struct {
	answers map[string][]netip.Addr
	calls   int
}

func (c *countingResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	c.calls++
	return fakeResolver{answers: c.answers}.LookupNetIP(ctx, network, host)
}

func dnsServers(t *testing.T, configJSON string) []any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(configJSON), &decoded); err != nil {
		t.Fatal(err)
	}
	dns, _ := decoded["dns"].(map[string]any)
	servers, _ := dns["servers"].([]any)
	return servers
}

func TestDoesNotOverwriteAnExplicitServerName(t *testing.T) {
	// A config that already sets server_name has chosen it deliberately — REALITY configs
	// routinely point at a hostname that is not the server's own.
	resolver := fakeResolver{answers: map[string][]netip.Addr{
		"proxy.example.net": {netip.MustParseAddr("203.0.113.10")},
	}}

	result := mustEnforce(t, `{"outbounds":[{
		"type":"vless","tag":"proxy","server":"proxy.example.net","server_port":443,
		"tls":{"enabled":true,"server_name":"www.microsoft.com"}
	}]}`, Options{Resolver: resolver})

	tls := firstOutbound(t, result.Config)["tls"].(map[string]any)
	if got := tls["server_name"]; got != "www.microsoft.com" {
		t.Errorf("tls.server_name = %v; an explicit value must survive", got)
	}
}

func TestLeavesUnresolvableHostnameForTheCore(t *testing.T) {
	// Failing the whole connect because one lookup missed would be worse than trying: the
	// core may still manage it, and the user gets a real error from the real attempt.
	resolver := fakeResolver{answers: map[string][]netip.Addr{}}

	result := mustEnforce(t,
		`{"outbounds":[{"type":"trojan","tag":"proxy","server":"nope.example.net","server_port":443}]}`,
		Options{Resolver: resolver})

	if result.Resolved != 0 {
		t.Errorf("resolved %d, expected 0", result.Resolved)
	}
	if got := firstOutbound(t, result.Config)["server"]; got != "nope.example.net" {
		t.Errorf("server = %v; the hostname should have been left in place", got)
	}
	if !hasWarning(result, "could not resolve") {
		t.Errorf("no warning about the failed lookup: %v", result.Warnings)
	}
	// Warnings go to the in-app log, which the Logs screen copies; they must not name the server.
	if hasWarning(result, "nope.example.net") {
		t.Errorf("a warning names the server: %v", result.Warnings)
	}
}

func TestSkipsIPLiterals(t *testing.T) {
	// An IP literal needs no lookup, and passing one to a resolver is how you get a
	// surprising reverse-DNS round trip on every connect.
	resolver := fakeResolver{err: &net_NotFound{"should not be called"}}

	result := mustEnforce(t,
		`{"outbounds":[{"type":"trojan","tag":"proxy","server":"203.0.113.10","server_port":443}]}`,
		Options{Resolver: resolver})

	if result.Resolved != 0 {
		t.Errorf("resolved %d; an IP literal should not be looked up", result.Resolved)
	}
}

// ---------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------

func TestDescribeRedactsCredentialsWithoutMutating(t *testing.T) {
	config := `{"outbounds":[{
		"type":"vless","tag":"proxy","server":"203.0.113.10","server_port":443,
		"uuid":"11111111-2222-3333-4444-555555555555",
		"tls":{"enabled":true,"server_name":"sni.example.com",
			"reality":{"enabled":true,"public_key":"PUBLICKEY","short_id":"abcd","private_key":"SECRET"}},
		"transport":{"type":"ws","path":"/ws-path","headers":{"Host":"cdn.example.com"}}
	}]}`

	described, err := DescribeProxyOutbound(config)
	if err != nil {
		t.Fatal(err)
	}

	for _, secret := range []string{"11111111-2222", "SECRET"} {
		if strings.Contains(described, secret) {
			t.Errorf("a credential survived redaction: %s", described)
		}
	}
	// Nor anything that says WHICH server this is. The desktop log ring keeps every level, and
	// the Logs screen copies it into bug reports.
	for _, endpoint := range []string{"203.0.113.10", "sni.example.com", "PUBLICKEY", "abcd", "/ws-path", "cdn.example.com"} {
		if strings.Contains(described, endpoint) {
			t.Errorf("an endpoint detail (%s) survived redaction: %s", endpoint, described)
		}
	}

	// THE ONE THAT WOULD BE CATASTROPHIC. Redacting in place would hand sing-box a config
	// whose password is literally "***", and the tunnel would fail to authenticate with no
	// obvious cause.
	if !strings.Contains(config, "11111111-2222") || !strings.Contains(config, "sni.example.com") {
		t.Error("DescribeProxyOutbound mutated the config it was given")
	}
}

// The line is still worth logging: everything that tells two failure modes apart survives - the
// protocol, port, flow, transport type, fingerprint - and every withheld field still says
// whether it was set, because an empty SNI or short ID is often the bug.
func TestDescribeKeepsWhatDiagnosesANode(t *testing.T) {
	config := `{"outbounds":[{
		"type":"vless","tag":"proxy","server":"203.0.113.10","server_port":8443,"flow":"xtls-rprx-vision",
		"domain_resolver":{"server":"dns-hosts","strategy":"prefer_ipv4"},
		"tls":{"enabled":true,"server_name":"","utls":{"enabled":true,"fingerprint":"chrome"},
			"reality":{"enabled":true,"public_key":"PUBLICKEY","short_id":""}},
		"transport":{"type":"grpc","service_name":"svc"}
	}]}`

	described, err := DescribeProxyOutbound(config)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err = json.Unmarshal([]byte(described), &got); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	tls := got["tls"].(map[string]any)
	reality := tls["reality"].(map[string]any)
	transport := got["transport"].(map[string]any)

	for name, check := range map[string]bool{
		"type kept":                         got["type"] == "vless",
		"server_port kept":                  got["server_port"] == float64(8443),
		"flow kept":                         got["flow"] == "xtls-rprx-vision",
		"server marked as set":              got["server"] == withheldValue,
		"an empty SNI stays visibly empty":  tls["server_name"] == "",
		"utls fingerprint kept":             tls["utls"].(map[string]any)["fingerprint"] == "chrome",
		"reality enabled kept":              reality["enabled"] == true,
		"public key marked as set":          reality["public_key"] == withheldValue,
		"an empty short ID stays empty":     reality["short_id"] == "",
		"transport type kept":               transport["type"] == "grpc",
		"service name marked as set":        transport["service_name"] == withheldValue,
		"DNS server tag in domain_resolver": got["domain_resolver"].(map[string]any)["server"] == "dns-hosts",
	} {
		if !check {
			t.Errorf("%s: %s", name, described)
		}
	}
}

// VLESS Encryption (1.3.3) carries the server's key material in one string. It must leave the
// log as withheldValue, like a REALITY public key, while the ML-KEM switch - an on/off that
// names no server - stays readable.
func TestDescribeWithholdsVlessEncryption(t *testing.T) {
	config := `{"outbounds":[{
		"type":"vless","tag":"proxy","server":"203.0.113.10","server_port":443,
		"uuid":"11111111-2222-3333-4444-555555555555",
		"encryption":"mlkem768x25519plus.native.0rtt.SERVERKEYMATERIAL0123456789abcdefABCDEF",
		"tls":{"enabled":true,"server_name":"sni.example.com",
			"reality":{"enabled":true,"public_key":"PUBLICKEY","short_id":"abcd","support_x25519mlkem768":true}}
	}]}`

	described, err := DescribeProxyOutbound(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"SERVERKEYMATERIAL", "mlkem768x25519plus", "native.0rtt"} {
		if strings.Contains(described, leak) {
			t.Errorf("the VLESS Encryption value survived redaction (%s): %s", leak, described)
		}
	}

	var got map[string]any
	if err = json.Unmarshal([]byte(described), &got); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if got["encryption"] != withheldValue {
		t.Errorf("encryption not marked as set: %s", described)
	}
	reality := got["tls"].(map[string]any)["reality"].(map[string]any)
	if reality["support_x25519mlkem768"] != true {
		t.Errorf("the ML-KEM switch should stay readable: %s", described)
	}
	if !strings.Contains(config, "SERVERKEYMATERIAL") {
		t.Error("DescribeProxyOutbound mutated the config it was given")
	}
}

// ---------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------

func TestRejectsNonJSON(t *testing.T) {
	if _, err := enforce(t, "not json at all", Options{}); err == nil {
		t.Fatal("accepted a non-JSON config")
	}
}

func TestWarnsWhenNoProxyOutboundExists(t *testing.T) {
	result := mustEnforce(t, `{"outbounds":[{"type":"direct","tag":"direct"}]}`, Options{})
	if !hasWarning(result, `no outbound tagged "proxy"`) {
		t.Errorf("no warning about the missing proxy outbound: %v", result.Warnings)
	}
}

func hasWarning(result *Result, needle string) bool {
	for _, warning := range result.Warnings {
		if strings.Contains(warning, needle) {
			return true
		}
	}
	return false
}

func firstOutbound(t *testing.T, configJSON string) map[string]any {
	t.Helper()
	var root map[string]any
	if err := json.Unmarshal([]byte(configJSON), &root); err != nil {
		t.Fatal(err)
	}
	return root["outbounds"].([]any)[0].(map[string]any)
}

func quote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
