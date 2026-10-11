// Package ipc carries the Nexus core contract between an unprivileged client and the
// privileged daemon.
//
// ============================================================================================
// THE WIRE FORMAT, AND WHY IT IS NOT gRPC
//
// Newline-framed JSON over a local socket. One JSON document per line, in both directions.
//
// sing-box already ships a gRPC command server, and on mobile we use it — ipc-boundary.md §3
// argues at length for not building a parallel channel. That argument does not carry here,
// because the premise changed: on mobile the plugin and the core are in DIFFERENT PROCESSES,
// and gRPC is what crosses between them. On desktop nexusd hosts sing-box in-process. Using
// libbox's command server would mean the daemon serialising gRPC to itself.
//
// What remains is the boundary between the GUI and the daemon, and for that the deciding
// argument is ADR-0003 §4.2: the Tauri host must be able to forward opaque bytes without
// holding a model of the protocol. If the host had to speak gRPC it would need tonic, proto
// codegen, and generated Rust types — a third place the contract lives, in a language nobody
// here writes. With framed JSON the host reads a line and passes it on, so the contract lives
// in exactly two places: this package and clients/shared/src/core/plugin.ts.
//
// That is a real improvement on the mobile situation, where plugin.ts hand-mirrors
// NexusPlugin.kt and the file itself admits a mismatch "fails at runtime with an unhelpful
// error, not at build time."
//
// # WHY NEWLINE FRAMING RATHER THAN A LENGTH PREFIX
//
// json.Encoder already emits exactly one line per document, and JSON cannot contain a raw
// newline outside a string literal, so a line IS a frame. A length prefix would buy the
// ability to carry binary — which this contract never does, because every payload here is
// counters and short strings at no more than 1 Hz (R4).
// ============================================================================================
package ipc

import "encoding/json"

// Protocol is the wire version.
//
// Sent in the hello frame the moment a client connects, so a mismatch is one clear error at
// connect time rather than a method failing obscurely later. The GUI and the daemon are
// updated independently — certainly on Linux, where they may come from different packages —
// so this will be load-bearing eventually.
//
// Bump it when a method or event changes shape. Adding a method does not need a bump; a client
// that does not know about it will not call it.
const Protocol = 1

// Method names. These are the 12 the UI actually calls, and no more.
//
// clients/shared/src/core/plugin.ts also DECLARES reload, selectOutbound and urlTest. Each has
// zero call sites in the frontend. They are not implemented here because an unimplemented
// method is honest, whereas an implemented-but-unused one is surface a privileged daemon has to
// defend forever.
//
// setClashMode and closeConnections were in that list until the desktop routing selector gave
// them a caller (clients/shared/src/core/routing.ts). Both were already in the contract.
const (
	MethodStart            = "start"
	MethodStop             = "stop"
	MethodGetStatus        = "getStatus"
	MethodTCPPing          = "tcpPing"
	MethodPingProxy        = "pingProxy"
	MethodReadLogs         = "readLogs"
	MethodClearLogs        = "clearLogs"
	MethodSetLogStreaming  = "setLogStreaming"
	MethodSetClashMode     = "setClashMode"
	MethodCloseConnections = "closeConnections"

	// Test All's per-server Delay (desktop/probe). Added without a Protocol bump: a client
	// that does not know them never calls them.
	MethodProbeServers = "probeServers"
	MethodCancelProbe  = "cancelProbe"
)

// Event names, matching the ones the UI subscribes to via coreEvents.
const (
	EventHello        = "hello"
	EventStatus       = "status"
	EventServiceState = "serviceState"
	EventProxyDelay   = "proxyDelay"
	EventClashMode    = "clashMode"

	EventServerProbe     = "serverProbe"
	EventServerProbeDone = "serverProbeDone"
)

// ServiceState mirrors the TypeScript union exactly.
//
// "unknown" is the one that matters and the one a reimplementation would leave out. It means
// the daemon cannot confirm either way right now — a reconnect after the client was away, a
// start still in flight. The UI has a specific branch for it; collapsing it into "stopped"
// reintroduces the resume bug where the uptime clock restarted from zero on every return.
type ServiceState string

const (
	StateStopped  ServiceState = "stopped"
	StateStarting ServiceState = "starting"
	StateStarted  ServiceState = "started"
	StateUnknown  ServiceState = "unknown"
)

// ---------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------

