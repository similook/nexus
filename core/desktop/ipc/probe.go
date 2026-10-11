package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing/common/control"

	engine "github.com/nexus/nexus-core/desktop/probe"
	"github.com/nexus/nexus-core/desktop/tunnel"
)

// ============================================================================================
// TEST ALL ON DESKTOP: KEEPING THE PROBES OUT OF THE TUNNEL
//
// The engine (desktop/probe, nexuscore's on Android) runs each server's own outbound in a
// short-lived instance with no inbound, no TUN and no listener, beside the tunnel and never in
// it. What differs on a desktop is the network around it.
//
// On Android the app's own sockets are on its VpnService deny list. A desktop TUN is
// system-wide and has no such list, so while one is up a plain socket from this process is
// captured by it: a probe would be relayed through the ACTIVE server, and its DNS answered by
// the tunnel's fakeip. Two things keep a probe on the physical network instead, both taken
// from the tunnel's own upstream rather than reinvented:
//
//   - every probe outbound gets bind_interface = the interface the tunnel itself sends its
//     proxy connections on (tunnel.UpstreamInterface, sing-box's auto_detect_interface pick) -
//     the same IP_UNICAST_IF binding that keeps the tunnel from looping through itself;
//   - server names are resolved by DNS servers of THAT interface, over sockets bound to it
//     (physicalDNSServers), not by the system resolver, which the tun's DNS hijack answers.
//
// With no tunnel up, nothing is bound and the system resolver is used - Android's behaviour.
// If a tunnel is up but its upstream interface is unknown, the run is refused rather than
// risking probes through the tunnel.
//
// The running tunnel is only READ (which interface it uses); nothing about it is changed. If
// it starts, stops or is replaced during a run, the run is cancelled and its results dropped:
// a probe begun outside one network state must not report from inside another.
// ============================================================================================

// probeResolveTimeout bounds one server-name lookup; the engine's per-server budget is 6 s.
const probeResolveTimeout = 4 * time.Second

// probeRuns tracks the run in progress, so it can be cancelled when the client that started it
// goes away (the GUI drops its link while hidden - R1 - which is the desktop's backgrounding).
type probeRuns struct {
	mu    sync.Mutex
	runID int64
	owner *client
}

// probeRoute is how probes reach the network right now.
type probeRoute struct {
	active   *tunnel.Tunnel // nil: no tunnel, plain OS routing
	iface    string
	index    int
	resolver engine.HostResolver
}

func (s *Server) probeRoute() (probeRoute, error) {
	s.mu.Lock()
	active := s.active
	s.mu.Unlock()
	if active == nil {
		return probeRoute{resolver: systemResolver{}}, nil
	}
	name, index, ok := active.UpstreamInterface()
	if !ok {
		return probeRoute{}, errors.New("the tunnel has no network interface to test from right now")
	}
	return probeRoute{active: active, iface: name, index: index, resolver: boundResolver{name: name, index: index}}, nil
}

func (s *Server) probeServers(c *client, params ProbeServersParams) (ProbeServersResult, error) {
	if params.RunID <= 0 || len(params.Targets) == 0 {
		return ProbeServersResult{}, errors.New("probeServers: runId and targets are required")
	}
	route, err := s.probeRoute()
	if err != nil {
		return ProbeServersResult{}, err
	}
	targets := make([]ProbeTarget, len(params.Targets))
	for i, target := range params.Targets {
		targets[i] = target
		if route.active != nil {
			targets[i].Config = bindProxyOutbound(target.Config, route.iface)
		}
	}
	content, err := json.Marshal(targets)
	if err != nil {
		return ProbeServersResult{}, errors.New("probeServers: could not encode targets")
	}

	handler := &probeEvents{server: s, tunnel: route.active}
	s.probes.mu.Lock()
	s.probes.runID, s.probes.owner = params.RunID, c
	s.probes.mu.Unlock()
	if err := engine.ProbeServers(params.RunID, string(content), 0, 0, route.resolver, handler); err != nil {
		return ProbeServersResult{}, err
	}
	s.logs.write(log.LevelInfo, fmt.Sprintf("probe run %d: %d servers", params.RunID, len(targets)))
	return ProbeServersResult{RunID: params.RunID}, nil
}

func (s *Server) cancelProbe(params CancelProbeParams) {
	engine.CancelProbe(params.RunID)
}

// cancelProbeOf cancels the run a departing client started; its results have nowhere to go.
func (s *Server) cancelProbeOf(c *client) {
	s.probes.mu.Lock()
	runID, owner := s.probes.runID, s.probes.owner
	s.probes.mu.Unlock()
	if owner == c && runID > 0 {
		engine.CancelProbe(runID)
	}
}

