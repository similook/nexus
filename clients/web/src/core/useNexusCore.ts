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
  /** Tear the tunnel down and bring it up on a different server. See the implementation. */
  switchTo: (config: string, name?: string) => Promise<void>;
  readLogs: (limit?: number) => Promise<string[]>;
  /** Fixed-capacity downlink history for a sparkline. Never grows (R5). */
  history: readonly number[];
}

const HISTORY_CAPACITY = 60;

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
  }, []);

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
      try {
        await NexusCore.start({ config, name });
        // Do not optimistically set 'connected' — wait for the serviceState event. The
        // promise resolving means the service was asked to start, not that a tunnel exists.
      } catch (e) {
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
    if (transitionRef.current) return;
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
  }, []);

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
    async (config: string, name?: string) => {
      // disconnect() and connect() each guard on transitionRef and return early if one is in
      // flight, so they cannot be called back to back without waiting for the first to clear.
      await disconnect();
      await connect(config, name);
    },
    [connect, disconnect],
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
