import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { coreEvents } from './coreEvents';
import {
  NexusCore,
  type ServiceState,
  type StatusMessage,
  type StatusSnapshot,
} from './plugin';

/**
 * The single React entry point to the core.
 *
 * THE ONE RULE: this hook contains no polling. Live values arrive on the 'status' listener,
 * which is throttled to 1 Hz inside the Go core and deduped in the native plugin. There is
 * exactly one setInterval in this file — the uptime clock — and it is gated on the app being
 * both connected and visible. If you find yourself adding a second timer, the value you want
 * almost certainly belongs on the status payload instead.
 *
 * See core/docs/ipc-boundary.md R1/R4 for why.
 */

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface NexusState {
  connection: ConnectionState;
  /** Populated on failure; cleared on the next successful connect attempt. */
  error: string | null;

  /**
   * False when the core is not producing traffic counters. The rate and total fields are then
   * meaningless rather than zero — see StatusMessage.trafficAvailable.
   */
  trafficAvailable: boolean;

  /** Bytes per second, from the most recent tick. */
  downlink: number;
  uplink: number;
  /** Cumulative bytes for this session. */
  downlinkTotal: number;
  uplinkTotal: number;

  connectionsOut: number;
  /** Go runtime figures — diagnostics screens only, not the home view. */
  memory: number;
  goroutines: number;

  /** Whole seconds since the tunnel came up; 0 when not connected. */
  uptimeSeconds: number;
}

