// Package tunnel runs a sing-box instance on a desktop OS, where the core creates its own
// TUN device instead of being handed a file descriptor.
//
// ============================================================================================
// HOW THIS DIFFERS FROM nexuscore, AND WHY IT IS A SEPARATE PACKAGE
//
// nexuscore is the mobile path. It wraps libbox.CommandServer, and libbox exists precisely
// because Android and Apple hand the core a TUN fd created by platform code — VpnService on
// Android, NEPacketTunnelProvider on Apple.
//
// That path cannot work on a desktop, and the reason is one line upstream.
// experimental/libbox/service.go:55:
//
//	func (w *platformInterfaceWrapper) UsePlatformInterface() bool {
//		return true
//	}
//
// A literal, not a delegation. It decides the branch at protocol/tun/inbound.go:428:
//
//	if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
//		tunInterface, err = t.platformInterface.OpenInterface(...)   // someone hands us an fd
//	} else {
//		tunInterface, err = tun.New(tunOptions)                      // sing-tun makes the device
//	}
//
// Anything going through libbox takes the first branch forever. On Windows it then fails twice
// more — getTunnelName returns os.ErrInvalid for !(darwin||linux), and dup returns
// os.ErrInvalid — but the branch is already wrong before that.
//
// # WHAT WE DO INSTEAD, AND WHY IT IS SIMPLER THAN EXPECTED
//
// ADR-0003 §1 planned to implement adapter.PlatformInterface with UsePlatformInterface()
// returning false, following experimental/boxdd/platform_linux.go. That works, but it is 35
// methods of interface to satisfy for one boolean.
//
// It turns out not to be necessary. box.New reads the platform interface out of the service
// context (box.go:172), not from its Options, so if nothing registers one the value is nil —
// and the guard above is `!= nil` first. sing-box's OWN CLI does exactly this: cmd/sing-box
// contains no reference to PlatformInterface at all, and it is a working desktop TUN client.
//
// So: no platform interface, and sing-tun owns the device. We follow the CLI, not boxdd. A
// platform interface becomes necessary only when we want something it is actually for —
// system proxy, process-owner lookup, notifications — none of which is this phase.
// ============================================================================================
package tunnel

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/trafficcontrol"
	"github.com/sagernet/sing-box/experimental/deprecated"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/service"
)

// Options configures a Tunnel beyond its config.
type Options struct {
	// LogWriter receives the core's own log stream.
	//
	// Setting it is not free and the side effects are upstream, both in box.go:
	//
	//	:157  a non-nil writer forces needCacheFile, so cache.db exists and sing-box takes an
	//	      exclusive bbolt flock on it. That is the lock behind "initialize cache-file:
	//	      timeout" when one tunnel is started before the previous one has fully closed -
	//	      the mobile bug. It is also why Close must not return early.
	//	:160  a non-nil writer forces a clash server, which is where traffic counters live.
	//
	// nil is correct for `nexusd check` and for tests that only want a lifecycle.
	LogWriter log.PlatformWriter
}

// CloseTimeout bounds how long Close waits for sing-box to shut down before giving up on it.
//
// The mobile side learned this the hard way and the value is carried over deliberately
// (NexusVpnService.CORE_CLOSE_TIMEOUT_MS): a teardown that blocks forever is worse than a
// rude one, because on desktop the routing table stays hijacked for exactly as long as the
// process refuses to die.
const CloseTimeout = 5 * time.Second

// ErrCloseTimeout is returned by Close when sing-box did not finish within CloseTimeout.
//
// It is an error and not a log line because the caller has to act on it: routes and the tun
// device may still be installed, and on a desktop that means the machine has no working
// network until something removes them.
var ErrCloseTimeout = errors.New("sing-box did not shut down within " + CloseTimeout.String())

