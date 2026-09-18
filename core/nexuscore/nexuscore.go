// Package nexuscore is the Nexus-owned façade over sing-box's libbox.
//
// It is compiled to an Android AAR and an Apple XCFramework by gomobile, alongside libbox
// itself. See core/README.md for the build and for the gomobile type restrictions that
// constrain every exported signature in this package.
package nexuscore

import (
	"runtime"

	"github.com/sagernet/sing-box/experimental/libbox"
)

// appVersion is stamped into libbox's crash reports and, more usefully, into every bench run.
// A benchmark without a build identity is not a result (bench/README.md).
const appVersion = "0.1.0"

// Setup must be called exactly once per process, before anything else in this package.
//
// Wrapped rather than re-exported because libbox.SetupOptions has grown across versions and we
// do not want that churn reaching Kotlin and Swift. Native passes three paths; everything else
// is Nexus policy, set here.
//
// basePath      — command socket and config snapshots. Android: filesDir. Apple: the App
//                 Group container, so the app process and the extension can both see it.
// workingPath   — persistent state: cache DB, rule-set cache, crash reports.
// tempPath      — scratch.
func Setup(basePath string, workingPath string, tempPath string) error {
	return libbox.Setup(&libbox.SetupOptions{
		BasePath:    basePath,
		WorkingPath: workingPath,
		TempPath:    tempPath,

		// Android-only workaround in libbox for Go stack handling on some devices. gomobile
		// sets GOOS=android for the Android build, so this needs no parameter and cannot be
		// set wrong by a caller.
		FixAndroidStack: runtime.GOOS == "android",

		// 0 keeps the command server on a unix socket under BasePath rather than a localhost
		// TCP port. On Android a localhost listener is reachable by any other app on the
		// device — the socket is not. Do not change this to a port for convenience.
		CommandServerListenPort: 0,

		// Left empty deliberately. The unix socket is already confined to our app sandbox, and
		// a shared secret would have to be threaded to every CommandClient in Kotlin and
		// Swift. Worth revisiting if we ever move the command server to a TCP port — at that
		// point it stops being optional.
		CommandServerSecret: "",

		// Bounded log retention. The command server holds these in memory, and on Apple that
		// memory is inside the ~50 MB extension budget (ADR-0001 §3.3). Note this field is a
		// plain int, not int32.
		LogMaxLines: 512,

		Debug: false,

		CrashReportSource:   "nexus",
		AppVersion:          appVersion,
		AppMarketingVersion: appVersion,

		// OOM KILLER: OFF, deliberately.
		//
		// libbox can self-terminate above OomMemoryLimit. Against Apple's ~50 MB
		// NEPacketTunnelProvider ceiling that sounds attractive, but a self-kill drops the
		// user's tunnel exactly as hard as the OS kill it is trying to pre-empt — we would be
		// trading an involuntary death for a voluntary one and gaining nothing.
		//
		// GOMEMLIMIT (runtime.go) is the better instrument: it applies GC backpressure as the
		// heap approaches the ceiling instead of killing the process. Revisit only if a B-03
		// run shows we cross the cap despite the limit, which would mean the allocation is on
		// a path the GC cannot reclaim fast enough.
		OomKillerEnabled:  false,
		OomKillerDisabled: true,
		OomMemoryLimit:    0,

		// UNKNOWN SEMANTICS — left off pending investigation.
		//
		// New in 1.14 and the name is tantalising for this project, but we do not know whether
		// it reports power usage (which would be a gift for bench/B-01) or subscribes to
		// platform power callbacks (which could be an extra wakeup source, i.e. the opposite
		// of what we want). Do not enable it because it sounds on-topic. Read the upstream
		// implementation, then decide, then measure.
		PowerReportEnabled: false,
	})
}

// Version reports the pinned sing-box version. Surfaced in the UI's about screen and stamped
// into every bench run.
func Version() string {
	return libbox.Version()
}
