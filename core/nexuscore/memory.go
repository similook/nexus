package nexuscore

import "runtime/metrics"

// GoMemoryBytes reports what the Go runtime holds from the OS: everything it has mapped, minus
// what it has already released back. bench/B-03 stage 2 (on a device) logs it beside the
// extension's os_proc_available_memory(), so each sample says how much of Apple's ~50 MB
// ceiling is the Go runtime's.
//
// runtime/metrics reads are cheap and do not stop the world; still, this is for a once-a-second
// diagnostic timer, never the packet path.
func GoMemoryBytes() int64 {
	samples := []metrics.Sample{
		{Name: "/memory/classes/total:bytes"},
		{Name: "/memory/classes/heap/released:bytes"},
	}
	metrics.Read(samples)
	return int64(samples[0].Value.Uint64() - samples[1].Value.Uint64())
}
