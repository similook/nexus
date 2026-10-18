// Package guard validates and rewrites a sing-box config before a privileged daemon runs it.
//
// ============================================================================================
// THIS IS THE SAME LOGIC AS ConfigGuard.kt, WITH A DIFFERENT JOB
//
// On Android, ConfigGuard is a POLICY guard. The config is generated in the app's own WebView
// and consumed by the app's own service — same sandbox, same uid, no trust boundary. What it
// protects against is a mistake: a template edit or a bad subscription silently undoing the
// battery decisions that ADR-0001 records in config fields rather than in code.
//
// On desktop it is a SECURITY control, and the difference is not rhetorical. nexusd runs as
// root / LocalSystem and accepts a config over a socket from an unprivileged process. That is
// a privilege boundary, and a sing-box config is not inert data across one — it can bind
// listeners, choose file paths, and install routes. A config is closer to a script than to a
// document, and this package is the thing standing between "the user's GUI asked for a
// tunnel" and "an unprivileged local process got root to open a port for it".
//
// So the checks come in two families:
//
//	POLICY   ported from ConfigGuard.kt. Health-check floors, TUN stack preference, DNS
//	         pre-resolution with poisoned-answer rejection. Same reasoning, same numbers.
//	SAFETY   new, and only meaningful here. Restrict what an inbound may be and where it may
//	         listen; refuse file paths we did not choose; refuse options that need privileges
//	         beyond the tunnel itself.
//
// ADR-0002 §2 has always said config generation belongs in Go. This is the first piece of it
// to actually land there.
//
// # WHERE THIS LEAVES THE KOTLIN
//
// It stays. clients/web is frozen, and Android still needs a guard today. The two are now a
// known pair — guard_test.go pins the shared numbers so a change to one is visible as a test
// edit rather than as silent drift.
// ============================================================================================
package guard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// PreferredStack is ADR-0001 §5.4's preference. A preference, not a requirement — see
// checkTun for why that changed.
const PreferredStack = "system"

// MinHealthCheckSeconds is the floor for any url-test / selector interval.
//
// ADR-0001 §2.1: a 100-node group at the Clash-lineage 300 s default is 100 TLS handshakes
// every five minutes, forever. We do not ship that. Identical to ConfigGuard.kt's
// MIN_HEALTH_CHECK_SECONDS, and guard_test.go pins the value so the two cannot drift quietly.
const MinHealthCheckSeconds = 600

// resolveTimeout bounds the pre-resolution lookup.
//
// The whole point of resolving here is that the tunnel cannot come up until the server's
// address is known, so a hung lookup is a hung connect. The system resolver is the one that
// works on the networks this client targets, but "works" does not mean "fast".
const resolveTimeout = 5 * time.Second

// RejectedError is a config we refuse to run. Distinct from a decode failure so the caller can
// tell "you sent nonsense" from "you sent something we will not do".
type RejectedError struct{ Reason string }

func (e *RejectedError) Error() string { return "config rejected: " + e.Reason }

func reject(format string, args ...any) error {
	return &RejectedError{Reason: fmt.Sprintf(format, args...)}
}

// Result is what Enforce produces: the config to run, plus what had to be changed to make it
// runnable. The notes are for the log and for the user, not for control flow.
type Result struct {
	Config  string
	Clamped int
	// Resolved counts distinct server HOSTNAMES pre-resolved, not outbounds: several nodes on
	// one panel hostname share one lookup. Matches ConfigGuard.kt's return value.
	Resolved int
	Warnings []string
}

// Options tunes the safety checks for the environment the daemon is running in.
type Options struct {
	// StateDir is the only directory a config may name. Empty disables path checking, which
	// is correct for `nexusd check` run by hand and wrong for anything reached over a socket.
	StateDir string

	// AllowPrivilegedInbounds permits tproxy/redirect inbounds. Off by default: they need
	// capabilities beyond the tunnel and nothing in Nexus generates them.
	AllowPrivilegedInbounds bool

	// Resolver is the DNS resolver used for pre-resolution. nil means the system resolver,
	// which is the intended production value; tests inject their own.
	Resolver Resolver
}

