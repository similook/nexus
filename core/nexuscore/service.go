package nexuscore

import (
	"errors"
	"sync"

	"github.com/sagernet/sing-box/experimental/libbox"
)

// Service is the Nexus-owned wrapper around libbox's service lifecycle.
//
// ============================ 1.14 ARCHITECTURE NOTE ============================
//
// In 1.12 this wrapped libbox.BoxService, built by libbox.NewService(config, platform).
// Both are gone in 1.14. The lifecycle moved onto CommandServer, which wraps
// daemon.StartedService — the same type NewOOMReporter(*daemon.StartedService) takes.
//
// Config is no longer a constructor argument. You build a CommandServer from the
// PlatformInterface, Start() it, and then hand it config via StartOrReloadService(). Reload
// stops being "tear down and rebuild" and becomes a first-class operation on a long-lived
// server.
//
// Consequence: the command server is no longer optional. It used to be just the UI's status
// channel, which we could in principle have started on demand. It now owns the tunnel, so it
// runs for exactly as long as the tunnel does.
//
// ================================================================================
//
// Why this wrapper exists rather than binding libbox straight to Kotlin/Swift:
//
//  1. It is where the power policy lives. ADR-0001: the core sets the ceiling, the policy
//     layer decides whether we reach it. That policy is identical on both platforms, so it is
//     written once here rather than twice in Kotlin and Swift where the copies drift.
//  2. It is the seam that contains API drift. The entire 1.14 rewrite lives in this file and
//     in power.go's interface declarations. Kotlin and Swift did not change at all.
//  3. It applies the runtime memory policy (runtime.go) before the core allocates anything,
//     which is not possible from the host side.
//
// NOTE ON PlatformInterface: we do NOT implement libbox.PlatformInterface in Go. It is
// implemented natively — its job is to hand back a TUN fd, resolve package names by UID and
// read WiFi state, all platform calls. We take the native implementation and pass it through.
// ===================== LOCKING RULE - READ BEFORE EDITING =====================
//
// s.mu guards THIS STRUCT'S FIELDS ONLY. It must never be held across a call into libbox.
//
// WHY: libbox calls back into us. Service implements CommandServerHandler, so
// StartOrReloadService() and CloseService() synchronously invoke our ServiceStop() and
// ServiceReload() - both of which take s.mu. Go's sync.Mutex is not reentrant, so the calling
// goroutine blocks on itself and never returns.
//
// That is a silent, total freeze rather than a crash. Observed symptom: openTun completes and
// logs "established fd=...", then the core goes permanently silent - no further GoLog output,
// no status, no traffic - while the UI sits on "Connecting" forever. Nothing in logcat says
// "deadlock"; the goroutine is simply parked.
//
// PATTERN: snapshot the fields you need under the lock, unlock, then call libbox, then
// re-lock to record the result. Every method here follows it.
//
// ==============================================================================
type Service struct {
	mu sync.Mutex

	server *libbox.CommandServer
	power  *PowerController

	config  string
	started bool
	closed  bool
}

var errNotStarted = errors.New("nexuscore: service not started")

// NewService builds the command server but does not start the tunnel.
//
// The Service itself implements libbox.CommandServerHandler (bottom of this file) — that is
// how the core calls back into us.
func NewService(configContent string, platform libbox.PlatformInterface) (*Service, error) {
	if platform == nil {
		return nil, errors.New("nexuscore: nil platform interface")
	}

	// Must happen before the server is constructed: the memory limit has to be in force
	// before the core starts allocating, not after it has spiked past the ceiling.
	tuneRuntime(platform.UnderNetworkExtension())

	s := &Service{config: configContent}

	server, err := libbox.NewCommandServer(s, platform)
	if err != nil {
		return nil, err
	}
	s.server = server

	// The power policy drives the server. It depends on methods, never on a type, which is
	// why power.go needed no code change when BoxService was deleted (see power.go).
	//
	// If this line fails with "does not implement pauser (missing Pause method)", that is the
	// single most important thing to know about this upgrade — Pause/Wake are the whole
	// product thesis. Do not work around it; find where they moved.
	s.power = newPowerController(server, s.onPowerStateChange)

	return s, nil
}