// Request is a client-to-daemon call. Every request carries an id; replies quote it, so
// responses may arrive out of order without the client losing track.
type Request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Frame is everything the daemon sends. It is one type and not two because both shapes share
// a stream, and a reader that has to guess which it is holding is a reader that will
// eventually guess wrong.
//
// Exactly one of ID (a response) or Event (a push) is set. Ok is a pointer so its absence is
// distinguishable from false — an event has no Ok at all, and a response with Ok:false and no
// Error would otherwise be indistinguishable from an event.
type Frame struct {
	ID    uint64          `json:"id,omitempty"`
	Ok    *bool           `json:"ok,omitempty"`
	Error string          `json:"error,omitempty"`
	Event string          `json:"event,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// IsEvent reports whether this frame is a push rather than a reply.
func (f *Frame) IsEvent() bool { return f.Event != "" }

// ---------------------------------------------------------------------------------------
// Payloads — these mirror clients/shared/src/core/plugin.ts field for field
// ---------------------------------------------------------------------------------------

// StartParams is the config to run.
//
// Name is cosmetic: it labels the active node in the UI and in logs. It is NOT used to pick
// anything, which is why it is safe for it to be an arbitrary string from an untrusted client.
type StartParams struct {
	Config string `json:"config"`
	Name   string `json:"name,omitempty"`
}

// StatusSnapshot is the reply to getStatus and the payload of a status event.
//
// TrafficAvailable is the field to read first. When false, the counters below it are UNKNOWN,
// not zero, and the UI renders them as "—" rather than "0.00". That distinction exists because
// a dashboard confidently showing 0.00 MB/s over a working tunnel is worse than one admitting
// it does not know.
type StatusSnapshot struct {
	State         ServiceState `json:"state"`
	CoreStartedAt int64        `json:"coreStartedAt"`

	TrafficAvailable bool `json:"trafficAvailable"`

	Uplink         int64 `json:"uplink"`
	Downlink       int64 `json:"downlink"`
	UplinkTotal    int64 `json:"uplinkTotal"`
	DownlinkTotal  int64 `json:"downlinkTotal"`
	ConnectionsIn  int32 `json:"connectionsIn"`
	ConnectionsOut int32 `json:"connectionsOut"`

	Memory     int64 `json:"memory"`
	Goroutines int32 `json:"goroutines"`

	// ClashMode and ClashModes repeat what the last clashMode event said, so a client that
	// missed it — a page that loaded after the tunnel came up — reconciles from getStatus the
	// way it does for everything else. Empty while no tunnel is running.
	ClashMode  string   `json:"clashMode,omitempty"`
	ClashModes []string `json:"clashModes,omitempty"`
}

// ServiceStateEvent carries a transition. Reason is set on failure and is the string the UI
// pattern-matches for /permission denied/i — see desktop/tunnel.permissionError.
type ServiceStateEvent struct {
	State  ServiceState `json:"state"`
	Reason string       `json:"reason,omitempty"`
}

// PingTarget is one node to probe.
type PingTarget struct {
	ID     string `json:"id"`
	Server string `json:"server"`
	Port   int    `json:"port"`
}

type TCPPingParams struct {
	Targets []PingTarget `json:"targets"`
}

// PingResult reports one probe. MS is -1 for a failed or timed-out handshake — not an error,
// because "unreachable" is a measurement, and half a sweep failing must not fail the sweep.
type PingResult struct {
	ID string `json:"id"`
	MS int    `json:"ms"`
}

type TCPPingResult struct {
	Results []PingResult `json:"results"`
}

// ProxyDelayEvent is the result of pingProxy, which returns immediately and answers here.
type ProxyDelayEvent struct {
	DelayMS int  `json:"delayMs"`
	Ok      bool `json:"ok"`
}

type ReadLogsParams struct {
	Limit int `json:"limit,omitempty"`
}

type ReadLogsResult struct {
	Lines []string `json:"lines"`
}

type SetLogStreamingParams struct {
	Enabled bool `json:"enabled"`
}

// SetClashModeParams names the routing mode to switch to: one the running config defines (see
// desktop/tunnel.SetMode), or the call is refused.
type SetClashModeParams struct {
	Mode string `json:"mode"`
}

// ClashModeEvent is the routing mode sing-box is applying. Pushed after a start, after every
// switch, and to a client that connects while a tunnel is up. Modes is every mode the running
// config defines — the ones a switch can reach without reconnecting.
type ClashModeEvent struct {
	Modes   []string `json:"modes,omitempty"`
	Current string   `json:"current"`
}

// ProbeServersParams starts a Test All Delay run: each target's own config is probed in a
// short-lived instance beside the tunnel (desktop/probe). RunID is the client's, echoed on
// every event so a stale run's results can be told apart.
type ProbeServersParams struct {
	RunID   int64         `json:"runId"`
	Targets []ProbeTarget `json:"targets"`
}

// ProbeTarget is one server: its node id, the client's fingerprint of its config, and the
// node's full generated config (only its "proxy" outbound is used).
type ProbeTarget struct {
	ID          string `json:"id"`
	Fingerprint string `json:"fingerprint"`
	Config      string `json:"config"`
}

type ProbeServersResult struct {
	RunID int64 `json:"runId"`
}

type CancelProbeParams struct {
	RunID int64 `json:"runId"`
}

// ServerProbeEvent is one server's result. Status is a sanitized category (ok, timeout,
// refused, unreachable, dns_failed, handshake_failed, rejected, config_invalid, cancelled,
// failed) - never an error text, which would carry hosts and addresses.
type ServerProbeEvent struct {
	RunID       int64  `json:"runId"`
	ServerID    string `json:"serverId"`
	Fingerprint string `json:"fingerprint"`
	Status      string `json:"status"`
	DelayMS     int32  `json:"delayMs"`
}

// ServerProbeDoneEvent ends a run: every result it will send has been sent.
type ServerProbeDoneEvent struct {
	RunID     int64 `json:"runId"`
	Cancelled bool  `json:"cancelled"`
}

// HelloEvent is the first frame on every connection.
type HelloEvent struct {
	Protocol int    `json:"protocol"`
	Daemon   string `json:"daemon"`
	OS       string `json:"os"`
}