// Resolver is the slice of net.Resolver this package needs, so tests can supply a poisoned
// answer without a DNS server.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Enforce is the entry point: validate, rewrite, and return the config to run.
//
// Order matters. Safety checks run FIRST, before anything touches the network, so a hostile
// config is refused without us performing lookups on its behalf. Only then do the policy
// rewrites and the pre-resolution happen.
func Enforce(ctx context.Context, configJSON string, options Options) (*Result, error) {
	var root map[string]any
	if err := json.Unmarshal([]byte(configJSON), &root); err != nil {
		return nil, reject("not valid JSON: %v", err)
	}

	result := &Result{}

	// ---- SAFETY: refuse before we act on it -------------------------------------------
	if err := checkInbounds(root, options, result); err != nil {
		return nil, err
	}
	if err := checkPaths(root, options); err != nil {
		return nil, err
	}

	// ---- POLICY: rewrite what merely exceeds a bound -----------------------------------
	checkTun(root, result)
	result.Clamped = clampHealthChecks(root)

	// WHY THE SYSTEM RESOLVER, AND WHY THAT IS NOT A CONTRADICTION.
	//
	// Everything else in this project treats the local resolver as hostile, and it is. But
	// the proxy server's own hostname is the one lookup that must happen BEFORE the tunnel
	// exists, and on the networks this client targets the encrypted alternatives are not
	// reachable — DoH to 1.1.1.1 is reset outright. Pointing default_domain_resolver at it
	// made EVERY connection fail, because every connection needs the server's address first.
	//
	// So: the system resolver, with a guard. assertUsableAddress rejects the shapes a
	// poisoned answer takes. A loud failure beats a tunnel pointed at a blackhole.
	resolved, err := resolveOutboundServers(ctx, root, options, result)
	if err != nil {
		return nil, err
	}
	result.Resolved = resolved

	if !hasProxyOutbound(root) {
		result.Warnings = append(result.Warnings,
			`no outbound tagged "proxy" - the route final has nothing to point at`)
	}

	rewritten, err := json.Marshal(root)
	if err != nil {
		return nil, fmt.Errorf("re-encode config: %w", err)
	}
	result.Config = string(rewritten)
	return result, nil
}

// ---------------------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------------------

// allowedInbounds is an allow-list, deliberately.
//
// A deny-list would have to be updated every time sing-box gains an inbound type, and the
// failure mode of forgetting is that a privileged daemon starts accepting something nobody
// reviewed. Nexus generates exactly one inbound — tun — and the local proxy types are here
// only because they are useful for testing and are harmless on loopback.
var allowedInbounds = map[string]bool{
	"tun": true, "mixed": true, "socks": true, "http": true,
}

// privilegedInbounds need capabilities beyond the tunnel and are off unless asked for.
var privilegedInbounds = map[string]bool{
	"tproxy": true, "redirect": true, "direct": true,
}

func checkInbounds(root map[string]any, options Options, result *Result) error {
	inbounds, _ := root["inbounds"].([]any)

	for index, raw := range inbounds {
		inbound, ok := raw.(map[string]any)
		if !ok {
			return reject("inbounds[%d] is not an object", index)
		}

		kind, _ := inbound["type"].(string)

		// These are ALTERNATIVES, not a sequence. Written as two sequential ifs, the
		// allow-list below rejected a privileged inbound even when AllowPrivilegedInbounds
		// had just permitted it — the opt-in silently did nothing. Caught by
		// TestAllowsPrivilegedInboundWhenAskedFor, which is the only reason it is not still
		// there: nothing in Nexus sets that flag today, so no caller would have noticed.
		switch {
		case privilegedInbounds[kind]:
			if !options.AllowPrivilegedInbounds {
				return reject(
					"inbounds[%d] type %q needs privileges beyond the tunnel and nothing in "+
						"Nexus generates it", index, kind)
			}
		case !allowedInbounds[kind]:
			return reject("inbounds[%d] type %q is not permitted", index, kind)
		}

		// A LISTENER ON A NON-LOOPBACK ADDRESS IS AN OPEN PROXY.
		//
		// This is the sharpest edge in the whole package. nexusd runs as root; an
		// unprivileged local process that can hand it a config could otherwise ask it to
		// bind 0.0.0.0 and turn the machine into an open relay for the whole network — with
		// the root daemon's privileges and the user's IP address. The config would look
		// entirely ordinary.
		//
		// tun has no `listen` and is unaffected.
		if listen, present := inbound["listen"].(string); present && listen != "" {
			if err := assertLoopback(index, listen); err != nil {
				return err
			}
		}
	}

	if len(inbounds) == 0 {
		result.Warnings = append(result.Warnings,
			"config has no inbounds - nothing will carry traffic")
	}
	return nil
}