// Tunnel is one sing-box instance.
//
// Single use. Once closed it stays closed — reuse would mean reasoning about a half-torn-down
// box, and constructing a fresh one is free. Switching servers creates a new Tunnel; see the
// note on cache.db in Close.
type Tunnel struct {
	// mu guards THIS STRUCT'S FIELDS ONLY, and must never be held across a call into sing-box.
	//
	// Same rule as nexuscore/service.go:42, for the same reason: the core calls back into its
	// host, Go's sync.Mutex is not reentrant, and a lock held across Start() or Close() is a
	// deadlock waiting for the right callback. Snapshot under the lock, release, then call.
	mu       sync.Mutex
	instance *box.Box
	started  bool
	closed   bool

	// ctx is the service context box.New registered into. BaseContext gives it a registry
	// before box.New runs, and box.New reuses a registry it finds (ContextWithDefaultRegistry),
	// so the clash server and the connection manager are reachable here through their public
	// adapter interfaces.
	ctx context.Context

	// defaultMode is experimental.clash_api.default_mode: the routing mode the config asks to
	// start in, re-applied after Start. See applyDefaultMode.
	defaultMode string
}

// BaseContext builds the context sing-box needs: protocol registries and a deprecation
// manager.
//
// This mirrors cmd/sing-box/cmd.go, which is the reference for a desktop host. Note what is
// NOT here: no service.ContextWith[adapter.PlatformInterface]. That omission is the entire
// point of this package — see the package comment.
func BaseContext(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return include.Context(service.ContextWith(ctx, deprecated.NewStderrManager(log.StdLogger())))
}

// Check parses and fully constructs a config without starting it, then throws it away.
//
// This is the desktop twin of libbox.CheckConfig, which core/scripts/check-configs.sh already
// runs over every generated fixture. It needs no privileges and creates no device: box.New
// builds every inbound, outbound and route rule, so a config that survives this is wrong only
// in ways that require the network to discover.
//
// Worth having as a separate entry point because it is the one thing the daemon can do as an
// unprivileged user, which makes it the obvious smoke test on a developer machine.
func Check(ctx context.Context, configJSON string) error {
	ctx, cancel := context.WithCancel(BaseContext(ctx))
	defer cancel()

	options, err := parse(ctx, configJSON)
	if err != nil {
		return err
	}

	// No LogWriter deliberately: a validation run should not create a cache file or take the
	// bbolt lock, because `nexusd check` may well run while a tunnel is up.
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		return err
	}
	return instance.Close()
}

// Open parses a config and constructs the instance. It does NOT bring the tunnel up.
//
// Construction and start are separate because they fail for completely different reasons and
// the caller should be able to tell them apart: Open fails on a bad config, Start fails on the
// machine — no privileges, a device name already taken, a port in use. Collapsing them turns
// every one of those into "could not start".
func Open(ctx context.Context, configJSON string, opts ...Options) (*Tunnel, error) {
	ctx = BaseContext(ctx)

	options, err := parse(ctx, configJSON)
	if err != nil {
		return nil, err
	}

	// Variadic so every existing caller and test keeps compiling unchanged. One value is
	// honoured; more is a caller bug worth failing on rather than silently picking one.
	var settings Options
	switch len(opts) {
	case 0:
	case 1:
		settings = opts[0]
	default:
		return nil, errors.New("Open accepts at most one Options")
	}

	instance, err := box.New(box.Options{
		Context:           ctx,
		Options:           options,
		PlatformLogWriter: settings.LogWriter,
	})
	if err != nil {
		return nil, err
	}

	var defaultMode string
	if options.Experimental != nil && options.Experimental.ClashAPI != nil {
		defaultMode = options.Experimental.ClashAPI.DefaultMode
	}
	return &Tunnel{instance: instance, ctx: ctx, defaultMode: defaultMode}, nil
}

func parse(ctx context.Context, configJSON string) (option.Options, error) {
	options, err := json.UnmarshalExtendedContext[option.Options](ctx, []byte(configJSON))
	if err != nil {
		return option.Options{}, wrap("decode config", err)
	}
	return options, nil
}

// Start brings the tunnel up: creates the TUN device, installs routes, starts every inbound
// and outbound.
//
// This is the call that needs privileges. See permissionError for what happens when they are
// missing and why the wording matters.
func (t *Tunnel) Start() error {
	t.mu.Lock()
	switch {
	case t.closed:
		t.mu.Unlock()
		return errors.New("tunnel is closed")
	case t.started:
		t.mu.Unlock()
		return errors.New("tunnel is already started")
	}
	instance := t.instance
	t.mu.Unlock()

	if err := instance.Start(); err != nil {
		return permissionError(err)
	}

	t.mu.Lock()
	t.started = true
	t.mu.Unlock()

	t.applyDefaultMode()
	return nil
}

