package nexuscore

import (
	"sync"
	"time"
)

// PowerState is the core's view of what the device is doing. It is deliberately coarser than
// the set of callbacks the platforms hand us — Android and iOS both emit lifecycle events in
// bursts, and reacting to each one individually is how you build a battery bug.
type PowerState int32

const (
	// PowerStateActive — user is present. Everything runs.
	PowerStateActive PowerState = iota

	// PowerStateIdle — screen off, device not yet in deep idle. Cheap suppression only:
	// pollers stop, streams stop, the tunnel is left completely alone.
	PowerStateIdle

	// PowerStateSuspended — device is in Doze / the extension is being told to sleep.
	// Now we hand off to libbox's Pause(), which does tear down connections.
	PowerStateSuspended
)

// idleGrace is how long the screen stays off before we believe it. Lock/unlock flapping is
// extremely common (notifications, pocket touches, always-on display) and each real
// transition costs us work, so we debounce the cheap transition too.
const idleGrace = 30 * time.Second

// pauser is the subset of libbox's lifecycle object that the power policy drives.
//
// Narrow on purpose, and matched on METHODS rather than on a type. That is what let this file
// survive 1.14 untouched: libbox.BoxService was deleted outright and the lifecycle moved onto
// CommandServer, and because nothing here names either type, the policy code did not care.
//
// Keep it minimal. Every method added here is another thing that can break on upgrade.
type pauser interface {
	Pause()
	Wake()
}

// networkResetter is OPTIONAL.
//
// ResetNetwork() was a BoxService method in 1.12. Whether it survived onto CommandServer in
// 1.14 is unconfirmed (scripts/dump-api.sh section 8 answers it). Treating it as optional means
// its absence degrades one feature — connections are not torn down on a network change, so they
// fail and retry instead — rather than failing the build.
//
// If dump-api.sh shows it present, fold it back into pauser and delete this. A silent no-op is
// acceptable as a stopgap, not as a resting state.
type networkResetter interface {
	ResetNetwork()
}

// PowerController implements ADR-0001 §5.2.
//
// The important decision encoded here: SCREEN-OFF IS NOT PAUSE.
//
// libbox's Pause() calls ResetNetwork() internally, tearing down every TCP
// connection (SagerNet/sing-box#3400). That is correct for "the device is going away for
// hours" and badly wrong for "the user glanced at a notification" — every wake then pays a
// full reconnect handshake, which promotes the radio, which is the exact cost we are trying
// to avoid. So we split the platform's one signal into two states and only pay for a
// teardown when the device is genuinely going idle.
//
// What screen-off actually buys us is the cheap half, and the cheap half is most of the win:
// stopping the pollers. A suspended health-check loop saves a TLS handshake per node per
// interval; a torn-down tunnel saves nothing and costs a reconnect.
type PowerController struct {
	mu      sync.Mutex
	service pauser

	state    PowerState
	screenOn bool

	// idleTimer fires the Active -> Idle transition after idleGrace. Held so a screen-on
	// inside the grace window cancels it rather than racing it.
	idleTimer *time.Timer

	// tasks are every periodic job in the process. They exist here, rather than each owning
	// its own ticker, so that (a) they can all be stopped in one place and (b) they share one
	// wakeup instead of N. See coalescer.
	tasks *coalescer

	onStateChange func(PowerState)
}

func newPowerController(service pauser, onStateChange func(PowerState)) *PowerController {
	return &PowerController{
		service:       service,
		state:         PowerStateActive,
		screenOn:      true,
		tasks:         newCoalescer(),
		onStateChange: onStateChange,
	}
}

// SetScreenOn is driven by ACTION_SCREEN_ON/OFF on Android. iOS has no equivalent inside the
// extension, so there it is driven from the app process over the command channel and may
// simply never arrive — the controller must behave correctly if only SetDeviceIdle is ever
// called.
func (p *PowerController) SetScreenOn(on bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.screenOn == on {
		return
	}
	p.screenOn = on

	if on {
		p.cancelIdleTimerLocked()
		p.transitionLocked(PowerStateActive)
		return
	}

	// Screen off: arm the grace timer rather than transitioning now.
	p.cancelIdleTimerLocked()
	p.idleTimer = time.AfterFunc(idleGrace, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if !p.screenOn && p.state == PowerStateActive {
			p.transitionLocked(PowerStateIdle)
		}
	})
}

// SetDeviceIdle is the real thing: Android Doze (PowerManager.isDeviceIdleMode) or the Apple
// extension being told it is going to sleep. No grace period — the platform has already
// waited far longer than we would.
func (p *PowerController) SetDeviceIdle(idle bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if idle {
		p.cancelIdleTimerLocked()
		p.transitionLocked(PowerStateSuspended)
		return
	}
	if p.screenOn {
		p.transitionLocked(PowerStateActive)
	} else {
		p.transitionLocked(PowerStateIdle)
	}
}