export interface NexusApi extends NexusState {
  connect: (config: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Single toggle for a one-button UI. Ignores taps while a transition is in flight. */
  toggle: (config: string, name?: string) => Promise<void>;
  /**
   * Tear the tunnel down and bring it up on a different server. See the implementation.
   *
   * onCountdown fires once a second during the cool-down with the seconds remaining, so the
   * caller can show progress. It is optional: the switch is correct without it, just silent.
   */
  switchTo: (
    config: string,
    name?: string,
    onCountdown?: (secondsRemaining: number) => void,
  ) => Promise<void>;
  readLogs: (limit?: number) => Promise<string[]>;
  /** Fixed-capacity downlink history for a sparkline. Never grows (R5). */
  history: readonly number[];
}

const HISTORY_CAPACITY = 60;

/**
 * How long a start may take before the UI stops believing in it.
 *
 * A start that cannot complete used to leave the UI in 'connecting' forever - no error, no
 * timeout, and a button that did nothing - so the only way out was force-killing the app. The
 * core reports a failed handshake or an unresolvable server by simply not reaching 'started',
 * which from up here is indistinguishable from "still trying".
 *
 * 10s is chosen to sit above a slow-but-real connect: TLS to a distant server on a bad mobile
 * link, plus the DNS pre-resolution that happens before it, is comfortably inside that.
 */
const STARTUP_TIMEOUT_MS = 10_000;

/**
 * The gap between a full stop and the next start when switching servers.
 *
 * libbox always enables sing-box's cache file, and bbolt opens it with an exclusive flock and
 * a one-second timeout. Two service lifecycles overlapping on that file is what produced
 *
 *     start or reload service: initialize cache-file: timeout
 *
 * 4s is four times that timeout, which is the point: the wait is not tuned to the lock, it is
 * far enough clear of it that lock contention stops being a variable at all.
 */
const SWITCH_COOLDOWN_MS = 4_000;

/** How long to wait for a stop to be confirmed before starting the cool-down anyway. */
const STOP_SETTLE_TIMEOUT_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Is this 'stopped' the status STREAM being torn down, rather than the SERVICE stopping?
 *
 * The native plugin reports both through the same callback. NexusPlugin's StatusHandler does:
 *
 *     override fun disconnected(message: String?) {
 *         notifyListeners("serviceState", ...put("state", "stopped").put("reason", message))
 *     }
 *
 * and handleOnPause() deliberately calls disconnectClients() every time the WebView
 * backgrounds - that is the R1 policy, because a backgrounded WebView holding a 1 Hz
 * subscription is 86,400 wakeups a day to update a view nobody is looking at.
 *
 * So every ordinary background/resume cycle delivers a 'stopped' carrying gRPC's cancellation
 * of OUR OWN context:
 *
 *     status stream recv: rpc error: code = Canceled desc = context canceled
 *
 * which this hook then rendered as connection: 'error' - the ~1s red "Connection failed" flash
 * on resume, over a tunnel that never stopped.
 *
 * WHY MATCHING ON Canceled IS NARROW ENOUGH TO BE SAFE.
 *
 * gRPC's Canceled means the CALLER cancelled the context - it is the one status code that can
 * only be produced by our own side hanging up. A core that actually died, a socket that broke,
 * or a service that was stopped surfaces as Unavailable, Internal, DeadlineExceeded or a bare
 * EOF, none of which match here. Genuine failures keep their existing path and still show red.
 */
function isLifecycleStreamCancel(reason: string | undefined): boolean {
  if (!reason) return false;
  return /code = Canceled/i.test(reason) || /context canceled/i.test(reason);
}

/**
 * Ceiling for a believable tunnel uptime, used to reject a bad anchor.
 *
 * 30 days. A tunnel genuinely up that long is possible but far rarer than a timestamp we have
 * misread, so beyond this the right assumption is that the number is wrong. The failure this
 * catches renders as a count-up from 1970 - tens of millions of seconds on screen the instant
 * Connect is tapped.
 */
const MAX_PLAUSIBLE_UPTIME_MS = 30 * 24 * 60 * 60 * 1000;

const INITIAL: NexusState = {
  connection: 'disconnected',
  error: null,
  trafficAvailable: true,
  downlink: 0,
  uplink: 0,
  downlinkTotal: 0,
  uplinkTotal: 0,
  connectionsOut: 0,
  memory: 0,
  goroutines: 0,
  uptimeSeconds: 0,
};

export function useNexusCore(): NexusApi {
  const [state, setState] = useState<NexusState>(INITIAL);
  const [history, setHistory] = useState<number[]>([]);

  /**
   * Origin for the uptime clock, on the performance.now() timeline.
   *
   * performance.now() rather than Date.now(): a wall-clock change (NTP sync, timezone, the
   * user editing the clock) would otherwise make the uptime jump or go negative.
   *
   * The ORIGIN, however, must come from the core — see anchorToCore. Setting it to "now" the
   * moment the UI learns it is connected is only correct if the UI has been alive as long as
   * the tunnel, and it has not: background the app and come back and this ref is either reset
   * or belongs to a destroyed page, so the clock restarts from zero while the tunnel has been
   * up for an hour.
   */
  const connectedAtRef = useRef<number | null>(null);

  /**
   * Re-anchor the clock to the core's own start time.
   *
   * Translates the core's epoch-millisecond timestamp onto our performance.now() timeline, so
   * the origin is authoritative while the ticking stays immune to wall-clock jumps.
   */
  const anchorToCore = useCallback((coreStartedAt: number | undefined) => {
    // 0 or absent means the core has not reported yet - the status stream reconnects
    // asynchronously, so this is the normal state for the first moments after a resume.
    if (!coreStartedAt || coreStartedAt <= 0) return;

    // UNIT GUARD. The core sends epoch MILLISECONDS (daemon: startedAt.UnixMilli()). A
    // seconds-based timestamp for any date this century is ~1.7e9, a millisecond one ~1.7e12,
    // so the gap between them is four orders of magnitude and unambiguous. Without this, a
    // seconds value would be read as 1970 and the timer would show ~57 years of uptime -
    // which is exactly the "absurdly huge number" shape.
    const startedAtMs = coreStartedAt < 1e11 ? coreStartedAt * 1000 : coreStartedAt;

    const elapsedMs = Date.now() - startedAtMs;

    // Reject the implausible rather than rendering it. Negative means the device clock moved
    // backwards since the core started; beyond the ceiling means the timestamp is not what we
    // think it is. Either way the honest thing is to keep the previous anchor and wait for a
    // tick that makes sense - a wrong clock is worse than a clock that is briefly at 00:00.
    if (elapsedMs < 0 || elapsedMs > MAX_PLAUSIBLE_UPTIME_MS) return;

    connectedAtRef.current = performance.now() - elapsedMs;
  }, []);

  /** Guards against double-taps while a start/stop is in flight. */
  const transitionRef = useRef(false);

  /**
   * The current connection state, readable from a callback with no dependency on it.
   *
   * disconnect() must be able to tell a cancel from an ordinary stop, and it is a useCallback
   * with an empty dependency list so that its identity is stable across renders. Reading
   * state.connection there would mean adding it as a dependency and rebuilding the callback -
   * and every consumer with it - on every state change.
   */
  const connectionRef = useRef<NexusState['connection']>('disconnected');

  /** The startup watchdog. Armed by connect(), cleared the moment the core settles. */
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Set when the user cancels, so the switch cool-down knows to give up.
   *
   * Without it, cancelling during the 4s gap would stop nothing that is running and then start
   * the new tunnel anyway when the timer expired - a connect the user explicitly cancelled.
   */
  const switchAbortRef = useRef(false);

  /**
   * True while switchTo is between its stop and its start.
   *
   * The 'stopped' event that arrives mid-switch is ours, not the user's, and rendering it as
   * "disconnected" would flash the idle UI in the middle of an operation the user asked for.
   * applyServiceState reads this to keep showing 'connecting' across the gap.
   */
  const switchingRef = useRef(false);

  /**
   * Set when a 'stopped' event actually arrives.
   *
   * switchTo has to wait for the teardown to be CONFIRMED, and the rendered connection state
   * cannot tell it that: the switch sets 'connecting' before stopping, and applyServiceState
   * deliberately keeps showing 'connecting' when a stop lands mid-switch. Both are right for
   * the UI and useless as a signal, so the event is recorded separately from how it is drawn.
   */
  const stopConfirmedRef = useRef(false);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current === null) return;
    clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  // Mirror the connection state into a ref for the callbacks above.
  useEffect(() => {
    connectionRef.current = state.connection;
  }, [state.connection]);

