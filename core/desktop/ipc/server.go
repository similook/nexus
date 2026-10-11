package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing/common/control"

	"github.com/nexus/nexus-core/desktop/guard"
	"github.com/nexus/nexus-core/desktop/tunnel"
)

// LogRingSize matches libbox's LogMaxLines, deliberately.
//
// ipc-boundary.md R3: logs are PULLED, not pushed. The ring lives here, bounded, and the UI
// fetches it when a log screen opens. A live tail streamed across the boundary would be a
// wakeup per log line to fill a buffer nobody is reading.
const LogRingSize = 512

// StatusInterval is the status tick. R4: nothing crosses this boundary faster than 1 Hz.
const StatusInterval = time.Second

// pingTimeout bounds one TCP handshake probe. Long enough for a distant server on a bad link,
// short enough that a full sweep of a dead subscription does not feel hung.
const pingTimeout = 3 * time.Second

// Server is the daemon: it owns the tunnel and serves the contract to connected clients.
//
// ONE TUNNEL, MANY CLIENTS. The tunnel is process state, not connection state — a GUI that
// quits must not tear down a running VPN, and a second GUI must see the same tunnel the first
// one started. So clients subscribe to a shared thing rather than each getting their own.
type Server struct {
	options ServerOptions

	// mu guards the fields below and is NEVER held across a call into tunnel or sing-box.
	// Same rule as desktop/tunnel and nexuscore/service.go:42, for the same reason.
	mu            sync.Mutex
	active        *tunnel.Tunnel
	state         ServiceState
	coreStartedAt int64
	nodeName      string

	// uplink and downlink are the rates the status tick last measured, in bytes per second.
	uplink, downlink int64

	logs    *logRing
	clients clientSet

	// probes is the Test All Delay run in progress (probe.go).
	probes probeRuns
}

type ServerOptions struct {
	// StateDir is passed to the guard: the only directory a config may name.
	StateDir string

	// Version is reported in the hello frame.
	Version string
}

func NewServer(options ServerOptions) *Server {
	return &Server{
		options: options,
		state:   StateStopped,
		logs:    newLogRing(LogRingSize),
	}
}

// Serve accepts connections until ctx is cancelled or the listener closes.
//
// It does NOT tear the tunnel down on return. That is the caller's decision, because "the IPC
// listener stopped" and "the VPN should stop" are different events — conflating them is how a
// socket error takes a user's network with it.
func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	// The status ticker runs for the server's life, not per connection. Its cost is one
	// goroutine and one read per second; making it per-client would multiply that by the
	// number of open GUIs, and making it start on demand would mean the first status after a
	// reconnect is up to a second late.
	go s.tick(ctx)

	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go s.handle(ctx, connection)
	}
}

// Shutdown stops the tunnel if one is running. Called on daemon exit, not on client
// disconnect.
func (s *Server) Shutdown() error {
	s.mu.Lock()
	active := s.active
	s.active = nil
	s.state = StateStopped
	s.coreStartedAt = 0
	s.mu.Unlock()

	if active == nil {
		return nil
	}
	return active.Close()
}

// ---------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------

type client struct {
	encoder *json.Encoder
	mu      sync.Mutex // one writer at a time: the tick goroutine and the request loop share it

	// logStreaming records the client's setLogStreaming state. Nothing is pushed even when
	// true — see readLogs — but the daemon needs to know a log screen is open so the ring is
	// not the only thing keeping logs alive later.
	logStreaming bool
}

func (c *client) send(frame *Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.encoder.Encode(frame)
}

type clientSet struct {
	mu      sync.Mutex
	members map[*client]struct{}
}

func (s *clientSet) add(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.members == nil {
		s.members = make(map[*client]struct{})
	}
	s.members[c] = struct{}{}
}

func (s *clientSet) remove(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.members, c)
}

