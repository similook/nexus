package nexuscore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/urltest"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common"
	singjson "github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/service"
)

// ============================================================================================
// PER-SERVER PROBE ENGINE (Servers -> Test All, Delay column)
//
// The running tunnel holds exactly ONE proxy outbound, so the Live URL test can only ever
// measure the running server. To give every server a real Delay without touching the tunnel,
// this file runs a SECOND, short-lived sing-box instance in the APP process:
//
//   - no inbound, no TUN, no listener: nothing can route into it and it routes nothing;
//   - per server: a hosts DNS entry and that server's own outbound are created, the same
//     urltest.URLTest the Live path uses runs through it, and both are removed again;
//   - the box is closed when the run ends - success, failure, timeout or cancel.
//
// The :core process and its box are never touched. The app process is excluded from its own
// VPN (NexusVpnService), so probe traffic goes out on the physical network, like TCP ping.
//
// Results cross the gomobile boundary as STATUS CATEGORIES ONLY. Raw errors carry hosts, IPs
// and sometimes config fragments; none of them leave this file, and nothing here logs.
// ============================================================================================

// Probe statuses. The complete vocabulary Kotlin and the UI may see.
const (
	probeOK              = "ok"
	probeTimeout         = "timeout"
	probeRefused         = "refused"
	probeUnreachable     = "unreachable"
	probeDNSFailed       = "dns_failed"
	probeHandshakeFailed = "handshake_failed"
	probeRejected        = "rejected"
	probeConfigInvalid   = "config_invalid"
	probeCancelled       = "cancelled"
	probeFailed          = "failed"
)

// Starting values from the spec; the caller may pass 0 for either.
const (
	probeDefaultWorkers = 6
	probeMaxWorkers     = 16
	probeDefaultTimeout = 6 * time.Second
	probeMaxTimeout     = 30 * time.Second
)

// ProbeHandler receives a run's results. Calls are serialised: never two at once, and OnDone
// is always the last call for its run.
type ProbeHandler interface {
	OnResult(runID int64, serverID string, fingerprint string, status string, delayMs int32)
	OnDone(runID int64, cancelled bool)
}

// HostResolver resolves a proxy server's hostname with the platform's resolver - the same one
// ConfigGuard uses for the tunnel. Returns every address as a comma-separated list of IP
// literals, or "" when there is none. Go filters the answers (probeUsableAddress); the
// resolver must not log the host or the answer.
type HostResolver interface {
	Resolve(host string) string
}

type probeTarget struct {
	ID          string `json:"id"`
	Fingerprint string `json:"fingerprint"`
	Config      string `json:"config"` // the node's full generated config; only "proxy" is used
}

type probeResult struct {
	id          string
	fingerprint string
	status      string
	delayMs     int32
}

// activeProbe is the one run that may exist at a time.
type activeProbe struct {
	id        int64
	cancel    context.CancelFunc
	cancelled atomic.Bool
	finished  chan struct{}
}

var (
	probeAccess  sync.Mutex
	probeCurrent *activeProbe
)

// ProbeServers starts run runID over targetsJSON ([{id, fingerprint, config}]) and returns at
// once; results arrive on handler. A run still in progress is cancelled first, and this run's
// box is not built until the previous one is closed, so at most one probe box ever exists.
//
// workers <= 0 and timeoutMillis <= 0 select the defaults (6 workers, 6 s per server).
func ProbeServers(runID int64, targetsJSON string, workers int32, timeoutMillis int32, resolver HostResolver, handler ProbeHandler) error {
	if resolver == nil || handler == nil {
		return errors.New("nexuscore: probe needs a resolver and a handler")
	}
	var targets []probeTarget
	if err := json.Unmarshal([]byte(targetsJSON), &targets); err != nil {
		// Not wrapped: a JSON syntax error quotes the offending input.
		return errors.New("nexuscore: probe targets are not valid JSON")
	}

	ctx, cancel := context.WithCancel(context.Background())
	run := &activeProbe{id: runID, cancel: cancel, finished: make(chan struct{})}

	probeAccess.Lock()
	previous := probeCurrent
	probeCurrent = run
	probeAccess.Unlock()
	if previous != nil {
		previous.cancelled.Store(true)
		previous.cancel()
	}

	go func() {
		defer close(run.finished)
		defer cancel()
		if previous != nil {
			<-previous.finished
		}

		var emitAccess sync.Mutex
		emit := func(result probeResult) {
			emitAccess.Lock()
			defer emitAccess.Unlock()
			handler.OnResult(runID, result.id, result.fingerprint, result.status, result.delayMs)
		}
		runProbe(ctx, targets, probeOptions{
			workers: int(workers),
			timeout: time.Duration(timeoutMillis) * time.Millisecond,
			resolve: resolver.Resolve,
		}, emit)

		probeAccess.Lock()
		if probeCurrent == run {
			probeCurrent = nil
		}
		probeAccess.Unlock()
		emitAccess.Lock()
		defer emitAccess.Unlock()
		handler.OnDone(runID, run.cancelled.Load())
	}()
	return nil
}