// ---------------------------------------------------------------------------------------
// Routing modes (the desktop routing selector, clients/shared/src/core/routing.ts)
// ---------------------------------------------------------------------------------------

// applyDefaultMode puts the tunnel in the mode its config asks for.
//
// sing-box does not, on its own. On start the clash server restores the last mode it saved in
// cache.db (experimental/clashapi/server.go, Start → cacheFile.LoadMode), and that wins over
// default_mode — so a tunnel would come up in whatever mode the previous session ended in while
// the UI shows the one the user just chose. That would be the UI claiming a route that is not
// in effect, which is the one thing the selector must never do.
//
// Connections opened in the moment between the core starting and this call are closed, so none
// of them keeps a route decided by the wrong mode.
func (t *Tunnel) applyDefaultMode() {
	clash := t.clashServer()
	if t.defaultMode == "" || clash == nil || strings.EqualFold(clash.Mode(), t.defaultMode) {
		return
	}
	clash.SetMode(t.defaultMode)
	t.CloseConnections()
}

// Mode reports the routing mode sing-box is applying and every mode the running config
// defines. ok is false while no tunnel is running.
func (t *Tunnel) Mode() (current string, modes []string, ok bool) {
	if !t.Started() {
		return "", nil, false
	}
	clash := t.clashServer()
	if clash == nil {
		return "", nil, false
	}
	return clash.Mode(), clash.ModeList(), true
}

// SetMode switches routing live: the same tunnel, the same TUN device, nothing torn down.
//
// A mode the running config does not define is refused rather than passed on, because sing-box
// would ignore it without a word (clashapi.Server.SetMode returns early) and the caller would be
// told the switch happened. It does not close existing connections: CloseConnections does, as a
// separate step, the way sing-box's own daemon splits them (daemon/started_service.go).
func (t *Tunnel) SetMode(mode string) error {
	if !t.Started() {
		return errors.New("no tunnel is running")
	}
	clash := t.clashServer()
	if clash == nil {
		return errors.New("the running config defines no routing modes")
	}
	available := clash.ModeList()
	if !containsFold(available, mode) {
		return fmt.Errorf("routing mode %q is not available in the running config (available: %s)",
			mode, strings.Join(available, ", "))
	}
	clash.SetMode(mode)
	if !strings.EqualFold(clash.Mode(), mode) {
		return fmt.Errorf("sing-box did not switch to routing mode %q", mode)
	}
	return nil
}

// CloseConnections closes every connection the core has open, so that each is routed afresh
// when the application reconnects — the second half of a mode switch. It returns how many it
// closed.
//
// The connection manager tracks every socket the default dialer opens (common/dialer/default.go,
// trackConn): direct connections and the proxy outbound's own connections alike. Closing them
// ends each relay. The tunnel itself is not touched.
func (t *Tunnel) CloseConnections() int {
	if !t.Started() {
		return 0
	}
	t.mu.Lock()
	ctx := t.ctx
	t.mu.Unlock()
	manager := service.FromContext[adapter.ConnectionManager](ctx)
	if manager == nil {
		return 0
	}
	count := manager.Count()
	manager.CloseAll()
	return count
}

// clashServer is the core's mode switch. It exists for every config the daemon runs: a
// PlatformLogWriter forces one (box.go:160), and so does experimental.clash_api.
// Traffic reports the bytes this tunnel has carried up and down since it was opened.
//
// They are sing-box's own counters: the traffic manager box.New registers in the service
// context this tunnel keeps (box.go, "needClashAPI"), which the clash API and sing-box's own
// daemon read the same way. It exists whenever a clash server does, and the daemon's log writer
// forces one (Options.LogWriter). ok is false only when there is nothing to read.
func (t *Tunnel) Traffic() (uplink, downlink int64, ok bool) {
	t.mu.Lock()
	ctx, closed := t.ctx, t.closed
	t.mu.Unlock()
	if closed || ctx == nil {
		return 0, 0, false
	}
	manager := service.PtrFromContext[trafficcontrol.Manager](ctx)
	if manager == nil {
		return 0, 0, false
	}
	uplink, downlink = manager.Total()
	return uplink, downlink, true
}

