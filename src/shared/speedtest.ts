// Speed test: what the page shows and stores.

export interface SpeedResult {
  at: number
  /** client: this device ↔ the server; internet: the server ↔ the internet. */
  kind: 'client' | 'internet'
  /** Mbit/s */
  down: number
  up: number
  /** ms */
  ping: number
  jitter: number
  /** internet: Cloudflare location (e.g. FRA); client: the browser. */
  where?: string
}

export const SPEED_HISTORY = 50

/** Median and mean difference between successive values (jitter), in ms. */
export function pingStats(times: number[]): { ping: number; jitter: number } {
  if (!times.length) return { ping: 0, jitter: 0 }
  const sorted = [...times].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const ping = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  const diffs = times.slice(1).map((t, i) => Math.abs(t - times[i]!))
  const jitter = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0
  return { ping: Math.round(ping * 10) / 10, jitter: Math.round(jitter * 10) / 10 }
}

export const mbps = (bytes: number, ms: number) => (ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10 : 0)