// Start brings up the command server, then loads the config.
//
// Order matters: StartOrReloadService needs a running server to attach the service to. A
// failure in step two leaves the server up with no tunnel — which is exactly the state the UI
// renders as "Connection failed" — so we deliberately do not tear the server down for it.
func (s *Service) Start() error {
	// SNAPSHOT, UNLOCK, THEN CALL LIBBOX. Never hold s.mu across a libbox call - see the
	// deadlock note on the Service type.
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("nexuscore: service closed")
	}
	if s.started {
		s.mu.Unlock()
		return nil
	}
	server, config := s.server, s.config
	s.mu.Unlock()

	if err := server.Start(); err != nil {
		return err
	}

	// MUST be a real struct, never nil.
	//
	// Passing nil here was a deliberate choice to avoid naming the OverrideOptions type (so a
	// rename could not break the build), with the documented risk that libbox might dereference
	// it unconditionally. It does. On a device that is:
	//
	//   panic: runtime error: invalid memory address or nil pointer dereference
	//   [signal SIGSEGV ... addr=0x8]
	//   libbox.(*CommandServer).StartOrReloadService(0x..., {0x..., 0x194}, 0x0)
	//                                                                      ^^^ our nil
	//
	// addr=0x8 is a nil pointer plus a field offset — libbox reading options.<field>. Because
	// it is a Go panic on a Go thread it aborts the process outright, so no Kotlin try/catch
	// anywhere on the path can see it.
	//
	// An empty struct means "override nothing", which is what nil was meant to express.
	if err := server.StartOrReloadService(config, &libbox.OverrideOptions{}); err != nil {
		return err
	}

	s.mu.Lock()
	s.started = true
	s.mu.Unlock()
	return nil
}

// Reload swaps config without dropping the command server or the UI's subscriptions.
//
// New capability in 1.14 — under BoxService this meant destroying and rebuilding everything.
// Worth using: a reload that keeps the server up avoids re-establishing the command socket and
// the UI's status stream.
func (s *Service) Reload(configContent string) error {
	s.mu.Lock()
	if !s.started {
		s.mu.Unlock()
		return errNotStarted
	}
	server := s.server
	s.mu.Unlock()

	if err := server.StartOrReloadService(configContent, &libbox.OverrideOptions{}); err != nil {
		return err
	}

	s.mu.Lock()
	s.config = configContent
	s.mu.Unlock()
	return nil
}

// Close stops the tunnel and then the command server.
//
// CloseService() stops the service; the command server itself is a separate object with its
// own socket listener. Closing only the service would leak that listener on every
// stop/start cycle, which in a long-lived app is a real fd leak — hence the second step.
//
// The server-close call is an optional type assertion because Close() on CommandServer is
// unconfirmed for 1.14 (CloseService is confirmed; see scripts/dump-api.sh section 2). Promote
// it to a direct call once confirmed.
func (s *Service) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.started = false
	server := s.server
	s.mu.Unlock()

	s.power.close()

	if server == nil {
		return nil
	}

	// Unlocked: CloseService tears the service down, which makes libbox call our
	// ServiceStop() handler. Holding s.mu here would deadlock exactly as Start() did.
	err := server.CloseService()

	if c, ok := any(server).(interface{ Close() }); ok {
		c.Close()
	} else if c, ok := any(server).(interface{ Close() error }); ok {
		if cerr := c.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}

	return err
}

// --- lifecycle, called from the Capacitor plugin ---------------------------------------
//
// Unchanged across the 1.14 rewrite. These are the four signals the power policy needs;
// everything else the platform emits maps onto one of them or is dropped. Resist adding a
// fifth.

// SetScreenOn: ACTION_SCREEN_ON / ACTION_SCREEN_OFF on Android; forwarded from the app process
// on iOS. Debounced internally — safe to call on every event.
func (s *Service) SetScreenOn(on bool) { s.power.SetScreenOn(on) }

// SetDeviceIdle: Doze on Android, extension sleep on Apple. The one that pauses for real.
func (s *Service) SetDeviceIdle(idle bool) { s.power.SetDeviceIdle(idle) }

// NetworkChanged: the default network changed underneath us.
func (s *Service) NetworkChanged() { s.power.NetworkChanged() }

// SetUIForeground tells the core whether anyone is actually looking at it.
//
// Separate from screen state on purpose: the WebView can be backgrounded while the screen is
// on. With no UI attached there is no reason to compute, serialise or ship status payloads,
// and on Apple that serialisation happens inside the ~50 MB extension.
func (s *Service) SetUIForeground(foreground bool) {
	if foreground {
		s.power.tasks.Resume()
	}
	// Deliberately asymmetric: backgrounding the UI does NOT suspend the coalescer, because
	// non-UI periodic work still runs while the screen is on. UI streams are stopped by the
	// command layer, not here.
}

// PowerState exposes the current state as int32 for the host bridge (gomobile does not bind
// named integer types predictably). Values match the PowerState constants in power.go.
func (s *Service) PowerState() int32 { return int32(s.power.State()) }