// NetworkChanged is the one case where tearing connections down is unambiguously right: the
// path they were bound to no longer exists. Independent of power state.
//
// No-op if the underlying object does not expose ResetNetwork — see networkResetter.
func (p *PowerController) NetworkChanged() {
	p.mu.Lock()
	service := p.service
	p.mu.Unlock()

	if service == nil {
		return
	}
	if r, ok := service.(networkResetter); ok {
		r.ResetNetwork()
	}
}

func (p *PowerController) State() PowerState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

func (p *PowerController) transitionLocked(next PowerState) {
	if p.state == next {
		return
	}
	prev := p.state
	p.state = next

	switch next {
	case PowerStateActive:
		p.tasks.Resume()
		if prev == PowerStateSuspended && p.service != nil {
			p.service.Wake()
		}

	case PowerStateIdle:
		// Cheap half only. Pollers off, memory returned, tunnel untouched.
		p.tasks.Suspend()
		releaseMemory()
		if prev == PowerStateSuspended && p.service != nil {
			// Came up out of deep idle but the screen is still off (e.g. a push arrived).
			p.service.Wake()
		}

	case PowerStateSuspended:
		p.tasks.Suspend()
		if p.service != nil {
			p.service.Pause()
		}
		releaseMemory()
	}

	if p.onStateChange != nil {
		// Outside the lock would be nicer, but callers here are the platform bridge and it
		// must not re-enter. Keep the callback trivial — it publishes a state int, nothing more.
		p.onStateChange(next)
	}
}

func (p *PowerController) cancelIdleTimerLocked() {
	if p.idleTimer != nil {
		p.idleTimer.Stop()
		p.idleTimer = nil
	}
}

func (p *PowerController) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cancelIdleTimerLocked()
	p.tasks.Close()
}

// --- wakeup coalescing ---------------------------------------------------------------

// coalescer runs every periodic task in the process off ONE ticker.
//
// This is ADR-0001 §5.2's "coalesce every periodic task onto one aligned wakeup — never N
// independent tickers". N tickers at unrelated phases means N radio promotions per period;
// one ticker means one. The tick is intentionally coarse: sub-second periodic work in a
// tunnel process is almost always a design mistake.
type coalescer struct {
	mu        sync.Mutex
	tasks     map[string]*coalescedTask
	ticker    *time.Ticker
	stop      chan struct{}
	suspended bool
	closed    bool
}

type coalescedTask struct {
	interval time.Duration
	elapsed  time.Duration
	run      func()
}

const coalescerTick = 5 * time.Second

func newCoalescer() *coalescer {
	c := &coalescer{
		tasks: make(map[string]*coalescedTask),
		stop:  make(chan struct{}),
	}
	c.startLocked()
	return c
}

// Add registers a periodic task. interval is rounded up to the tick granularity — callers do
// not get to ask for a private, precisely-phased wakeup, which is the whole point.
func (c *coalescer) Add(name string, interval time.Duration, run func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if interval < coalescerTick {
		interval = coalescerTick
	}
	c.tasks[name] = &coalescedTask{interval: interval, run: run}
}

func (c *coalescer) Remove(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.tasks, name)
}

// Suspend stops the ticker outright. Not "skip the work" — stopping the timer is what stops
// the wakeup, and the wakeup is the cost.
func (c *coalescer) Suspend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.suspended || c.closed {
		return
	}
	c.suspended = true
	c.stopLocked()
}

func (c *coalescer) Resume() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.suspended || c.closed {
		return
	}
	c.suspended = false
	// Reset phase so nothing fires immediately in a burst on wake.
	for _, t := range c.tasks {
		t.elapsed = 0
	}
	c.startLocked()
}

func (c *coalescer) startLocked() {
	if c.ticker != nil {
		return
	}
	c.ticker = time.NewTicker(coalescerTick)
	c.stop = make(chan struct{})
	go c.loop(c.ticker.C, c.stop)
}

func (c *coalescer) stopLocked() {
	if c.ticker == nil {
		return
	}
	c.ticker.Stop()
	close(c.stop)
	c.ticker = nil
}

func (c *coalescer) loop(tick <-chan time.Time, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case <-tick:
			c.mu.Lock()
			due := make([]func(), 0, len(c.tasks))
			for _, t := range c.tasks {
				t.elapsed += coalescerTick
				if t.elapsed >= t.interval {
					t.elapsed = 0
					due = append(due, t.run)
				}
			}
			c.mu.Unlock()

			for _, run := range due {
				run()
			}
		}
	}
}

func (c *coalescer) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	c.stopLocked()
	c.tasks = nil
}
