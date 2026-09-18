import { createContext, useContext, type ReactNode } from 'react';
import { useNexusCore, type NexusApi } from './useNexusCore';

/**
 * Holds the single core connection for the app's lifetime.
 *
 * WHY THIS EXISTS, and it is not a style preference:
 *
 * useNexusCore opens the status subscription in a useEffect. If it were called inside
 * HomeView, every tab switch would unmount it — tearing down the listener, then re-adding it
 * and firing a reconciliation getStatus() on the way back. Three taps around the nav bar would
 * be six subscription churns and three extra bridge round-trips, all to display the same
 * numbers that were already arriving.
 *
 * Worse, uptime and totals would reset on every visit, because they live in that hook's state.
 *
 * Mounted once at the App root, the subscription's lifetime matches the app's, which is what
 * the native layer already assumes: NexusPlugin connects its CommandClient on handleOnResume
 * and disconnects on handleOnPause, keyed to the WebView being visible — not to which React
 * component happens to be mounted.
 */
const NexusContext = createContext<NexusApi | null>(null);

export function NexusProvider({ children }: { children: ReactNode }) {
  const api = useNexusCore();
  return <NexusContext.Provider value={api}>{children}</NexusContext.Provider>;
}

export function useNexus(): NexusApi {
  const api = useContext(NexusContext);
  if (!api) throw new Error('useNexus must be used inside <NexusProvider>');
  return api;
}
