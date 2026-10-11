package ipc

import (
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/log"
)

// logRing is a bounded, in-memory ring of the core's log output.
//
// ============================================================================================
// WHY A RING, AND WHY PULLED RATHER THAN PUSHED
//
// ipc-boundary.md R3: "Logs are pulled, not pushed." The buffer is capped inside the core
// process and the UI fetches it when a log screen opens. Subscribing at start instead would be
// a wakeup per log line, forever, to fill a buffer nobody reads.
//
// R5 is the other half: nothing unbounded. A desktop daemon runs for weeks, and sing-box at
// info level emits a line per connection. An unbounded slice here is a memory leak with a log
// viewer on top — slower to notice than on mobile, where the process gets killed and hides it.
//
// 512 lines matches libbox's LogMaxLines so the two platforms show a user the same amount of
// history in a bug report.
//
// # WHAT SETTING THIS UP ALSO TURNS ON
//
// box.Options.PlatformLogWriter being non-nil has two side effects upstream, both at box.go:
//
//	:157  forces needCacheFile - so cache.db exists and the bbolt flock applies. That is the
//	      lock behind "initialize cache-file: timeout" on a server switch, which is why
//	      Server.start closes the previous tunnel completely before starting the next.
//	:160  forces a clash server - which is where traffic counters live. Not yet reachable
//	      through an exported API (see Server.status), but the plumbing is already on.
//
// Neither is a surprise; both are worth knowing before someone "optimises" this away.
// ============================================================================================
type logRing struct {
	mu      sync.Mutex
	lines   []string
	next    int
	wrapped bool
}

func newLogRing(size int) *logRing {
	return &logRing{lines: make([]string, size)}
}

// WriteMessage implements sing-box's log.PlatformWriter. Called from core goroutines, on the
// hot path for anything that logs per connection, so it must stay allocation-light and must
// never block.
func (r *logRing) WriteMessage(level log.Level, message string) {
	r.write(level, message)
}

func (r *logRing) write(level log.Level, message string) {
	// DO NOT PREFIX THE LEVEL, AND DO STRIP ANSI.
	//
	// sing-box hands WriteMessage a message that is ALREADY formatted - it carries its own
	// colourised level and uptime marker, e.g.
	//
	//	"\x1b[37mDEBUG\x1b[0m[0000] [123 23ms] dns: exchanged example.com NOERROR"
	//
	// Adding log.FormatLevel(level) in front produced "debug DEBUG[0000] ..." - the level
	// twice, once of it wearing escape codes. And the escape codes themselves are wrong for
	// this ring: the destination is the UI's log view, which renders text, so a raw \x1b[37m
	// shows up as literal junk rather than as a colour.
	//
	// So: our own absolute timestamp (sing-box only gives a relative uptime, and a bug report
	// needs wall-clock to line up with everything else), then the message with colour removed.
	// `level` stays in the signature because it is part of log.PlatformWriter and because
	// filtering by it is the obvious next feature.
	line := time.Now().Format("15:04:05.000") + " " + stripANSI(message)

	r.mu.Lock()
	defer r.mu.Unlock()

	r.lines[r.next] = line
	r.next = (r.next + 1) % len(r.lines)
	if r.next == 0 {
		r.wrapped = true
	}
}

// read returns up to limit lines, oldest first. limit <= 0 means everything held.
func (r *logRing) read(limit int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	size := len(r.lines)
	count := r.next
	if r.wrapped {
		count = size
	}
	if count == 0 {
		// An empty slice, never nil: nil marshals to JSON `null`, and the UI expects an
		// array it can call .length on. A null here is a TypeError in the log view.
		return []string{}
	}

	if limit > 0 && limit < count {
		count = limit
	}

	out := make([]string, 0, count)
	// Walk backwards from the newest, then reverse — that is what makes `limit` mean "the
	// most recent N" rather than "the oldest N", which is what a log viewer wants.
	for i := 0; i < count; i++ {
		index := (r.next - 1 - i + size*2) % size
		out = append(out, r.lines[index])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// stripANSI removes CSI escape sequences.
//
// Narrow on purpose: it handles ESC [ ... <final byte in @-~>, which is every sequence
// sing-box's colour output actually emits. A general terminal-escape parser would be more
// code defending against input we generate ourselves.
func stripANSI(input string) string {
	if !strings.ContainsRune(input, 0x1b) {
		return input
	}

	var out strings.Builder
	out.Grow(len(input))

	for i := 0; i < len(input); i++ {
		if input[i] != 0x1b || i+1 >= len(input) || input[i+1] != '[' {
			out.WriteByte(input[i])
			continue
		}
		// Skip ESC [ then everything up to and including the final byte.
		j := i + 2
		for j < len(input) && (input[j] < '@' || input[j] > '~') {
			j++
		}
		i = j // the loop's i++ steps past the final byte
	}
	return out.String()
}

func (r *logRing) clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = make([]string, len(r.lines))
	r.next = 0
	r.wrapped = false
}