  // Nothing should outlive the hook. A watchdog that fires after unmount would call stop() on
  // a tunnel the next mount is about to adopt.
  useEffect(() => () => clearWatchdog(), [clearWatchdog]);

  const applyStatus = useCallback((status: Partial<StatusMessage>) => {
    // Re-anchor on every tick. Idempotent, and it is what makes the clock survive a resume:
    // the stream carries the core's start time, so the UI does not depend on getStatus()
    // winning a race against the command client reconnecting.
    anchorToCore(status.coreStartedAt);

    setState((prev) => ({
      ...prev,
      trafficAvailable: status.trafficAvailable ?? prev.trafficAvailable,
      downlink: status.downlink ?? prev.downlink,
      uplink: status.uplink ?? prev.uplink,
      downlinkTotal: status.downlinkTotal ?? prev.downlinkTotal,
      uplinkTotal: status.uplinkTotal ?? prev.uplinkTotal,
      connectionsOut: status.connectionsOut ?? prev.connectionsOut,
      memory: status.memory ?? prev.memory,
      goroutines: status.goroutines ?? prev.goroutines,
    }));

    if (typeof status.downlink === 'number') {
      const value = status.downlink;
      // Fixed-capacity ring. A WebView that accumulates an hour of per-second samples is a
      // memory leak with a chart on top.
      setHistory((prev) =>
        prev.length < HISTORY_CAPACITY
          ? [...prev, value]
          : [...prev.slice(prev.length - HISTORY_CAPACITY + 1), value],
      );
    }
  }, [anchorToCore]);

