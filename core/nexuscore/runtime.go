package nexuscore

import (
	"runtime/debug"
)

// Go runtime tuning. This file exists because of ADR-0001 §5.3: RAM and battery are in
// tension. A tight GOMEMLIMIT with a low GOGC keeps us under Apple's ceiling but raises GC
// frequency, and GC frequency is background CPU, which is battery.
//
// Policy: set the limit to survive, keep GOGC as HIGH as the limit allows, and buy headroom
// back by allocating less on the packet path — never by turning the GC up.

const (
	// Apple gives an NEPacketTunnelProvider roughly 50 MB for the whole extension process,
	// Go runtime included. We target well under it: a soft limit only forces more GC, it
	// does not prevent the OS kill, so the margin has to be real.
	//
	// Verify against a B-03 run before changing. Do not tune this from intuition.
	memoryLimitNetworkExtension = 40 << 20 // 40 MiB

	// Android VpnService has no hard per-process cap, but a bloated tunnel process is the
	// first thing the low-memory killer takes. Generous, still bounded.
	memoryLimitDefault = 128 << 20 // 128 MiB

	// Deliberately high. Under a memory limit the runtime already tightens the trigger as
	// the heap approaches the ceiling; setting GOGC low on top of that double-counts and
	// buys us nothing but wakeups.
	gcPercent = 100
)

// tuneRuntime applies the memory policy for the process we are running in.
// underNetworkExtension comes from the platform, not from build tags — the same binary
// runs in the Android service and the Apple extension.
func tuneRuntime(underNetworkExtension bool) {
	limit := int64(memoryLimitDefault)
	if underNetworkExtension {
		limit = memoryLimitNetworkExtension
	}
	debug.SetMemoryLimit(limit)
	debug.SetGCPercent(gcPercent)
}

// releaseMemory returns free heap to the OS. Called on transitions into an idle state, where
// we are about to do nothing for a long time and the RSS high-water mark is what gets us
// killed. Never call this on a hot path: it forces a stop-the-world and a full scavenge.
func releaseMemory() {
	debug.FreeOSMemory()
}
