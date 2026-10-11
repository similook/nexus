import { useState } from 'react';
import { useNexus } from '../core/NexusProvider';
import { isRoutingMode, ROUTING_MODE_HELP, ROUTING_MODES, type RoutingMode } from '../core/routing';
import { useRouting, type RoutingApi } from '../core/useRouting';

/**
 * Routing: VPN or Direct. Desktop only — HomeView renders this only for a port that sets
 * `routing` (see core/routing.ts).
 *
 * The row never states a mode the tunnel has not confirmed: connected, it shows what the
 * daemon reports (or that a switch is in flight); disconnected, it shows the stored choice and
 * says it applies on connect.
 */
export function RoutingCard() {
  const routing = useRouting();
  const { connection } = useNexus();
  const connected = connection === 'connected';
  const [open, setOpen] = useState(false);

  const { mode, active, pending } = routing;
  let label: string;
  let shown: RoutingMode | null = null;
  if (!connected) {
    label = mode;
    shown = mode;
  } else if (pending !== null) {
    label = `Switching to ${pending}…`;
  } else if (active !== null && isRoutingMode(active)) {
    label = active;
    shown = active;
  } else if (active !== null) {
    // A tunnel started by an older build reports a mode this one does not offer.
    label = 'Reconnect to apply';
  } else {
    label = 'Checking…';
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="shrink-0 w-full text-left px-3 py-2 rounded-2xl bg-brand-surface border border-brand-border mb-4 hover:border-brand-orange/60 transition-colors"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold text-brand-muted uppercase tracking-wider shrink-0">
            Routing
          </span>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] font-medium text-white truncate">{label}</span>
            {!connected && <span className="text-[10px] font-mono text-brand-muted shrink-0">on connect</span>}
            <span className="text-[10px] text-brand-muted shrink-0" aria-hidden="true">
              ▾
            </span>
          </span>
        </span>
        {shown !== null && (
          <span className="block mt-0.5 text-[10px] text-brand-muted truncate">{ROUTING_MODE_HELP[shown]}</span>
        )}
      </button>

      {open && <RoutingSheet routing={routing} connected={connected} onClose={() => setOpen(false)} />}
    </>
  );
}

function RoutingSheet({
  routing,
  connected,
  onClose,
}: {
  routing: RoutingApi;
  connected: boolean;
  onClose: () => void;
}) {
  const { mode, active, pending, error } = routing;
  const isCurrent = (option: RoutingMode): boolean =>
    connected ? active?.toLowerCase() === option.toLowerCase() : mode === option;

  return (
    <div
      className="absolute inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Routing"
      onClick={onClose}
    >
      <div
        className="w-full rounded-t-3xl bg-brand-surface border-t border-x border-brand-border p-5 pb-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-white tracking-tight">Routing</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-lg bg-brand-navy border border-brand-border text-brand-muted hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2" role="radiogroup" aria-label="Routing">
          {ROUTING_MODES.map((option) => {
            const current = isCurrent(option);
            return (
              <button
                key={option}
                role="radio"
                aria-checked={current}
                disabled={pending !== null}
                onClick={() => void routing.select(option)}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-colors disabled:cursor-not-allowed ${
                  current
                    ? 'bg-brand-navy border-brand-orange'
                    : 'bg-brand-navy border-brand-border hover:border-brand-orange/60 disabled:opacity-50'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold text-white">{option}</span>
                  {pending === option ? (
                    <span className="text-[10px] font-semibold text-brand-orange">Switching…</span>
                  ) : current ? (
                    <span className="text-[10px] font-semibold text-emerald-400">{connected ? 'Active' : 'Selected'}</span>
                  ) : null}
                </span>
                <span className="block text-[11px] text-brand-muted">{ROUTING_MODE_HELP[option]}</span>
              </button>
            );
          })}
        </div>

        <div className="space-y-1 text-[10px] leading-relaxed text-brand-muted">
          <p>Devices on your local network are always reached directly.</p>
          <p>
            {connected
              ? 'Switching keeps the VPN connected and restarts open connections.'
              : 'Your choice applies the next time you connect.'}
          </p>
        </div>

        {error !== null && (
          <p role="alert" className="text-[11px] text-rose-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