// broadcast copies the member list before sending.
//
// Sending under the set's lock would mean one slow or wedged client blocking every other
// client's events, and blocking the status ticker with them. A disconnecting client is
// tolerated: its send fails, and its own read loop removes it.
func (s *clientSet) broadcast(frame *Frame) {
	s.mu.Lock()
	members := make([]*client, 0, len(s.members))
	for member := range s.members {
		members = append(members, member)
	}
	s.mu.Unlock()

	for _, member := range members {
		_ = member.send(frame)
	}
}

func (s *Server) handle(ctx context.Context, connection net.Conn) {
	defer connection.Close()

	c := &client{encoder: json.NewEncoder(connection)}
	s.clients.add(c)
	defer s.clients.remove(c)
	// A run this client started has nowhere to report once it is gone.
	defer s.cancelProbeOf(c)

	// Hello first, before any request is read. A client that cannot speak this protocol
	// version should find out immediately rather than after its first method fails.
	_ = c.send(event(EventHello, HelloEvent{
		Protocol: Protocol,
		Daemon:   s.options.Version,
		OS:       runtime.GOOS,
	}))

	// And the current state, unprompted. A client connecting to a daemon with a tunnel
	// already up must not have to ask — that round trip is exactly the window in which the UI
	// renders "disconnected" over a live tunnel.
	s.mu.Lock()
	state, reason, active := s.state, "", s.active
	s.mu.Unlock()
	_ = c.send(event(EventServiceState, ServiceStateEvent{State: state, Reason: reason}))

	// And the routing mode in effect, for the same reason: a client attaching to a running
	// tunnel must not show a mode it has only assumed.
	if active != nil {
		if frame := clashModeFrame(active); frame != nil {
			_ = c.send(frame)
		}
	}

	scanner := bufio.NewScanner(connection)

	// A config is the largest thing on this wire and can be tens of KB. Scanner's 64 KB
	// default would silently truncate one into a parse error that looks like a client bug.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for scanner.Scan() {
		var request Request
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			_ = c.send(failure(0, fmt.Errorf("malformed request: %w", err)))
			continue
		}
		s.dispatch(ctx, c, &request)
	}
}

func (s *Server) dispatch(ctx context.Context, c *client, request *Request) {
	result, err := s.call(ctx, c, request)
	if err != nil {
		_ = c.send(failure(request.ID, err))
		return
	}
	_ = c.send(success(request.ID, result))
}

func (s *Server) call(ctx context.Context, c *client, request *Request) (any, error) {
	switch request.Method {
	case MethodStart:
		var params StartParams
		if err := decode(request.Params, &params); err != nil {
			return nil, err
		}
		return nil, s.start(ctx, params)

	case MethodStop:
		return nil, s.stop()

	case MethodGetStatus:
		return s.status(), nil

	case MethodTCPPing:
		var params TCPPingParams
		if err := decode(request.Params, &params); err != nil {
			return nil, err
		}
		return s.tcpPing(ctx, params), nil

	case MethodPingProxy:
		go s.pingProxy()
		return nil, nil

	case MethodReadLogs:
		var params ReadLogsParams
		if err := decode(request.Params, &params); err != nil {
			return nil, err
		}
		return ReadLogsResult{Lines: s.logs.read(params.Limit)}, nil

	case MethodClearLogs:
		s.logs.clear()
		return nil, nil

	case MethodSetLogStreaming:
		var params SetLogStreamingParams
		if err := decode(request.Params, &params); err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.logStreaming = params.Enabled
		c.mu.Unlock()
		return nil, nil

	case MethodSetClashMode:
		var params SetClashModeParams
		if err := decode(request.Params, &params); err != nil {
			return nil, err
		}
		return nil, s.setClashMode(params.Mode)

	case MethodCloseConnections:
		s.closeConnections()
		return nil, nil

	case MethodProbeServers:
		var params ProbeServersParams
		if err := decode(request.Params, &params); err != nil {
			return nil, err
		}
		return s.probeServers(c, params)

	case MethodCancelProbe:
		var params CancelProbeParams
		if err := decode(request.Params, &params); err != nil {
			return nil, err
		}
		s.cancelProbe(params)
		return nil, nil

	default:
		return nil, fmt.Errorf("unknown method %q", request.Method)
	}
}