// CancelProbe cancels run runID, or whichever run is in progress when runID <= 0. Returns at
// once; the run reports OnDone(cancelled=true) after its box is closed.
func CancelProbe(runID int64) {
	probeAccess.Lock()
	run := probeCurrent
	probeAccess.Unlock()
	if run == nil || (runID > 0 && run.id != runID) {
		return
	}
	run.cancelled.Store(true)
	run.cancel()
}

type probeOptions struct {
	workers int
	timeout time.Duration
	resolve func(host string) string

	// Test seams. Production leaves all of them zero.
	link     string                                      // "" = urltest's default, the same URL Live tests
	extraCA  []string                                    // PEM roots trusted on top of the system store
	usable   func(netip.Addr) bool                       // nil = probeUsableAddress
	platform *probePlatform                              // nil = a fresh one
	inspect  func(*box.Box, adapter.DNSTransportManager) // called after the last probe, before Close
}

// runProbe measures every target and returns when all results are emitted and the probe box
// is closed. Targets not started before ctx ends get no result.
func runProbe(ctx context.Context, targets []probeTarget, options probeOptions, emit func(probeResult)) {
	if len(targets) == 0 {
		return
	}
	workers := options.workers
	if workers <= 0 {
		workers = probeDefaultWorkers
	}
	workers = min(workers, probeMaxWorkers, len(targets))
	timeout := options.timeout
	if timeout <= 0 {
		timeout = probeDefaultTimeout
	}
	timeout = min(timeout, probeMaxTimeout)
	if options.usable == nil {
		options.usable = probeUsableAddress
	}
	if options.platform == nil {
		options.platform = new(probePlatform)
	}

	runCtx, cancelBox := context.WithCancel(ctx)
	defer cancelBox()
	instance, boxCtx, err := newProbeBox(runCtx, options)
	if err != nil {
		// Not a property of any one server; every row learns the run could not be made.
		for _, target := range targets {
			if ctx.Err() != nil {
				return
			}
			emit(probeResult{target.ID, target.Fingerprint, probeFailed, 0})
		}
		return
	}
	defer instance.Close()

	runner := &probeRunner{
		ctx:      ctx,
		boxCtx:   boxCtx,
		timeout:  timeout,
		options:  options,
		router:   service.FromContext[adapter.Router](boxCtx),
		registry: service.FromContext[adapter.OutboundRegistry](boxCtx),
		dns:      service.FromContext[adapter.DNSTransportManager](boxCtx),
		logger:   service.FromContext[log.Factory](boxCtx).NewLogger("probe"),
		hosts:    make(map[string]*probeLookup),
	}

	jobs := make(chan int, len(targets))
	for i := range targets {
		jobs <- i
	}
	close(jobs)

	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				if ctx.Err() != nil {
					return
				}
				emit(runner.probe(i, targets[i]))
			}
		}()
	}
	wg.Wait()
	if options.inspect != nil {
		options.inspect(instance, runner.dns)
	}
}

// newProbeBox builds and starts the empty instance probes are added to. The returned context
// carries the instance's services (router, DNS, certificate store) and must be the parent of
// everything created in it - including each URL test, which takes its root CAs from it,
// exactly as the Live test does from the tunnel's box.
func newProbeBox(ctx context.Context, options probeOptions) (*box.Box, context.Context, error) {
	config := map[string]any{
		"log": map[string]any{"disabled": true},
		"dns": map[string]any{
			// The default server. Never queried (every outbound names its own resolver);
			// present so no implicit system resolver is created and so per-server servers
			// never become the default (TransportManager.Remove mishandles the default).
			"servers":       []any{map[string]any{"type": "hosts", "tag": "probe-none"}},
			"final":         "probe-none",
			"disable_cache": true,
		},
	}
	if len(options.extraCA) > 0 {
		config["certificate"] = map[string]any{"certificate": options.extraCA}
	}
	content, err := json.Marshal(config)
	if err != nil {
		return nil, nil, err
	}

	ctx = box.Context(ctx, include.InboundRegistry(), include.OutboundRegistry(), include.EndpointRegistry(),
		include.DNSTransportRegistry(), include.ServiceRegistry(), include.CertificateProviderRegistry())
	ctx = service.ContextWith[adapter.PlatformInterface](ctx, adapter.PlatformInterface(options.platform))
	parsed, err := singjson.UnmarshalExtendedContext[option.Options](ctx, content)
	if err != nil {
		return nil, nil, err
	}
	instance, err := box.New(box.Options{Context: ctx, Options: parsed})
	if err != nil {
		return nil, nil, err
	}
	if err = instance.Start(); err != nil {
		instance.Close()
		return nil, nil, err
	}
	return instance, ctx, nil
}

