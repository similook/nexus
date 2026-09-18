/**
 * Formatters for the core's raw units.
 *
 * The plugin hands us bytes and bytes/sec; the mockup shows "MB/s" and "Total: 0 MB". Keeping
 * the conversion here rather than in the native layer means a units change is a view change.
 */

/**
 * Rate in MB/s to two decimals, matching #download-speed-val / #upload-speed-val.
 *
 * Decimal MB (10^6), not MiB — it is what every speed test and every competitor shows, so
 * matching the convention avoids "why is your number lower".
 */
export function formatSpeedMB(bytesPerSecond: number): string {
  return (bytesPerSecond / 1_000_000).toFixed(2);
}

/** Cumulative total with a unit, matching #download-total / #upload-total ("1.4 GB"). */
export function formatTotal(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** HH:MM:SS, matching #uptime-text. */
export function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}