func decode(raw json.RawMessage, into any) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("bad params: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

// start brings a tunnel up, replacing any existing one.
//
// A SECOND start IS A SWITCH, NOT AN ERROR. clients/shared/src/core/useNexusCore.ts switches
// servers by calling connect() again with no stop() first, and that is deliberate: the mobile
// side learned that stop-then-start races the bbolt flock on cache.db and dies with
// "initialize cache-file: timeout", leaving a tunnel with no core.
//
// The fix there and here is the same: serialise the swap, and close the old instance COMPLETELY
// before opening the new one. s.mu serialises it; tunnel.Close does not return until sing-box
// has released the lock. desktop/tunnel's TestSequentialTunnelsShareCacheFile is the
// regression test for exactly this sequence.
func (s *Server) start(ctx context.Context, params StartParams) error {
	if params.Config == "" {
		return errors.New("start: no config")
	}

	// THE PRIVILEGE BOUNDARY IS HERE.
	//
	// Everything before this line is an untrusted string from a local process that is not
	// root. Everything after it runs with the daemon's privileges. The guard is what makes
	// that transition defensible — see desktop/guard's package comment.
	checked, err := guard.Enforce(ctx, params.Config, guard.Options{StateDir: s.options.StateDir})
	if err != nil {
		s.broadcastState(StateStopped, err.Error())
		return err
	}
	for _, warning := range checked.Warnings {
		s.logs.write(log.LevelWarn, "guard: "+warning)
	}
	if checked.Clamped > 0 {
		s.logs.write(log.LevelWarn,
			fmt.Sprintf("guard: clamped %d health-check interval(s) to %ds",
				checked.Clamped, guard.MinHealthCheckSeconds))
	}
	if description, err := guard.DescribeProxyOutbound(checked.Config); err == nil {
		s.logs.write(log.LevelDebug, "guard: proxy outbound: "+description)
	}

	s.broadcastState(StateStarting, "")

	next, err := tunnel.Open(ctx, checked.Config, tunnel.Options{LogWriter: s.logs})
	if err != nil {
		s.broadcastState(StateStopped, err.Error())
		return err
	}

	// Swap under the lock so two concurrent starts cannot both think they own the old one.
	// The CLOSE happens outside it, because Close blocks and s.mu must never be held across
	// a call into sing-box.
	s.mu.Lock()
	previous := s.active
	s.active = next
	s.nodeName = params.Name
	s.mu.Unlock()

	if previous != nil {
		s.logs.write(log.LevelInfo, "closing the previous tunnel before starting the new one")
		if err = previous.Close(); err != nil {
			// Do not continue. Starting on top of a tunnel that would not let go is how the
			// cache-file deadlock happens, and a clear failure here beats a zombie.
			s.mu.Lock()
			s.active = nil
			s.mu.Unlock()
			_ = next.Close()
			s.broadcastState(StateStopped, err.Error())
			return fmt.Errorf("the previous tunnel would not close: %w", err)
		}
	}

	if err = next.Start(); err != nil {
		s.mu.Lock()
		s.active = nil
		s.mu.Unlock()
		_ = next.Close()
		s.broadcastState(StateStopped, err.Error())
		return err
	}

	s.mu.Lock()
	s.state = StateStarted
	s.coreStartedAt = time.Now().UnixMilli()
	s.mu.Unlock()

	// The mode first, so a client flipping to "connected" already knows which route is in
	// effect. next.Start has put it in the config's mode (tunnel.applyDefaultMode).
	if frame := clashModeFrame(next); frame != nil {
		s.clients.broadcast(frame)
	}
	s.broadcastState(StateStarted, "")
	return nil
}

// setClashMode switches routing on the running tunnel — no restart, no teardown — and tells
// every client the mode now in effect. Closing existing connections is closeConnections, a
// separate call, as it is in sing-box's own daemon.
func (s *Server) setClashMode(mode string) error {
	s.mu.Lock()
	active := s.active
	s.mu.Unlock()

	if active == nil {
		return errors.New("no tunnel is running; the routing mode applies when one starts")
	}
	if err := active.SetMode(mode); err != nil {
		return err
	}
	s.logs.write(log.LevelInfo, "routing mode: "+mode)
	if frame := clashModeFrame(active); frame != nil {
		s.clients.broadcast(frame)
	}
	return nil
}

// closeConnections restarts every open connection on the running tunnel so it is routed
// afresh. Idempotent, and a no-op with no tunnel: there is nothing to close.
func (s *Server) closeConnections() {
	s.mu.Lock()
	active := s.active
	s.mu.Unlock()

	if active != nil {
		s.logs.write(log.LevelInfo,
			fmt.Sprintf("restarted %d open connection(s) so they follow the routing mode", active.CloseConnections()))
	}
}

// clashModeFrame reports the tunnel's routing mode, or nil while it has none to report.
func clashModeFrame(active *tunnel.Tunnel) *Frame {
	current, modes, ok := active.Mode()
	if !ok {
		return nil
	}
	return event(EventClashMode, ClashModeEvent{Modes: modes, Current: current})
}

func (s *Server) stop() error {
	s.mu.Lock()
	active := s.active
	s.active = nil
	s.coreStartedAt = 0
	s.mu.Unlock()

	if active == nil {
		// Idempotent on purpose. Stop arrives from a button, a tray item and a signal, and
		// they race; a second stop must be a no-op, not an error the UI renders in red.
		s.broadcastState(StateStopped, "")
		return nil
	}

	err := active.Close()
	s.broadcastState(StateStopped, errorText(err))
	return err
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (s *Server) broadcastState(state ServiceState, reason string) {
	s.mu.Lock()
	s.state = state
	s.mu.Unlock()
	s.clients.broadcast(event(EventServiceState, ServiceStateEvent{State: state, Reason: reason}))
}

func (s *Server) status() StatusSnapshot {
	s.mu.Lock()
	state, startedAt, active := s.state, s.coreStartedAt, s.active
	uplink, downlink := s.uplink, s.downlink
	s.mu.Unlock()

	var memoryStats runtime.MemStats
	runtime.ReadMemStats(&memoryStats)

	var clashMode string
	var clashModes []string
	if active != nil {
		clashMode, clashModes, _ = active.Mode()
	}

	// TRAFFIC is sing-box's own count (tunnel.Traffic), the numbers its daemon and libbox report:
	// totals since this tunnel started, and the per-second rates the tick measured from them.
	// With no tunnel nothing is moving, so zero is then the true value, not an unknown one — as
	// on Android, whose UI shows zeros while disconnected. trafficAvailable goes false only for a
	// tunnel with no counters to read, and the UI then renders "—" rather than a confident 0.00.
	trafficAvailable := true
	var uplinkTotal, downlinkTotal int64
	if active != nil {
		uplinkTotal, downlinkTotal, trafficAvailable = active.Traffic()
	}
	if active == nil || !trafficAvailable {
		uplink, downlink = 0, 0
	}

	return StatusSnapshot{
		ClashMode:  clashMode,
		ClashModes: clashModes,

		State:         state,
		CoreStartedAt: startedAt,

		TrafficAvailable: trafficAvailable,
		Uplink:           uplink,
		Downlink:         downlink,
		UplinkTotal:      uplinkTotal,
		DownlinkTotal:    downlinkTotal,

		Memory:     int64(memoryStats.Sys),
		Goroutines: int32(runtime.NumGoroutine()),
	}
}

// measure turns the running tunnel's byte totals into rates for status() to report.
func (s *Server) measure(meter *trafficMeter) {
	s.mu.Lock()
	active := s.active
	s.mu.Unlock()

	var up, down, uplink, downlink int64
	ok := false
	if active != nil {
		up, down, ok = active.Traffic()
	}
	if ok {
		uplink, downlink = meter.sample(active, up, down, time.Now())
	} else {
		*meter = trafficMeter{}
	}

	s.mu.Lock()
	s.uplink, s.downlink = uplink, downlink
	s.mu.Unlock()
}

// trafficMeter derives rates from running totals the way sing-box's own status stream does
// (daemon/started_service.go, SubscribeStatus): the change since the previous tick. Divided by
// the time that really passed, so a late tick does not report more than a second's worth.
type trafficMeter struct {
	tunnel   *tunnel.Tunnel
	up, down int64
	at       time.Time
}

// sample records a tunnel's totals and returns the rates since its previous sample. With nothing
// to compare with — a new tunnel, or the first tick after an idle gap — the rates are zero, as in
// the first message of sing-box's stream.
func (m *trafficMeter) sample(active *tunnel.Tunnel, up, down int64, now time.Time) (uplink, downlink int64) {
	if m.tunnel == active && up >= m.up && down >= m.down {
		if elapsed := now.Sub(m.at); elapsed > 0 {
			uplink = (up - m.up) * int64(time.Second) / int64(elapsed)
			downlink = (down - m.down) * int64(time.Second) / int64(elapsed)
		}
	}
	m.tunnel, m.up, m.down, m.at = active, up, down, now
	return uplink, downlink
}

func (s *Server) tick(ctx context.Context) {
	ticker := time.NewTicker(StatusInterval)
	defer ticker.Stop()

	var meter trafficMeter
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		// R1: no subscribers, no work. On desktop there is no "app backgrounded" signal, so
		// the client count IS the visibility signal — a GUI that closed to the tray has
		// disconnected, and a daemon with nobody attached should not be building status
		// messages for an empty room.
		s.clients.mu.Lock()
		listeners := len(s.clients.members)
		s.clients.mu.Unlock()
		if listeners == 0 {
			// Drop the rate baseline once, so the first tick back does not report everything
			// carried in the meantime as one second's traffic.
			if meter.tunnel != nil {
				meter = trafficMeter{}
				s.mu.Lock()
				s.uplink, s.downlink = 0, 0
				s.mu.Unlock()
			}
			continue
		}

		s.measure(&meter)
		s.clients.broadcast(event(EventStatus, s.status()))
	}
}

// ---------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------

// tcpPing measures a TCP handshake to each target.
//
// ============================================================================================
// THESE PROBES CURRENTLY GO THROUGH THE TUNNEL, AND THAT IS WRONG
//
// On Android they do not: the app's own package sits on the VpnService DENY list, so probes
// leave over the real network and "Test All" measures what it claims to. A desktop TUN is
// system-wide and has no per-app deny list, so with a tunnel up these dials are captured by it
// and every node measures the latency of the active tunnel instead of itself.
//
// ADR-0003 §3.5 has the fix: dial through the same path sing-box uses for its own proxy
// connections, which MUST bypass the tun or the proxy connection would loop through the tunnel
// it creates. That exclusion already exists on every OS (fwmark on Linux, a WFP process
// exclusion on Windows, interface binding on macOS) — reusing it is correct by construction.
//
// Reaching it means dialling through sing-box's own outbound dialer rather than net.Dialer,
// which needs a handle this package does not have yet. Left as a plain dial with this comment
// rather than silently shipping a number that means something different from what the UI
// says. The results are honest while disconnected, which is when the UI actually uses them.
// ============================================================================================
//
// While a tunnel is up, each dial now leaves on the tunnel's upstream interface with the name
// resolved outside it - the same path Test All's Delay probes take (probe.go) - so TCP measures
// this machine to the server, as on Android. With no tunnel the dial is the plain one below,
// unchanged. A tunnel whose upstream interface is unknown measures nothing (-1) rather than
// the tunnel.
func (s *Server) tcpPing(ctx context.Context, params TCPPingParams) TCPPingResult {
	results := make([]PingResult, 0, len(params.Targets))
	var mu sync.Mutex
	var wg sync.WaitGroup
	route, routeErr := s.probeRoute()

	for _, target := range params.Targets {
		wg.Add(1)
		go func(target PingTarget) {
			defer wg.Done()
			ms := -1
			switch {
			case routeErr != nil:
			case route.active != nil:
				ms = probeBound(ctx, target, route)
			default:
				ms = probe(ctx, target)
			}
			mu.Lock()
			results = append(results, PingResult{ID: target.ID, MS: ms})
			mu.Unlock()
		}(target)
	}
	wg.Wait()

	return TCPPingResult{Results: results}
}

func probe(ctx context.Context, target PingTarget) int {
	if target.Server == "" || target.Port <= 0 {
		return -1
	}

	address := net.JoinHostPort(target.Server, fmt.Sprint(target.Port))
	dialer := net.Dialer{Timeout: pingTimeout}

	started := time.Now()
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		// -1, not an error. "Unreachable" is a measurement, and one dead node must not fail
		// the sweep for the rest.
		return -1
	}
	elapsed := time.Since(started)
	_ = connection.Close()

	return int(elapsed.Milliseconds())
}