func (t *Tunnel) clashServer() adapter.ClashServer {
	t.mu.Lock()
	ctx, closed := t.ctx, t.closed
	t.mu.Unlock()
	if closed || ctx == nil {
		return nil
	}
	return service.FromContext[adapter.ClashServer](ctx)
}

func containsFold(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(value, target) {
			return true
		}
	}
	return false
}

// Close tears the tunnel down, with a deadline.
//
// ORDERING IS SING-BOX'S PROBLEM HERE, NOT OURS. On Android we had to close the tun fd before
// the core, because the packet reader blocked on a setBlocking(true) fd and closing the core
// first deadlocked. Here sing-box owns both ends of that and unwinds them itself.
//
// What does NOT go away is the deadline. box.Close() can block on a network operation, and
// while it blocks the routes are still installed — so on a desktop a hung teardown is not an
// inconvenience, it is a machine with no internet. We wait CloseTimeout and then report the
// truth rather than waiting forever.
//
// A timeout is a genuinely bad state: something is still holding the device. ErrCloseTimeout
// exists so the caller can escalate instead of assuming it worked. ADR-0003 §4.3's janitor —
// reclaiming stale routes and adapters on next start — is the answer to that state, and is
// Phase 8.
//
// ABOUT cache.db: sing-box takes an exclusive bbolt flock on it. Closing fully before opening
// the next instance is what keeps a server switch from failing with
// "initialize cache-file: timeout", which is the mobile bug in NexusVpnService's
// CACHE_LOCK_ATTEMPTS retry loop. Sequencing that is the caller's job; this function's part of
// the bargain is not returning until the lock is actually released, or saying that it could
// not.
func (t *Tunnel) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	instance := t.instance
	t.instance = nil
	t.mu.Unlock()

	if instance == nil {
		return nil
	}

	done := make(chan error, 1)
	go func() { done <- instance.Close() }()

	select {
	case err := <-done:
		return err
	case <-time.After(CloseTimeout):
		return ErrCloseTimeout
	}
}

// Started reports whether Start succeeded and Close has not run.
func (t *Tunnel) Started() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.started && !t.closed
}

// permissionError rewrites a privilege failure into a message that tells the user what to do.
//
// CORRECTED 2026-09-23. This used to claim that useNexusCore.ts matches /permission denied/i to
// render such a failure "differently — 'you need to allow this'". It did not: that regex meant
// "the user declined Android's VPN consent dialog" and HID the error entirely, so a
// non-elevated desktop Connect returned silently to "Disconnected" (observed end to end from
// the Tauri window). clients/shared now matches only the exact Android sentinel,
// 'VPN permission denied', so this message is shown in full as a failure. The wording no
// longer carries a UI contract; it only has to be accurate and actionable.
//
// The underlying errors are unhelpful on their own: Linux gives EPERM from the /dev/net/tun
// ioctl, Windows gives ERROR_ACCESS_DENIED from adapter creation, and neither says what the
// user should do about it.
func permissionError(err error) error {
	if err == nil {
		return nil
	}

	if !errors.Is(err, os.ErrPermission) && !mentionsPermission(err) {
		return err
	}

	return wrap(
		"permission denied: creating a TUN device and changing the routing table needs "+
			"elevated privileges (CAP_NET_ADMIN on Linux, Administrator on Windows, root on macOS)",
		err,
	)
}

// mentionsPermission catches what errors.Is misses.
//
// sing-tun and the OS layers below it frequently wrap a syscall error in a string without
// preserving the sentinel, so errors.Is(err, os.ErrPermission) returns false for a failure
// that is unmistakably a permission failure. Matching text is unpleasant and is done here
// rather than in the UI, so there is exactly one place in the system that does it.
func mentionsPermission(err error) bool {
	message := strings.ToLower(err.Error())
	for _, needle := range []string{
		"operation not permitted",
		"access is denied",
		"permission denied",
		"must be run as root",
		"requires elevation",
	} {
		if strings.Contains(message, needle) {
			return true
		}
	}
	return false
}

func wrap(message string, err error) error {
	return errors.New(message + ": " + err.Error())
}
