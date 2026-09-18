/**
 * Post-connect promo slot.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE ENABLING IT
 *
 * An ad request from this app carries the user's REAL IP address, always, and there is no
 * configuration that changes that. NexusVpnService puts our own package on the VpnService
 * deny list (openTun: per-app DENY list), so app-process traffic never enters the tunnel.
 * That is what makes the slot work when the proxy is down — and it also means the ad host
 * learns that this IP runs a censorship-circumvention client, at the moment it connects.
 *
 * For users in a country that filters the internet, that association is the sensitive part,
 * not the ad. Whoever operates the endpoint can see it, and so can anyone who can see the
 * endpoint's logs or its traffic.
 *
 * Mitigations that are already in place:
 *   - One request per session at most, and rate-limited across sessions (see SHOW_INTERVAL_MS).
 *   - No identifiers are sent. No device id, no node name, no subscription, no query string.
 *   - `no-referrer` on the fetch and on the click-through, so the ad host is not told which
 *     screen it came from.
 *   - Disabled unless ENDPOINT is set, so a build that nobody configured ships inert.
 *
 * What is NOT mitigated, and cannot be from inside the app: the IP itself. If that matters
 * for the audience, the endpoint has to be one you control and do not log.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Where to fetch the promo from. EMPTY DISABLES THE WHOLE FEATURE.
 *
 * Expected response — a JSON object, nothing more:
 *
 *   { "id": "spring-promo", "imageUrl": "https://…/banner.png", "clickUrl": "https://…",
 *     "alt": "optional text for screen readers" }
 *
 * Serve it over https. Over http the banner and its destination can be rewritten in transit
 * by anyone on the path, which in this app's target networks is not hypothetical.
 */
const ENDPOINT = '';

/** At most one promo per hour, however often the user reconnects. */
const SHOW_INTERVAL_MS = 60 * 60 * 1000;

const LAST_SHOWN_KEY = 'nexus.ads.lastShownAt.v1';

/** Give up rather than hold the screen. The slot is optional; the tunnel is not. */
const TIMEOUT_MS = 4000;

export interface Promo {
  id: string;
  imageUrl: string;
  clickUrl: string;
  alt: string;
}

/**
 * Only http(s) survives.
 *
 * The endpoint's response reaches an `<img src>` and an `<a href>`, so an unchecked value is
 * script injection with extra steps: `javascript:…` in an href runs in the WebView, which here
 * has the Capacitor bridge on it. `data:` and `blob:` are refused for the same reason.
 */
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function lastShownAt(): number {
  try {
    const raw = localStorage.getItem(LAST_SHOWN_KEY);
    const value = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function markShown(): void {
  try {
    localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()));
  } catch {
    // Storage unavailable. The rate limit degrades to per-session, which is acceptable.
  }
}

/** True if enough time has passed since the last promo. */
export function isDue(): boolean {
  if (ENDPOINT.length === 0) return false;
  const since = Date.now() - lastShownAt();
  // A clock that moved backwards makes `since` negative; treat that as due rather than
  // locking the slot out until the clock catches up.
  return since < 0 || since >= SHOW_INTERVAL_MS;
}

/**
 * Fetch one promo. Returns null for every failure, silently.
 *
 * A promo that cannot load must never surface as an error: the user asked for a VPN, and an
 * ad server being unreachable is not something they did wrong or can act on.
 */
export async function fetchPromo(): Promise<Promo | null> {
  if (!isDue()) return null;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      signal: abort.signal,
      // No cookies, no referrer, no cache entry that outlives the session.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;

    const record = body as Record<string, unknown>;
    const imageUrl = safeUrl(record.imageUrl);
    const clickUrl = safeUrl(record.clickUrl);
    if (!imageUrl || !clickUrl) return null;

    return {
      id: typeof record.id === 'string' ? record.id : 'promo',
      imageUrl,
      clickUrl,
      alt: typeof record.alt === 'string' ? record.alt : 'Sponsored',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
