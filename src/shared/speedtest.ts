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
  /** Measured by the schedule, not by hand. */
  auto?: boolean
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

export interface SpeedSchedule {
  enabled: boolean
  every: 'daily' | '6h'
  /** Hour of the (first) run. */
  hour: number
}

export const DEFAULT_SCHEDULE: SpeedSchedule = { enabled: false, every: 'daily', hour: 4 }

/** Start of the latest planned run at or before `now` (local time); `minute` spreads servers over the hour. */
export function lastSlot(s: SpeedSchedule, now: number, minute: number): number {
  const d = new Date(now)
  const hours = s.every === '6h' ? [0, 6, 12, 18].map((h) => (s.hour + h) % 24) : [s.hour]
  let best = -Infinity
  for (const back of [0, 1])
    for (const h of hours) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, h, minute).getTime()
      if (t <= now && t > best) best = t
    }
  return best
}

/** Usual download: the mean of the internet results of the last 7 days (at least 3), else undefined. */
export function usualDown(history: SpeedResult[], now: number): number | undefined {
  const recent = history.filter((h) => h.kind === 'internet' && h.at >= now - 7 * 86_400_000 && h.at < now)
  if (recent.length < 3) return undefined
  return recent.reduce((a, h) => a + h.down, 0) / recent.length
}

/** Too slow for the notification rule? */
export function judgeSpeed(down: number, usual: number | undefined, rule: { speedMode: 'relative' | 'fixed'; speedPercent: number; speedMbit: number }): { slow: boolean; expected?: number } {
  if (rule.speedMode === 'fixed') return { slow: down < rule.speedMbit, expected: rule.speedMbit }
  if (usual === undefined) return { slow: false }
  const expected = (usual * rule.speedPercent) / 100
  return { slow: down < expected, expected }
}