func assertLoopback(index int, listen string) error {
	address, err := netip.ParseAddr(listen)
	if err != nil {
		return reject("inbounds[%d] listen %q is not an IP address", index, listen)
	}
	if !address.IsLoopback() {
		return reject(
			"inbounds[%d] listens on %s, which is reachable from the network. A privileged "+
				"daemon binding a non-loopback proxy port is an open relay; use 127.0.0.1",
			index, listen)
	}
	return nil
}

// pathFields are the config fields that name a file, as a JSON path with * for "any index".
//
// Enumerated rather than discovered by walking every string, because a heuristic that guesses
// which strings are paths would reject a server named like a path and miss a field added
// upstream. This list is checked against the schema when the core version is bumped, which
// CLAUDE.md already makes a reviewed change.
var pathFields = [][]string{
	{"log", "output"},
	{"experimental", "cache_file", "path"},
	{"experimental", "clash_api", "external_ui"},
}

func checkPaths(root map[string]any, options Options) error {
	if options.StateDir == "" {
		return nil
	}

	base, err := filepath.Abs(options.StateDir)
	if err != nil {
		return fmt.Errorf("resolve state dir: %w", err)
	}

	for _, path := range pathFields {
		value, ok := lookupString(root, path)
		if !ok || value == "" {
			continue
		}

		candidate, err := filepath.Abs(value)
		if err != nil {
			return reject("%s is not a usable path: %v", strings.Join(path, "."), err)
		}

		// filepath.Rel + ".." is the check that survives symlink-free traversal attempts
		// like "state/../../etc/passwd". It is not a defence against symlinks; on desktop
		// the state dir is root-owned, so planting one there already requires root.
		relative, err := filepath.Rel(base, candidate)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return reject(
				"%s points outside the daemon's state directory (%s). A privileged daemon "+
					"must not write where an unprivileged caller chooses",
				strings.Join(path, "."), base)
		}
	}
	return nil
}

func lookupString(root map[string]any, path []string) (string, bool) {
	var current any = root
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return "", false
		}
		current, ok = object[key]
		if !ok {
			return "", false
		}
	}
	value, ok := current.(string)
	return value, ok
}

// ---------------------------------------------------------------------------------------
// POLICY  (ported from ConfigGuard.kt)
// ---------------------------------------------------------------------------------------

// checkTun warns rather than rejects, and the history matters.
//
// This once threw for any stack other than "system", enforcing ADR-0001 §5.4 absolutely. On
// device that rule turned out to be enforcing a stack that carried UDP and dropped TCP
// entirely — so the guard was protecting a battery policy on a tunnel that moved no traffic.
//
// A policy guard should make an expensive choice visible, not make a working configuration
// impossible. The preference is still recorded, loudly, on every connect that departs from it.
func checkTun(root map[string]any, result *Result) {
	inbounds, _ := root["inbounds"].([]any)

	for _, raw := range inbounds {
		inbound, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if kind, _ := inbound["type"].(string); kind != "tun" {
			continue
		}

		stack, _ := inbound["stack"].(string)
		switch {
		case stack == "":
			// Absent means the core's default. Pin it so the log always names what ran.
			inbound["stack"] = PreferredStack
		case stack != PreferredStack:
			result.Warnings = append(result.Warnings, fmt.Sprintf(
				"tun stack is %q, not %q (ADR-0001 §5.4). gvisor reassembles TCP in userspace "+
					"and costs CPU per packet, which is battery. Measure it in bench/ before "+
					"this becomes permanent", stack, PreferredStack))
		}

		// auto_redirect installs extra firewall state and forces per-connection owner
		// lookups (SagerNet/sing-box#3934) — a documented CPU sink. On desktop it also needs
		// privileges beyond the tunnel, which is why this is a rejection here and only a
		// warning on Android.
		if enabled, _ := inbound["auto_redirect"].(bool); enabled {
			result.Warnings = append(result.Warnings,
				"auto_redirect is enabled - it installs extra firewall state and costs a "+
					"per-connection owner lookup")
		}
	}
}