// probeBound is probe for a machine with a tunnel up: the name resolved by the physical
// interface's DNS, the handshake bound to that interface. Timed from the dial, after the lookup.
func probeBound(ctx context.Context, target PingTarget, route probeRoute) int {
	if target.Server == "" || target.Port <= 0 {
		return -1
	}
	host := target.Server
	if _, err := netip.ParseAddr(host); err != nil {
		answers := strings.Split(route.resolver.Resolve(host), ",")
		if answers[0] == "" {
			return -1
		}
		host = answers[0]
	}

	dialer := net.Dialer{Timeout: pingTimeout, Control: control.BindToInterface(nil, route.iface, route.index)}
	started := time.Now()
	connection, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, fmt.Sprint(target.Port)))
	if err != nil {
		return -1
	}
	elapsed := time.Since(started)
	_ = connection.Close()
	return int(elapsed.Milliseconds())
}

// pingProxy measures the active tunnel and answers on the proxyDelay event.
//
// Asynchronous because the UI's method returns void and waits for the event — the same shape
// as NexusPlugin.pingProxy on Android, so the frontend needs no branch.
func (s *Server) pingProxy() {
	s.mu.Lock()
	active := s.active
	s.mu.Unlock()

	if active == nil || !active.Started() {
		s.clients.broadcast(event(EventProxyDelay, ProxyDelayEvent{DelayMS: -1, Ok: false}))
		return
	}

	// Phase 3 measures reachability through the tunnel the only way this package can without
	// a handle on sing-box's outbound: a plain dial, which with a system-wide TUN up does go
	// through the tunnel. That makes this number meaningful here, unlike tcpPing above — the
	// tunnel is exactly what it is supposed to measure.
	started := time.Now()
	dialer := net.Dialer{Timeout: pingTimeout}
	connection, err := dialer.Dial("tcp", "1.1.1.1:443")
	if err != nil {
		s.clients.broadcast(event(EventProxyDelay, ProxyDelayEvent{DelayMS: -1, Ok: false}))
		return
	}
	elapsed := time.Since(started)
	_ = connection.Close()

	s.clients.broadcast(event(EventProxyDelay, ProxyDelayEvent{
		DelayMS: int(elapsed.Milliseconds()),
		Ok:      true,
	}))
}

// ---------------------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------------------

func event(name string, data any) *Frame {
	encoded, err := json.Marshal(data)
	if err != nil {
		encoded = []byte(`null`)
	}
	return &Frame{Event: name, Data: encoded}
}

func success(id uint64, result any) *Frame {
	ok := true
	frame := &Frame{ID: id, Ok: &ok}
	if result != nil {
		encoded, err := json.Marshal(result)
		if err == nil {
			frame.Data = encoded
		}
	}
	return frame
}

func failure(id uint64, err error) *Frame {
	ok := false
	return &Frame{ID: id, Ok: &ok, Error: err.Error()}
}