// NeedWIFIState: the host should only pay for a location prompt and a WiFi scan if the loaded
// config actually routes on SSID/BSSID.
//
// Optional assertion — unconfirmed on CommandServer for 1.14. Absent means we report false,
// so the host never prompts for location. That is the safe direction to fail.
func (s *Service) NeedWIFIState() bool {
	s.mu.Lock()
	started, server := s.started, s.server
	s.mu.Unlock()

	if !started || server == nil {
		return false
	}
	if n, ok := any(server).(interface{ NeedWIFIState() bool }); ok {
		return n.NeedWIFIState()
	}
	return false
}

// UpdateWIFIState is called by the host after a network change when NeedWIFIState is true.
//
// Optional assertion — was a BoxService method in 1.12, unconfirmed on CommandServer. Absent
// means SSID-based routing rules do not refresh: a degraded feature rather than a build
// failure. dump-api.sh section 8 answers it; make this unconditional once confirmed. A silent
// no-op is a stopgap, not a resting state.
func (s *Service) UpdateWIFIState() error {
	s.mu.Lock()
	started, server := s.started, s.server
	s.mu.Unlock()

	if !started || server == nil {
		return errNotStarted
	}
	if u, ok := any(server).(interface{ UpdateWIFIState() }); ok {
		u.UpdateWIFIState()
	}
	return nil
}

func (s *Service) onPowerStateChange(state PowerState) {
	// Intentionally minimal. Runs under the power controller's lock; anything that blocks here
	// stalls a lifecycle callback on the platform's main thread.
	_ = state
}

// =========================================================================================
// libbox.CommandServerHandler
// =========================================================================================
//
// The 1.14 method set, as reported by the compiler. If any signature is still wrong the build
// fails here naming the exact method — which is the failure we want, confined to one file.
//
// These are real implementations rather than `return nil` stubs. A handler that silently
// succeeds at something it did not do is worse than one that fails honestly: it turns a clear
// error into a behavioural mystery later.

// ServiceStop is invoked when the core stops the service — including for reasons we did not
// initiate, such as a core failure or the platform revoking the tunnel. Keeping `started` in
// sync here is what stops NeedWIFIState and Reload from acting on a dead service.
func (s *Service) ServiceStop() error {
	s.mu.Lock()
	s.started = false
	s.mu.Unlock()
	return nil
}

// ServiceReload is invoked when something asks the core to reload — the UI's reload command,
// or the core itself. Re-applies the config we hold.
func (s *Service) ServiceReload() error {
	s.mu.Lock()
	config := s.config
	started := s.started
	server := s.server
	s.mu.Unlock()

	if !started || server == nil {
		return errNotStarted
	}
	return server.StartOrReloadService(config, &libbox.OverrideOptions{})
}

// GetSystemProxyStatus — a desktop concept. On mobile the TUN captures traffic and there is no
// system proxy to report.
//
// Empty literal on purpose: the field names on SystemProxyStatus are unverified for 1.14, and
// naming a field we have not confirmed is a needless build risk. The zero value already means
// "unavailable, disabled", which is the truth on mobile.
func (s *Service) GetSystemProxyStatus() (*libbox.SystemProxyStatus, error) {
	return &libbox.SystemProxyStatus{}, nil
}

// SetSystemProxyEnabled — see above. Returns an error rather than silently ignoring: a caller
// reaching this on mobile is operating on a wrong assumption, and should hear about it.
func (s *Service) SetSystemProxyEnabled(enabled bool) error {
	_ = enabled
	return errors.New("nexuscore: system proxy is not available on mobile")
}

// TriggerNativeCrash is a diagnostic facility for reproducing native crash reporting.
//
// Deliberately refused. In this app the process it would crash is the tunnel — dropping the
// user's VPN and, with always-on enabled, their connectivity. If we ever need it, gate it
// behind a debug build rather than leaving it reachable in production.
func (s *Service) TriggerNativeCrash() error {
	return errors.New("nexuscore: native crash trigger is disabled in this build")
}

// WriteDebugMessage receives diagnostic text from the core.
//
// Intentionally a no-op rather than a log write. The core already has its own bounded log ring
// (LogMaxLines = 512 in nexuscore.go), which is what the UI reads; duplicating into a second,
// unbounded sink inside a memory-capped process is how the Apple extension budget gets eaten.
func (s *Service) WriteDebugMessage(message string) {
	_ = message
}

// ConnectSSHAgent is for SSH outbounds with agent forwarding. There is no SSH agent on a phone.
//
// Returns an error rather than (-1, nil): handing back -1 as a valid file descriptor invites
// the caller to use it. This is only ever reached if a config contains an SSH outbound
// requesting agent forwarding, which ours do not.
func (s *Service) ConnectSSHAgent() (int32, error) {
	return -1, errors.New("nexuscore: SSH agent forwarding is not supported on mobile")
}
