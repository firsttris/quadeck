// How full a file system gets over time: one sample per hour (metric fs:<mount>), a straight line
// through the last 30 days, and when the disk is full at that pace. No I/O here.

export const FS_BUCKET_MS = 3600_000
export const FS_KEEP_MS = 400 * 86_400_000
export const TREND_SPAN_MS = 30 * 86_400_000
/** Less history than this: no forecast yet. */
const MIN_SPAN_MS = 2 * 86_400_000
/** Growth below this share of the size per day counts as "steady" (≈ 0.6 % a month). */
const STEADY_PER_DAY = 0.0002
/** Further away than this: no date worth showing. */
const MAX_DAYS = 3650

export interface FsTrend {
  /** Bytes per day (negative: shrinking). */
  perDay: number
  /** At this pace, full in this many days; absent when steady, shrinking or very far away. */
  fullInDays?: number
  steady: boolean
  /** Used share (0..1) per day over the last 30 days, oldest first (for a small line). */
  spark: number[]
}

/** Least squares through the samples of the last 30 days. */
export function fsTrend(points: [number, number][], size: number, now = Date.now()): FsTrend | undefined {
  const recent = points.filter(([t]) => t > now - TREND_SPAN_MS && t <= now).sort((a, b) => a[0] - b[0])
  if (recent.length < 3 || !size || recent.at(-1)![0] - recent[0]![0] < MIN_SPAN_MS) return undefined
  const n = recent.length
  const mx = recent.reduce((a, [t]) => a + t, 0) / n
  const my = recent.reduce((a, [, v]) => a + v, 0) / n
  let num = 0
  let den = 0
  for (const [t, v] of recent) {
    num += (t - mx) * (v - my)
    den += (t - mx) ** 2
  }
  const perDay = den ? (num / den) * 86_400_000 : 0
  const used = recent.at(-1)![1]
  const steady = Math.abs(perDay) < size * STEADY_PER_DAY
  const days = !steady && perDay > 0 ? Math.max(0, (size - used) / perDay) : undefined
  // one value per day: the last sample of that day
  const byDay = new Map<number, number>()
  for (const [t, v] of recent) byDay.set(Math.floor(t / 86_400_000), v / size)
  return { perDay, steady, ...(days !== undefined && days <= MAX_DAYS ? { fullInDays: Math.round(days) } : {}), spark: [...byDay.values()].slice(-30) }
}

/** "in about 3 weeks"-style buckets for the UI and notifications. */
export function fullInUnit(days: number): { n: number; unit: 'days' | 'weeks' | 'months' | 'years' } {
  if (days < 14) return { n: Math.max(1, Math.round(days)), unit: 'days' }
  if (days < 60) return { n: Math.round(days / 7), unit: 'weeks' }
  if (days < 730) return { n: Math.round(days / 30.4), unit: 'months' }
  return { n: Math.round(days / 365), unit: 'years' }
}

/** Growth per month in bytes (for "+120 GB a month"). */
export const perMonth = (t: FsTrend) => t.perDay * 30.4