// probeEvents forwards the engine's results to every client. The engine calls it one call at
// a time, with OnDone last.
type probeEvents struct {
	server *Server
	tunnel *tunnel.Tunnel // the tunnel when the run started; nil for none
	stale  atomic.Bool
}

func (h *probeEvents) tunnelChanged() bool {
	h.server.mu.Lock()
	current := h.server.active
	h.server.mu.Unlock()
	return current != h.tunnel
}

func (h *probeEvents) OnResult(runID int64, serverID string, fingerprint string, status string, delayMs int32) {
	if h.stale.Load() {
		return
	}
	if h.tunnelChanged() {
		h.stale.Store(true)
		engine.CancelProbe(runID)
		return
	}
	h.server.clients.broadcast(event(EventServerProbe, ServerProbeEvent{
		RunID: runID, ServerID: serverID, Fingerprint: fingerprint, Status: status, DelayMS: delayMs,
	}))
}

func (h *probeEvents) OnDone(runID int64, cancelled bool) {
	cancelled = cancelled || h.stale.Load()
	h.server.probes.mu.Lock()
	if h.server.probes.runID == runID {
		h.server.probes.runID, h.server.probes.owner = 0, nil
	}
	h.server.probes.mu.Unlock()
	outcome := "done"
	if cancelled {
		outcome = "cancelled"
	}
	h.server.logs.write(log.LevelInfo, fmt.Sprintf("probe run %d %s", runID, outcome))
	h.server.clients.broadcast(event(EventServerProbeDone, ServerProbeDoneEvent{RunID: runID, Cancelled: cancelled}))
}

// bindProxyOutbound returns config with bind_interface set on its "proxy" outbound. Everything
// else is passed through byte for byte; a config that does not parse is returned unchanged, and
// the engine reports it as config_invalid.
func bindProxyOutbound(config string, iface string) string {
	var root map[string]json.RawMessage
	if json.Unmarshal([]byte(config), &root) != nil {
		return config
	}
	var outbounds []map[string]json.RawMessage
	if json.Unmarshal(root["outbounds"], &outbounds) != nil {
		return config
	}
	name, _ := json.Marshal(iface)
	for _, outbound := range outbounds {
		var tag string
		if json.Unmarshal(outbound["tag"], &tag) == nil && tag == "proxy" {
			outbound["bind_interface"] = name
		}
	}
	encoded, err := json.Marshal(outbounds)
	if err != nil {
		return config
	}
	root["outbounds"] = encoded
	rewritten, err := json.Marshal(root)
	if err != nil {
		return config
	}
	return string(rewritten)
}

// systemResolver is the platform resolver, as desktop/guard uses for the tunnel itself. Only
// while no tunnel is up: then nothing is in the way of it.
type systemResolver struct{}

func (systemResolver) Resolve(host string) string {
	ctx, cancel := context.WithTimeout(context.Background(), probeResolveTimeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return ""
	}
	return joinAddrs(addrs)
}

// boundResolver resolves through the DNS servers of the physical interface, over sockets bound
// to it, so neither the query nor its answer touches the tunnel.
type boundResolver struct {
	name  string
	index int
}

// fakeIPRange is singboxConfig.ts's fakeip block. An answer from it came from a tunnel, not a
// real resolver; it is dropped defensively.
var fakeIPRange = netip.MustParsePrefix("198.18.0.0/15")

func (r boundResolver) Resolve(host string) string {
	bind := control.BindToInterface(nil, r.name, r.index)
	servers := physicalDNSServers(r.index)
	resolver := &net.Resolver{
		PreferGo: true,
		// Go walks its own server list (every adapter's, the tun's included). A server of the
		// physical interface is dialled as asked, so Go's own retry moves between them; any other
		// - the tun's hijacked DNS address - is redirected to the interface's first server.
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			dialer := net.Dialer{Timeout: 2 * time.Second, Control: bind}
			if len(servers) > 0 && !isServer(servers, address) {
				address = net.JoinHostPort(servers[0].String(), "53")
			}
			return dialer.DialContext(ctx, network, address)
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeResolveTimeout)
	defer cancel()
	addrs, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return ""
	}
	kept := addrs[:0]
	for _, addr := range addrs {
		if !fakeIPRange.Contains(addr.Unmap()) {
			kept = append(kept, addr)
		}
	}
	return joinAddrs(kept)
}

func isServer(servers []netip.Addr, address string) bool {
	parsed, err := netip.ParseAddrPort(address)
	if err != nil {
		return false
	}
	for _, server := range servers {
		if server == parsed.Addr() {
			return true
		}
	}
	return false
}

func joinAddrs(addrs []netip.Addr) string {
	literals := make([]string, len(addrs))
	for i, addr := range addrs {
		literals[i] = addr.Unmap().String()
	}
	return strings.Join(literals, ",")
}