type probeRunner struct {
	ctx      context.Context // the run; cancelled by CancelProbe
	boxCtx   context.Context // carries the probe box's services
	timeout  time.Duration
	options  probeOptions
	router   adapter.Router
	registry adapter.OutboundRegistry
	dns      adapter.DNSTransportManager
	logger   log.ContextLogger

	hostsAccess sync.Mutex
	hosts       map[string]*probeLookup
}

// probeLookup is one hostname's resolution, shared by every server on that host.
type probeLookup struct {
	done  chan struct{}
	addrs []netip.Addr // usable answers only
}

var errProbeConfig = errors.New("probe: config")

// probe measures one server. Every exit path has already released what it created.
func (r *probeRunner) probe(index int, target probeTarget) (result probeResult) {
	result = probeResult{id: target.ID, fingerprint: target.Fingerprint}
	// From boxCtx (a child of the run's context), so cancel still reaches it.
	ctx, cancel := context.WithTimeout(r.boxCtx, r.timeout)
	defer cancel()
	defer func() {
		if recover() != nil {
			result.status, result.delayMs = probeFailed, 0
		}
		if result.status != probeOK {
			result.delayMs = 0
			if r.ctx.Err() != nil {
				result.status = probeCancelled
			} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				result.status = probeTimeout
			}
		}
	}()
	delay, status := r.measure(ctx, index, target)
	result.status, result.delayMs = status, int32(delay)
	return
}

func (r *probeRunner) measure(ctx context.Context, index int, target probeTarget) (uint16, string) {
	fields, server, err := probeOutbound(target.Config)
	if err != nil {
		return 0, probeConfigInvalid
	}
	tag := fmt.Sprintf("probe-%d", index)
	fields["tag"] = mustRaw(tag)

	if addr, err := netip.ParseAddr(server); err == nil {
		// An IP literal is never looked up; it still has to be a public address.
		if !r.options.usable(addr) {
			return 0, probeConfigInvalid
		}
	} else {
		addrs, err := r.lookup(ctx, server)
		if err != nil {
			return 0, probeFailed // the run or this server's time ended; probe() relabels it
		}
		if len(addrs) == 0 {
			return 0, probeDNSFailed
		}
		// The ConfigGuard arrangement: the outbound keeps its hostname (SNI, Host headers)
		// and a hosts server answers it with the platform-resolved, filtered addresses.
		dnsTag := tag + "-dns"
		if err := r.createHosts(dnsTag, server, addrs); err != nil {
			return 0, probeFailed
		}
		defer r.dns.Remove(dnsTag)
		fields["domain_resolver"] = mustRaw(map[string]string{"server": dnsTag, "strategy": "prefer_ipv4"})
	}

	content, err := json.Marshal(fields)
	if err != nil {
		return 0, probeConfigInvalid
	}
	options, err := singjson.UnmarshalExtendedContext[option.Outbound](r.boxCtx, content)
	if err != nil {
		return 0, probeConfigInvalid
	}
	// The registry, not OutboundManager.Create: Create forgets an outbound whose start fails,
	// which would leave it unclosed. Here every created outbound is closed below.
	outbound, err := r.registry.CreateOutbound(r.boxCtx, r.router, r.logger, tag, options.Type, options.Options)
	if err != nil {
		return 0, probeConfigInvalid
	}
	defer common.Close(outbound)
	for _, stage := range adapter.ListStartStages {
		if err := adapter.LegacyStart(outbound, stage); err != nil {
			return 0, probeConfigInvalid
		}
	}

	delay, err := urltest.URLTest(ctx, r.options.link, outbound)
	if err != nil {
		return 0, probeClassify(err)
	}
	return delay, probeOK
}