func clampHealthChecks(root map[string]any) int {
	outbounds, _ := root["outbounds"].([]any)
	clamped := 0

	for _, raw := range outbounds {
		outbound, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := outbound["type"].(string)
		if kind != "urltest" && kind != "selector" {
			continue
		}

		interval, _ := outbound["interval"].(string)
		seconds, valid := parseDuration(interval)

		switch {
		case interval == "":
			// No interval means the core's default, which is short. Pin it.
			outbound["interval"] = fmt.Sprintf("%ds", MinHealthCheckSeconds)
			clamped++
		case valid && seconds < MinHealthCheckSeconds:
			outbound["interval"] = fmt.Sprintf("%ds", MinHealthCheckSeconds)
			clamped++
		}
	}
	return clamped
}

// parseDuration handles the Go duration subset sing-box actually emits: "300s", "5m", "1h".
func parseDuration(value string) (int, bool) {
	if len(value) < 2 {
		return 0, false
	}
	number, err := strconv.Atoi(value[:len(value)-1])
	if err != nil {
		return 0, false
	}
	switch value[len(value)-1] {
	case 's':
		return number, true
	case 'm':
		return number * 60, true
	case 'h':
		return number * 3600, true
	default:
		return 0, false
	}
}

// hostsDNSTag names the injected `hosts` DNS server. Same tag as ConfigGuard.kt's
// HOSTS_DNS_TAG, so a config dumped from either platform reads the same.
const hostsDNSTag = "dns-hosts"

// resolveOutboundServers pre-resolves outbound server hostnames and hands the answers to the
// core as data, KEEPING the hostname in `server`.
//
// Ported from ConfigGuard.kt as of v1.2.0, where this replaced the original approach of
// overwriting `server` with an IP literal. That approach worked on networks where DNS is
// blocked but broke REALITY: the outbound had no hostname of its own and the connection was
// pinned to a single address. Removing the rewrite fixed REALITY and broke the blocked case
// instead - the core could not resolve at all ("dns: lookup failed ... connection reset").
//
// Pointing each outbound at a `hosts` DNS server gets both. The core is handed the answer, so
// nothing is looked up at connect time and no resolver has to be reachable; and `server` stays
// a hostname, so SNI, REALITY and retry-across-addresses all behave normally. That design is
// device-verified on Android from v1.2.0 through v1.3.1 against a live REALITY node.
//
// It has to be per-outbound `domain_resolver` rather than a dns rule: the route-level
// default_domain_resolver skips dns.rules entirely (sing-box dns/router.go takes
// `if options.Transport != nil` straight to client.Lookup), so a rule would never be consulted.
//
// ONE DELIBERATE DIFFERENCE FROM THE KOTLIN. ConfigGuard.kt sets domain_resolver even when the
// config has no dns block, then skips injecting the hosts server - leaving a reference to a
// server that does not exist, which sing-box refuses at start. Android never hits it, because
// every config the app generates has a dns block. The daemon also accepts configs from
// nexusctl and tests, which often do not, so here a missing dns block means neither half is
// applied: the hostname is left for the core, with a warning. For every app-generated config
// the output is identical to Android's.
func resolveOutboundServers(ctx context.Context, root map[string]any, options Options, result *Result) (int, error) {
	outbounds, _ := root["outbounds"].([]any)
	resolver := options.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}

	_, hasDNS := root["dns"].(map[string]any)

	// host -> every usable address. Shared across outbounds, so several nodes on one panel
	// hostname cost one lookup and produce one entry. `order` keeps the output deterministic;
	// a Go map alone would reorder the injected predefined block from run to run.
	resolved := map[string][]netip.Addr{}
	var order []string

	for _, raw := range outbounds {
		outbound, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		host, _ := outbound["server"].(string)
		if host == "" || isIPLiteral(host) {
			continue
		}

		// Resolve once per hostname. Reaching the far side of this block means the host has
		// usable addresses recorded - every failure path inside continues or returns.
		if _, done := resolved[host]; !done {
			lookup, cancel := context.WithTimeout(ctx, resolveTimeout)
			found, err := resolver.LookupNetIP(lookup, "ip", host)
			cancel()

			if err != nil || len(found) == 0 {
				// Leave the hostname in place. The core may still manage it, and failing the
				// whole connect because one lookup missed would be worse than trying.
				result.Warnings = append(result.Warnings,
					"could not resolve an outbound's server name; leaving it for the core")
				continue
			}

			// Drop poisoned answers and keep the rest. Refusing the config outright is
			// reserved for the case where NOTHING survives: one bad address among several is
			// a filter doing half a job, not a reason to refuse to connect. (The previous Go
			// port checked only the first answer, so a single poisoned A record ahead of good
			// ones refused a connection Android would have made.)
			var usable []netip.Addr
			for _, address := range found {
				if unusableReason(address.Unmap()) == "" {
					usable = append(usable, address.Unmap())
				}
			}
			if len(usable) == 0 {
				// Everything came back poisoned. Check the first purely to raise the existing,
				// carefully worded rejection with the right reason in it.
				return len(order), assertUsableAddress(host, found[0].Unmap())
			}

			resolved[host] = usable
			order = append(order, host)
		}

		// Back-fill SNI when the link carried none. Still needed even though `server` keeps
		// the hostname: an outbound with TLS enabled and no server_name lets the core derive
		// one, and for REALITY that is not necessarily the same string.
		if tls, ok := outbound["tls"].(map[string]any); ok {
			if enabled, _ := tls["enabled"].(bool); enabled {
				if name, _ := tls["server_name"].(string); name == "" {
					tls["server_name"] = host
				}
			}
		}

		if hasDNS {
			outbound["domain_resolver"] = map[string]any{
				"server":   hostsDNSTag,
				"strategy": "prefer_ipv4",
			}
		}
	}

	if len(order) > 0 {
		if hasDNS {
			injectHostsServer(root, resolved, order)
		} else {
			result.Warnings = append(result.Warnings,
				"config has no dns block; resolved addresses were checked but not pinned")
		}
	}
	return len(order), nil
}

