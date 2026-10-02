// Metric history: one sample per metric every 30 s in SQLite (kept 7 days),
// read back averaged into at most ~300 buckets per range.

import { and, asc, gte, lt, sql } from 'drizzle-orm'
import { HISTORY_RANGES, METRICS, type HistoryRange, type MetricHistory, type MetricName } from '~/shared/types'
export { metricRows } from '~/shared/metrics'
import type { DB } from './db'
import { schema } from './db'

export const SAMPLE_EVERY_MS = 30_000
export const KEEP_MS = HISTORY_RANGES['7d']
const BUCKETS = 300

export function parseRange(v: string | null): HistoryRange {
  return v && v in HISTORY_RANGES ? (v as HistoryRange) : '1h'
}

export function queryHistory(d: DB, range: HistoryRange, now = Date.now()): MetricHistory {
  const span = HISTORY_RANGES[range]
  // Never finer than the sample interval.
  const bucket = Math.max(SAMPLE_EVERY_MS, Math.ceil(span / BUCKETS / 1000) * 1000)
  const t = schema.metricSamples
  const b = sql<number>`(${t.ts} / ${bucket}) * ${bucket}`
  const rows = d
    .select({ metric: t.metric, b, v: sql<number>`avg(${t.value})` })
    .from(t)
    .where(gte(t.ts, now - span))
    .groupBy(t.metric, b)
    .orderBy(asc(b))
    .all()
  const out: MetricHistory = {}
  for (const r of rows) {
    if (!(METRICS as readonly string[]).includes(r.metric)) continue
    ;(out[r.metric as MetricName] ??= []).push([r.b + bucket / 2, r.v])
  }
  return out
}

export function pruneHistory(d: DB, now = Date.now()) {
  d.delete(schema.metricSamples).where(lt(schema.metricSamples.ts, now - KEEP_MS)).run()
}

/** Demo data: a week of plausible curves (fixtures only, when the table is empty). */
export function seedFixtureHistory(d: DB, now = Date.now()) {
  const t = schema.metricSamples
  if (d.select({ n: sql<number>`count(*)` }).from(t).where(and(gte(t.ts, now - KEEP_MS))).get()!.n > 0) return
  const rows: { ts: number; metric: string; value: number }[] = []
  const step = 2 * 60_000
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let ts = now - KEEP_MS; ts < now; ts += step) {
    const hour = new Date(ts).getHours() + new Date(ts).getMinutes() / 60
    const day = Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI)) // busy in the evening
    const backup = hour >= 3 && hour < 3.5 ? 0.45 : 0 // nightly backup
    const transcode = hour >= 19 && hour < 22 && rnd() > 0.3 ? 0.5 : 0
    const cpu = Math.min(1, 0.06 + 0.18 * day + backup + transcode * 0.4 + rnd() * 0.06)
    rows.push(
      { ts, metric: 'cpu', value: cpu },
      { ts, metric: 'ram', value: 0.42 + 0.08 * day + rnd() * 0.02 },
      { ts, metric: 'temp', value: 38 + cpu * 30 + rnd() * 2 },
      { ts, metric: 'net_rx', value: (0.2 + 4 * day + (backup ? 40 : 0)) * 1e6 * (0.7 + rnd() * 0.6) },
      { ts, metric: 'net_tx', value: (0.1 + 6 * day * (transcode ? 3 : 1)) * 1e6 * (0.7 + rnd() * 0.6) },
      { ts, metric: 'gpu_util', value: Math.min(1, 0.03 + transcode * 1.4 * (0.6 + rnd() * 0.4)) },
      { ts, metric: 'gpu_mem', value: 0.08 + transcode * 0.3 },
      { ts, metric: 'gpu_temp', value: 41 + transcode * 30 + rnd() * 2 },
    )
  }
  d.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(t).values(rows.slice(i, i + 500)).run()
  })
}
