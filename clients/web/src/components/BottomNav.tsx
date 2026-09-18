export type Tab = 'home' | 'servers' | 'logs';

const TABS: ReadonlyArray<{ id: Tab; label: string; path: string }> = [
  {
    id: 'home',
    label: 'Home',
    path: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  },
  {
    id: 'servers',
    label: 'Servers',
    path: 'M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.75 5.1a3 3 0 012.4-1.35h7.7a3 3 0 012.4 1.35l2.1 3.15a4.5 4.5 0 01.9 2.7m-16.5 0h16.5',
  },
  {
    id: 'logs',
    label: 'Logs',
    path: 'M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z',
  },
];

export function BottomNav({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (tab: Tab) => void;
}) {
  return (
    <nav
      role="tablist"
      aria-label="Main"
      className="shrink-0 grow-0 basis-auto bg-brand-surface/95 backdrop-blur-md border-t border-brand-border/80 px-6 flex items-center justify-around z-30"
      // env() in a style attribute rather than a Tailwind class: the safe-area inset has to be
      // added to the height, and there is no arbitrary-value syntax that expresses calc() with
      // an env() fallback cleanly. Straight from the mockup.
      style={{
        paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
        height: 'calc(4.25rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected}
            aria-controls={`view-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`flex flex-col items-center justify-center gap-1 w-16 py-1 transition-colors ${
              selected ? 'text-brand-orange' : 'text-brand-muted hover:text-slate-200'
            }`}
          >
            <div className="relative">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d={tab.path} />
              </svg>
              {selected && (
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-brand-orange" />
              )}
            </div>
            <span className={`text-[11px] tracking-tight ${selected ? 'font-bold' : 'font-medium'}`}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