  const applyServiceState = useCallback((serviceState: ServiceState, reason?: string) => {
    // A cancelled status stream is not a stopped tunnel. Downgrade it to 'unknown', which is
    // the state the contract already has for "cannot confirm either way": the switch below
    // returns prev unchanged for it, so the connection state, the uptime anchor and the
    // traffic history all survive the background/resume cycle untouched.
    //
    // Normalised here, at the entry point, rather than inside the 'stopped' branch - the code
    // after the switch also keys off 'stopped' to wipe the sparkline history and to set
    // stopConfirmedRef, and neither of those should fire for a stream that we ourselves closed.
    if (serviceState === 'stopped' && isLifecycleStreamCancel(reason)) {
      serviceState = 'unknown';
      reason = undefined;
    }

    setState((prev) => {
      switch (serviceState) {
        case 'started':
          if (connectedAtRef.current === null) connectedAtRef.current = performance.now();
          return { ...prev, connection: 'connected', error: null };

        case 'starting':
          return { ...prev, connection: 'connecting', error: null };

        // Hold everything. Not a state of its own in the UI: the previous connection state,
        // the uptime anchor and the traffic history all stay exactly as they were until the
        // stream reattaches and tells us something definite.
        case 'unknown':
          return prev;

        case 'stopped':
          connectedAtRef.current = null;

          // A stop that arrives mid-switch is the first half of an operation still in
          // progress. Reporting it as 'disconnected' would flash the idle screen - and worse,
          // would let a stale reconcile decide the user is not connecting.
          if (switchingRef.current) {
            return { ...INITIAL, connection: 'connecting', error: null };
          }

          return {
            ...INITIAL,
            // A reason on an unrequested stop means the core died or consent was revoked —
            // surface it. A clean user-initiated stop carries none.
            connection: reason ? 'error' : 'disconnected',
            error: reason || null,
          };
      }
    });

    // Only a CONFIRMED stop clears the chart. 'unknown' must not, or a resume would wipe the
    // history it is about to resume displaying.
    if (serviceState === 'stopped') setHistory([]);

    // Record the teardown for switchTo, regardless of what the UI was told to render.
    if (serviceState === 'stopped') stopConfirmedRef.current = true;

    // The core has settled either way, so the watchdog has nothing left to catch.
    if (serviceState === 'started' || serviceState === 'stopped') clearWatchdog();
  }, [clearWatchdog]);

  const reconcile = useCallback(async () => {
    try {
      const snapshot: StatusSnapshot = await NexusCore.getStatus();
      // A connect or disconnect that began while this call was in flight owns the state now.
      // The snapshot describes the world BEFORE that transition, so applying it rolls the UI
      // backwards: tapping Connect on a cold start would flash back to "Connect" as the
      // mount-time reconcile lands, which reads as the button having rejected the tap.
      if (transitionRef.current) return;
      applyServiceState(snapshot.state);
      applyStatus(snapshot);
      // AFTER applyServiceState: 'started' seeds the ref with "now" when it is null, and this
      // corrects it to the core's real start time. Resume runs reconcile, which is what makes
      // the clock survive backgrounding.
      anchorToCore(snapshot.coreStartedAt);
    } catch {
      // The core not being reachable is the normal "not running" case, not an error worth
      // showing. A real failure will surface on the next connect attempt.
      if (transitionRef.current) return;
      applyServiceState('stopped');
    }
  }, [anchorToCore, applyServiceState, applyStatus]);

  // --- subscriptions -------------------------------------------------------------------

  useEffect(() => {
    // Synchronous subscribe/unsubscribe via coreEvents — see that file for why we do not talk
    // to NexusCore.addListener directly. Short version: Capacitor's removeListener splices on
    // an unguarded indexOf, so an async removal that misses deletes a live listener instead of
    // doing nothing, and StrictMode plus Fast Refresh reliably trigger it.
    const offStatus = coreEvents.subscribe('status', applyStatus);
    const offServiceState = coreEvents.subscribe('serviceState', (e) =>
      applyServiceState(e.state, e.reason),
    );

    // Initial state, before the first tick arrives.
    void reconcile();

    return () => {
      offStatus();
      offServiceState();
    };
  }, [applyStatus, applyServiceState, reconcile]);

  // --- resume reconciliation -----------------------------------------------------------

