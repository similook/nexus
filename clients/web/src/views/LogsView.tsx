import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clipboard } from '@capacitor/clipboard';
import { useToast } from '../components/Toast';
import { NexusCore } from '../core/plugin';
import { useNexus } from '../core/NexusProvider';

/**
 * Terminal-style log view.
 *
 * LOGS ARE PULLED, NOT STREAMED (ipc-boundary.md R3). There is no polling timer in this file.
 * Lines are fetched when the view mounts and when the user asks for more; the core keeps a
 * bounded 512-line ring, so a fetch after some time away returns everything that accumulated
 * in between. That is what makes a pull model feel live without a wakeup per line.
 *
 * A live tail is a debug-build feature and is deliberately not offered here.
 */

type Level = 'info' | 'warn' | 'error' | 'debug';

interface LogLine {
  timestamp: string;
  level: Level;
  message: string;
  raw: string;
}

/** Core lines look like `10:14:02 [info] message`; anything else is shown verbatim. */
function parseLine(raw: string): LogLine {
  const match = /^(\d{2}:\d{2}:\d{2})\s+[[\]]?(\w+)[[\]]?\s+(.*)$/.exec(raw);
  if (!match) return { timestamp: '', level: 'info', message: raw, raw };

  // The native side emits sing-box's full level set (panic/fatal/error/warn/info/debug/trace).
  // Fold the ones we do not style separately rather than silently relabelling them 'info' —
  // a fatal shown in info-blue is worse than no colour at all.
  const raw_level = match[2].toLowerCase();
  const level: Level =
    raw_level === 'panic' || raw_level === 'fatal' || raw_level === 'error'
      ? 'error'
      : raw_level === 'warn' || raw_level === 'warning'
        ? 'warn'
        : raw_level === 'debug' || raw_level === 'trace'
          ? 'debug'
          : 'info';

  return { timestamp: match[1], level, message: match[3], raw };
}

const LEVEL_TONE: Record<Level, string> = {
  info: 'text-sky-400',
  warn: 'text-amber-400',
  error: 'text-rose-400',
  debug: 'text-slate-500',
};

export function LogsView() {
  const toast = useToast();
  const { connection } = useNexus();
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(
    async (announce = false) => {
      setLoading(true);
      try {
        const result = await NexusCore.readLogs({ limit: 500 });
        setLines(result.lines);
        if (announce) toast(`${result.lines.length} lines loaded`);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not read logs', '⚠');
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  // Open the core's log subscription for exactly as long as this screen is mounted, then
  // fetch. Navigating away unmounts the view, which closes the subscription and stops the
  // core producing log traffic at all — that is the whole point (ipc-boundary.md R3).
  useEffect(() => {
    void NexusCore.setLogStreaming({ enabled: true }).catch(() => {
      // Not fatal: the ring may still hold lines from an earlier session.
    });
    void fetchLogs();

    return () => {
      void NexusCore.setLogStreaming({ enabled: false }).catch(() => {});
    };
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const parsed = useMemo(() => lines.map(parseLine), [lines]);

  const copy = async () => {
    if (lines.length === 0) {
      toast('Nothing to copy', 'ℹ');
      return;
    }
    try {
      // @capacitor/clipboard, NOT navigator.clipboard.
      //
      // navigator.clipboard needs a secure context AND, on Android WebView, a user-activation
      // window that an await chain can outlive — so it fails intermittently on device in ways
      // that never reproduce in a desktop browser. The Capacitor plugin goes through Android's
      // ClipboardManager natively and has neither constraint. It works on web too, so there is
      // no platform branch here.
      await Clipboard.write({ string: lines.join('\n') });
      toast(`${lines.length} lines copied`);
    } catch {
      toast('Clipboard unavailable', '⚠');
    }
  };

  const clear = async () => {
    try {
      await NexusCore.clearLogs();
    } catch {
      // Non-fatal: clearing the view is still the useful half.
    }
    setLines([]);
    toast('Log view cleared');
  };

  return (
    <section id="view-logs" role="tabpanel" className="h-full flex flex-col px-5 pt-3 pb-2 overflow-hidden">
      <div className="shrink-0 flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            Connection Logs
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                connection === 'connected' ? 'bg-emerald-400' : 'bg-slate-600'
              }`}
            />
          </h2>
          <p className="text-xs text-brand-muted">Core proxy daemon output</p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton label="Refresh" onClick={() => void fetchLogs(true)} disabled={loading}
            path="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
            spinning={loading}
          />
          <IconButton label="Copy" onClick={() => void copy()}
            path="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5"
          />
          <IconButton label="Clear" onClick={() => void clear()} danger
            path="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
          />
        </div>
      </div>

      <div className="flex-1 bg-[#050911] border border-brand-border/90 rounded-2xl p-3.5 flex flex-col font-mono text-xs overflow-hidden shadow-inner">
        <div className="shrink-0 flex items-center justify-between pb-2 mb-2 border-b border-brand-border/40 text-[10px] text-slate-500">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
            <span className="ml-2 font-medium text-slate-400">sing-box // stdout</span>
          </div>
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className={`font-semibold transition-colors ${autoScroll ? 'text-brand-orange' : 'text-slate-600 hover:text-slate-400'}`}
          >
            AUTO-SCROLL
          </button>
        </div>

        <div ref={scrollRef} className="terminal-scroll flex-1 overflow-y-auto space-y-1.5 pr-1 leading-relaxed text-slate-300">
          {parsed.length === 0 ? (
            <p className="text-slate-600 py-4">
              {loading ? 'Reading log ring…' : 'No output. Start the tunnel to produce logs.'}
            </p>
          ) : (
            parsed.map((line, i) => (
              // Index keys are correct here: this is an append-only ring rendered in order,
              // never reordered or filtered, so an index is a stable identity.
              <div key={i} className="font-mono leading-relaxed break-words">
                {line.timestamp && <span className="text-slate-600 select-none">{line.timestamp} </span>}
                <span className={`font-semibold ${LEVEL_TONE[line.level]}`}>[{line.level}]</span>{' '}
                <span className="text-slate-300">{line.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function IconButton({
  label,
  path,
  onClick,
  danger = false,
  disabled = false,
  spinning = false,
}: {
  label: string;
  path: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  spinning?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`px-2.5 py-1.5 rounded-lg bg-brand-surface border text-[11px] font-semibold active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-50 ${
        danger
          ? 'border-brand-border hover:bg-rose-950/40 hover:border-rose-800/60 text-slate-300 hover:text-rose-400'
          : 'border-brand-border hover:bg-brand-surface-card text-slate-200 hover:text-brand-orange'
      }`}
    >
      <svg className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d={path} />
      </svg>
      {label}
    </button>
  );
}