// injectHostsServer publishes the resolved addresses as a `hosts` DNS server - a baked-in
// answer with no query, no transport and no network behind it, which is what makes a connect
// possible on a network where every resolver the machine can reach is blocked or lying.
//
// Prepended rather than appended. Servers are selected by tag, not by order (dns.final names
// its own), so this is presentation only: it puts the baked-in answers first in a dumped
// config, as ConfigGuard.kt does.
func injectHostsServer(root map[string]any, resolved map[string][]netip.Addr, order []string) {
	dns := root["dns"].(map[string]any)

	predefined := map[string]any{}
	for _, host := range order {
		list := make([]any, 0, len(resolved[host]))
		for _, address := range resolved[host] {
			list = append(list, address.String())
		}
		predefined[host] = list
	}

	existing, _ := dns["servers"].([]any)
	servers := make([]any, 0, len(existing)+1)
	servers = append(servers, map[string]any{
		"type":       "hosts",
		"tag":        hostsDNSTag,
		"predefined": predefined,
	})
	dns["servers"] = append(servers, existing...)
}

func isIPLiteral(host string) bool {
	_, err := netip.ParseAddr(host)
	return err == nil
}

// unusableReason names why an address cannot be a real proxy server, or returns "" if it can.
// Shared by the filter in resolveOutboundServers and by assertUsableAddress, so the two cannot
// disagree about what "poisoned" means - the same split ConfigGuard.kt made in v1.2.0.
func unusableReason(address netip.Addr) string {
	// ORDER MATTERS, and not in the obvious way. 224.0.0.0/24 is link-local multicast, so
	// IsLinkLocalMulticast() matches it — putting the link-local case first made 224.0.0.1
	// report as "link-local", which is true but not the word a reader wants. Multicast is
	// the more useful description and covers the whole of 224/4, so it goes first.
	switch {
	case address.IsLoopback():
		return "loopback"
	case address.IsUnspecified():
		return "wildcard"
	case address.IsMulticast():
		return "multicast"
	case address.IsLinkLocalUnicast():
		return "link-local"
	case address.IsPrivate():
		return "private (RFC1918)"
	default:
		return ""
	}
}

// assertUsableAddress refuses an answer that cannot be a real proxy server.
//
// This is the guard that makes using the system resolver defensible. A censor's answer is not
// subtle — it points somewhere that could never host the service:
//
//	inbound/tun[tun-in]: inbound packet connection to 10.10.34.35:443
//
// That address is RFC1918: private, therefore unreachable across the internet, therefore never
// a public proxy server. Redirecting blocked lookups to a private-range blackhole is a common
// filtering technique, and the particular address varies by network — so this checks the
// PROPERTY rather than matching a list of known ones.
//
// Without it the tunnel connects to the blackhole, every flow closes after ~200 ms having
// moved nothing, and the client reports "connected" the whole time. That is the worst possible
// failure: silent, and it looks like the server's fault.
func assertUsableAddress(host string, address netip.Addr) error {
	reason := unusableReason(address)
	if reason == "" {
		return nil
	}

	return reject(
		"DNS returned a %s address for %s (%s). That is not a reachable server - the local "+
			"resolver is almost certainly being intercepted. Try another node, or a different "+
			"network", reason, host, address)
}