  useEffect(() => {
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;

    void App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      // The native layer disconnected the status stream while we were backgrounded (R1), so
      // everything on screen is stale by however long the app was away — possibly hours.
      // One call on resume, not a poll.
      void reconcile();
    }).then((h) => {
      if (cancelled) {
        void h.remove();
        return;
      }
      handle = h;
    });

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [reconcile]);

  // --- uptime clock --------------------------------------------------------------------

  useEffect(() => {
    if (state.connection !== 'connected') return;

    // The one permitted timer.
    //
    // It is allowed because it only runs while the tunnel is up AND the WebView is visible —
    // the screen is on and the compositor is already ticking, so this adds no wakeup that was
    // not already happening. It cannot be driven off the status event instead: those are
    // deduped, so an idle tunnel would freeze the clock.
    let frame: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      const startedAt = connectedAtRef.current;
      if (startedAt === null) return;

      const elapsedMs = performance.now() - startedAt;

      // Second guard, independent of anchorToCore. That one validates the anchor as it is
      // set; this validates what is about to be rendered, so a bad anchor arriving by any
      // other route still cannot put a wrong number on screen. Clamp to 0 and wait: the next
      // status tick re-anchors, so this self-heals rather than sticking.
      const seconds =
        elapsedMs < 0 || elapsedMs > MAX_PLAUSIBLE_UPTIME_MS ? 0 : Math.floor(elapsedMs / 1000);

      setState((prev) => (prev.uptimeSeconds === seconds ? prev : { ...prev, uptimeSeconds: seconds }));
    };

    const start = () => {
      if (frame === null) {
        tick();
        frame = setInterval(tick, 1000);
      }
    };
    const stop = () => {
      if (frame !== null) {
        clearInterval(frame);
        frame = null;
      }
    };

    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state.connection]);

  // --- actions -------------------------------------------------------------------------

  const connect = useCallback(
    async (config: string, name?: string) => {
      if (transitionRef.current) return;
      transitionRef.current = true;

      setState((prev) => ({ ...prev, connection: 'connecting', error: null }));

      // ARM THE WATCHDOG BEFORE THE CALL, NOT AFTER.
      //
      // start() resolving means the service accepted the request, not that a tunnel exists -
      // the tunnel is confirmed by a later 'started' event, and the failure this catches is
      // precisely the one where that event never comes. Arming afterwards would leave the gap
      // uncovered for however long start() itself takes.
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        switchingRef.current = false;
        connectedAtRef.current = null;
        // Stop whatever half-started, so the core is not left running behind a UI that has
        // given up on it. Failures here are expected - there may be nothing to stop.
        void Promise.resolve(NexusCore.stop()).catch(() => {});
        setState((prev) =>
          prev.connection === 'connecting'
            ? {
                ...INITIAL,
                connection: 'error',
                error: 'Connection timed out after 10s. The server did not respond — try another node.',
              }
            : prev,
        );
      }, STARTUP_TIMEOUT_MS);

      try {
        await NexusCore.start({ config, name });
        // Do not optimistically set 'connected' — wait for the serviceState event. The
        // promise resolving means the service was asked to start, not that a tunnel exists.
      } catch (e) {
        clearWatchdog();
        switchingRef.current = false;
        const message = e instanceof Error ? e.message : String(e);
        const denied = /permission denied/i.test(message);
        connectedAtRef.current = null;
        setState((prev) => ({
          ...prev,
          // A declined consent dialog is a normal outcome, not a failure to display in red.
          connection: denied ? 'disconnected' : 'error',
          error: denied ? null : message,
        }));
      } finally {
        transitionRef.current = false;
      }
    },
    [],
  );

  const disconnect = useCallback(async () => {
    // A CANCEL MUST NEVER BE SWALLOWED.
    //
    // transitionRef is held for the whole of connect()'s start() call, and this used to open
    // with a bare `if (transitionRef.current) return;`. That made disconnect a no-op during
    // exactly the window where the user most wants it: while a start is in flight. toggle()
    // already routed 'connecting' here, so the intent was right and the guard ate it - the
    // button looked dead and force-killing the app was the only way out.
    //
    // The guard still does its real job, which is rejecting double-taps on a settled state.
    const cancelling = connectionRef.current === 'connecting';
    if (transitionRef.current && !cancelling) return;

    // Abort anything the switch cool-down is waiting on, and stop the watchdog from firing a
    // second stop underneath this one.
    switchAbortRef.current = true;
    switchingRef.current = false;
    clearWatchdog();

    transitionRef.current = true;
    try {
      await NexusCore.stop();
      connectedAtRef.current = null;
      setState({ ...INITIAL });
      setHistory([]);
    } catch (e) {
      setState((prev) => ({
        ...prev,
        connection: 'error',
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      transitionRef.current = false;
    }
  }, [clearWatchdog]);

  /**
   * Move a live tunnel to a different server.
   *
   * STOP FULLY, THEN START. Not a hot reload.
   *
   * The core supports reload() and it is genuinely cheaper - it keeps the process, the command
   * socket and the status stream alive across a config swap. That is why this used to call it.
   * On device it stalled: the tunnel would hang or half-die on a switch.
   *
   * The reason is that a reload is not one operation from up here. It is a config swap in the
   * :core process racing three things in this one - the status stream reattaching, the uptime
   * anchor, and the probe - none of which are told that the thing they are attached to just
   * changed underneath them. A stop/start has no such race: every one of those is torn down
   * and rebuilt in a known order, because that is the path the app takes on every ordinary
   * connect.
   *
   * The cost is a visible reconnect instead of a seamless swap. That is the right trade for a
   * VPN: a two-second gap the user can see beats a tunnel that is quietly in a state nobody
   * modelled.
   */
  const switchTo = useCallback(
    async (
      config: string,
      name?: string,
      onCountdown?: (secondsRemaining: number) => void,
    ) => {
      // STOP FULLY, WAIT, THEN START.
      //
      // This has now been all three shapes, and the history is the argument for the current
      // one:
      //
      //   stop -> start          raced. libbox always enables sing-box's cache file, bbolt
      //                          opens it with an exclusive flock and a one-second timeout,
      //                          and two overlapping lifecycles produced
      //                              start or reload service: initialize cache-file: timeout
      //                          with the outgoing tun still open - the UI said disconnected
      //                          while the system VPN key stayed lit.
      //
      //   start (atomic swap)    moved the race into NexusVpnService rather than removing it.
      //                          The executor serialises the swap, but the close and the open
      //                          still touch the same locked file inside one operation, so a
      //                          slow close still deadlocks the start behind it.
      //
      //   stop -> WAIT -> start  what this does. The ordering that failed the first time,
      //                          made safe by the thing it was missing: a gap long enough
      //                          that the lock is provably gone before anything asks for it.
      //
      // The cost is a visible reconnect the user can see. For a VPN that is the right trade -
      // a four-second gap that is explained beats a tunnel that is quietly wedged.
      switchAbortRef.current = false;
      switchingRef.current = true;
      stopConfirmedRef.current = false;

      // Own the state immediately. Without this the UI keeps rendering 'connected' through
      // the stop, and the user taps the new server again thinking the first tap missed.
      setState((prev) => ({ ...prev, connection: 'connecting', error: null }));

      try {
        await NexusCore.stop();
      } catch {
        // A stop that reports failure is still worth continuing from - the core may already
        // be gone. The wait below is what makes that safe either way.
      }

      // Wait for the stop to be CONFIRMED, not just requested.
      //
      // stop() resolves when the service has accepted the request; the tunnel is actually
      // down when the 'stopped' event lands. Starting the cool-down from the request would
      // spend the gap on a teardown that had not begun.
      const settleDeadline = Date.now() + STOP_SETTLE_TIMEOUT_MS;
      while (!stopConfirmedRef.current && Date.now() < settleDeadline) {
        if (switchAbortRef.current) { switchingRef.current = false; return; }
        await sleep(100);
      }

      // The cool-down, counted down out loud.
      const totalSeconds = Math.ceil(SWITCH_COOLDOWN_MS / 1000);
      for (let remaining = totalSeconds; remaining > 0; remaining--) {
        if (switchAbortRef.current) { switchingRef.current = false; return; }
        onCountdown?.(remaining);
        await sleep(1000);
      }

      if (switchAbortRef.current) { switchingRef.current = false; return; }

      // Hand over to the ordinary connect path, which owns the watchdog and the error
      // handling. A switch that fails past this point fails exactly like a normal connect.
      switchingRef.current = false;
      await connect(config, name);
    },
    [connect],
  );

  const toggle = useCallback(
    async (config: string, name?: string) => {
      if (state.connection === 'connected' || state.connection === 'connecting') {
        await disconnect();
      } else {
        await connect(config, name);
      }
    },
    [state.connection, connect, disconnect],
  );

  const readLogs = useCallback(async (limit = 200) => {
    const { lines } = await NexusCore.readLogs({ limit });
    return lines;
  }, []);

  return { ...state, connect, disconnect, toggle, switchTo, readLogs, history };
}