// lookup resolves host once per run. The platform call cannot be interrupted, so it runs on
// its own goroutine and a waiter that is cancelled or times out simply stops waiting. At most
// one such goroutine exists per distinct hostname still being resolved.
func (r *probeRunner) lookup(ctx context.Context, host string) ([]netip.Addr, error) {
	key := strings.ToLower(host)
	r.hostsAccess.Lock()
	entry := r.hosts[key]
	if entry == nil {
		entry = &probeLookup{done: make(chan struct{})}
		r.hosts[key] = entry
		go func() {
			defer close(entry.done)
			defer func() { _ = recover() }()
			entry.addrs = probeParseAnswers(r.options.resolve(host), r.options.usable)
		}()
	}
	r.hostsAccess.Unlock()
	select {
	case <-entry.done:
		return entry.addrs, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (r *probeRunner) createHosts(tag string, host string, addrs []netip.Addr) error {
	literals := make([]string, len(addrs))
	for i, addr := range addrs {
		literals[i] = addr.String()
	}
	content, err := json.Marshal(map[string]any{
		"type":       "hosts",
		"tag":        tag,
		"predefined": map[string][]string{host: literals},
	})
	if err != nil {
		return err
	}
	options, err := singjson.UnmarshalExtendedContext[option.DNSServerOptions](r.boxCtx, content)
	if err != nil {
		return err
	}
	return r.dns.Create(r.boxCtx, r.logger, tag, options.Type, options.Options)
}

// Outbound types that are not a remote proxy server and must never be dialled by a probe.
var probeNonProxyTypes = map[string]bool{
	"": true, "direct": true, "block": true, "dns": true, "selector": true, "urltest": true,
}

// probeOutbound returns the config's "proxy" outbound, ready to be re-tagged, and its server.
// Fields that name other parts of the node's config (which the probe box does not have) are
// dropped: a detour would leave this outbound unbuildable, and the resolver is replaced.
func probeOutbound(config string) (map[string]json.RawMessage, string, error) {
	var root struct {
		Outbounds []json.RawMessage `json:"outbounds"`
	}
	if json.Unmarshal([]byte(config), &root) != nil {
		return nil, "", errProbeConfig
	}
	for _, raw := range root.Outbounds {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			continue
		}
		var tag, outboundType, server string
		_ = json.Unmarshal(fields["tag"], &tag)
		if tag != proxyTag {
			continue
		}
		_ = json.Unmarshal(fields["type"], &outboundType)
		_ = json.Unmarshal(fields["server"], &server)
		if probeNonProxyTypes[outboundType] || server == "" {
			return nil, "", errProbeConfig
		}
		if _, hasDetour := fields["detour"]; hasDetour {
			return nil, "", errProbeConfig
		}
		delete(fields, "domain_resolver")
		return fields, server, nil
	}
	return nil, "", errProbeConfig
}

func mustRaw(value any) json.RawMessage {
	content, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return content
}

func probeParseAnswers(answers string, usable func(netip.Addr) bool) []netip.Addr {
	var addrs []netip.Addr
	for _, field := range strings.Split(answers, ",") {
		addr, err := netip.ParseAddr(strings.TrimSpace(field))
		if err != nil {
			continue
		}
		addr = addr.Unmap()
		if usable(addr) {
			addrs = append(addrs, addr)
		}
	}
	return addrs
}

var probeSiteLocalV6 = netip.MustParsePrefix("fec0::/10")

// probeUsableAddress is ConfigGuard.unusableReason, inverted: loopback, wildcard, link-local,
// multicast and private answers are what an intercepting resolver returns, never a server
// this device can reach over the internet. (Go's IsPrivate also covers IPv6 ULA fc00::/7,
// which Java's isSiteLocalAddress does not; the probe errs on the strict side.)
func probeUsableAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	return addr.IsValid() &&
		!addr.IsLoopback() &&
		!addr.IsUnspecified() &&
		!addr.IsLinkLocalUnicast() &&
		!addr.IsMulticast() &&
		!addr.IsPrivate() &&
		!probeSiteLocalV6.Contains(addr)
}

// probeClassify maps a URL-test error to a status. Order matters: the specific causes come
// before the generic "the server closed the connection" ones.
func probeClassify(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return probeTimeout
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return probeTimeout
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		windows := runtime.GOOS == "windows"
		switch {
		case errno == syscall.ECONNREFUSED || windows && errno == 10061: // WSAECONNREFUSED
			return probeRefused
		case errno == syscall.ENETUNREACH || errno == syscall.EHOSTUNREACH ||
			windows && (errno == 10051 || errno == 10065): // WSAENETUNREACH, WSAEHOSTUNREACH
			return probeUnreachable
		}
	}
	message := strings.ToLower(err.Error())
	has := func(parts ...string) bool {
		for _, part := range parts {
			if strings.Contains(message, part) {
				return true
			}
		}
		return false
	}
	switch {
	case has("connection refused", "actively refused"):
		return probeRefused
	case has("network is unreachable", "no route to host", "host is unreachable"):
		return probeUnreachable
	case has("authentication failed", "auth failed", "unauthorized", "invalid user", "user not found"):
		return probeRejected
	case has("tls", "x509", "certificate", "reality", "handshake"):
		return probeHandshakeFailed
	case has("no such host", "lookup ", "dns"):
		return probeDNSFailed
	case errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		has("eof", "connection reset", "forcibly closed", "broken pipe", "connection closed", "closed by peer",
			"application error"):
		// The server accepted the connection and then dropped it mid-protocol: what a proxy
		// does with credentials it does not accept. ("application error ... (remote)" is the
		// QUIC form: TUIC closes the connection that way after a failed authentication.)
		return probeRejected
	case has("timeout", "timed out", "deadline"):
		return probeTimeout
	}
	return probeFailed
}