func hasProxyOutbound(root map[string]any) bool {
	outbounds, _ := root["outbounds"].([]any)
	for _, raw := range outbounds {
		if outbound, ok := raw.(map[string]any); ok {
			if tag, _ := outbound["tag"].(string); tag == "proxy" {
				return true
			}
		}
	}
	return false
}

// ---------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------

// secretKeys are the fields that are the whole credential.
var secretKeys = map[string]bool{
	"uuid": true, "password": true, "private_key": true,
	"psk": true, "auth": true, "auth_str": true, "token": true,
}

// endpointKeys say WHICH server a node is - its address, the name and key it presents, its
// transport host and path - without being credentials.
//
// They are withheld from the log too. On Android this line is debug-build only (NexusLog.d);
// here the log ring keeps every level, and the Logs screen shows it and copies it into bug
// reports. What a value was is rarely the question, whether it was set often is - an empty SNI
// or a missing short ID - so a value that was set becomes withheldValue and an empty one stays
// empty.
//
// "encryption" is VLESS Encryption (mlkem768x25519plus.<mode>.<rtt>.<server keys>): it carries
// the server's public key material, so it names the server as surely as a REALITY public_key.
// The ML-KEM switch (tls.reality.support_x25519mlkem768) is a plain on/off and names nothing;
// it stays, because whether it was on is exactly what a "Handshake failed" report needs.
var endpointKeys = map[string]bool{
	"server": true, "server_name": true, "public_key": true, "short_id": true,
	"host": true, "path": true, "service_name": true, "headers": true,
	"encryption": true,
}

// withheldValue replaces an endpoint detail that was set. See endpointKeys. No angle brackets:
// json.Marshal escapes them, and the Logs screen would show the escape codes.
const withheldValue = "[redacted]"

// DescribeProxyOutbound renders the proxy outbound for logging, with credentials replaced and
// endpoint details withheld (secretKeys, endpointKeys).
//
// # WHY THIS IS WORTH THE LOG LINE
//
// The tunnel plumbing and the outbound are different failure domains and from the outside they
// look identical: nothing loads. Distinguishing them cost several debug cycles on Android. The
// case that forced it was
//
//	connection: connection download closed: unknown version: 72
//
// 72 is 0x48, ASCII 'H' — the server's first response byte was the start of "HTTP/1.1", so
// whatever answered was not speaking VLESS. That is either a dead endpoint or a transport the
// URI asked for and the parser dropped. Those need completely different fixes, and only the
// generated outbound tells them apart.
func DescribeProxyOutbound(configJSON string) (string, error) {
	var root map[string]any
	if err := json.Unmarshal([]byte(configJSON), &root); err != nil {
		return "", err
	}

	outbounds, _ := root["outbounds"].([]any)
	for _, raw := range outbounds {
		outbound, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if tag, _ := outbound["tag"].(string); tag != "proxy" {
			continue
		}
		rendered, err := json.Marshal(redact(outbound))
		if err != nil {
			return "", err
		}
		return string(rendered), nil
	}
	return "", errors.New(`no outbound tagged "proxy"`)
}

// redact returns a copy. The original must not be mutated — it is the config we are about to
// run, and redacting it in place would hand sing-box a tunnel with the password "***".
func redact(node map[string]any) map[string]any {
	out := make(map[string]any, len(node))
	for key, value := range node {
		switch {
		case secretKeys[key]:
			out[key] = "***"
		case key == "domain_resolver":
			// A DNS server tag (the guard's dns-hosts), not an address: kept, so the line still
			// shows whether the outbound was pinned to the pre-resolved answers.
			out[key] = value
		case endpointKeys[key]:
			out[key] = withheld(value)
		default:
			if nested, ok := value.(map[string]any); ok {
				out[key] = redact(nested)
			} else {
				out[key] = value
			}
		}
	}
	return out
}

// withheld keeps an empty value as it is and replaces anything else with withheldValue.
func withheld(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		if typed == "" {
			return ""
		}
	case []any:
		if len(typed) == 0 {
			return typed
		}
	case map[string]any:
		if len(typed) == 0 {
			return typed
		}
	}
	return withheldValue
}
