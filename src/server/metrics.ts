// Metric history: one sample per metric every 30 s in SQLite (kept 7 days),
// read back averaged into at most ~300 buckets per range.

import { and, asc, eq, gte, lt, sql } from 'drizzle-orm'
import { CRC_WINDOW_DAYS, type SmartBaseline } from '~/shared/smart'
import { HISTORY_RANGES, METRICS, type HistoryRange, type MetricHistory, type MetricName, type SystemMetrics } from '~/shared/types'
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

/** SMART trends are kept for a year (one sample per disk and hour). */
export const SMART_KEEP_MS = 365 * 24 * 3600_000

export function pruneHistory(d: DB, now = Date.now()) {
  const t = schema.metricSamples
  d.delete(t).where(and(lt(t.ts, now - KEEP_MS), sql`${t.metric} NOT LIKE 'smart:%'`)).run()
  d.delete(t).where(lt(t.ts, now - SMART_KEEP_MS)).run()
}

export const SMART_METRICS = ['temp', 'realloc', 'pending', 'uncorrectable', 'crc', 'wear', 'media'] as const
export type SmartMetric = (typeof SMART_METRICS)[number]

/** One disk's SMART trends ([ts, value] per metric), daily averages beyond 30 days. */
export function querySmartHistory(d: DB, diskId: string, days: number, now = Date.now()): Partial<Record<SmartMetric, [number, number][]>> {
  const t = schema.metricSamples
  const bucket = days > 30 ? 24 * 3600_000 : 3600_000
  const b = sql<number>`(${t.ts} / ${bucket}) * ${bucket}`
  const rows = d
    .select({ metric: t.metric, b, v: sql<number>`max(${t.value})` })
    .from(t)
    .where(and(gte(t.ts, now - days * 24 * 3600_000), sql`${t.metric} LIKE ${`smart:${diskId}:%`}`))
    .groupBy(t.metric, b)
    .orderBy(asc(b))
    .all()
  const out: Partial<Record<SmartMetric, [number, number][]>> = {}
  for (const r of rows) {
    const m = r.metric.slice(`smart:${diskId}:`.length) as SmartMetric
    if (SMART_METRICS.includes(m)) (out[m] ??= []).push([r.b + bucket / 2, r.v])
  }
  return out
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

/** Demo: the live values that continue the seeded curves (instead of the machine Quadeck runs on). */
export function demoSystemSample(now = Date.now()): SystemMetrics {
  const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60
  const day = Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI))
  const cpu = Math.min(1, 0.12 + 0.18 * day + Math.random() * 0.06)
  const memTotal = 32 * 1024 ** 3
  return {
    ts: now,
    cpu,
    load: [cpu * 8, cpu * 7, cpu * 6],
    memTotal,
    memUsed: Math.round(memTotal * (0.42 + 0.08 * day + Math.random() * 0.02)),
    temp: { celsius: Math.round(38 + cpu * 30 + Math.random() * 2), sensor: 'k10temp' },
    net: { rx: (0.6 + 4 * day) * 1e6 * (0.7 + Math.random() * 0.6), tx: (0.3 + 6 * day) * 1e6 * (0.7 + Math.random() * 0.6), iface: 'enp3s0', speedMbps: 2500 },
  }
}

/** Oldest CRC count of the last days per disk – what today's count is compared with. */
export function smartBaselines(d: DB, ids: string[], now = Date.now()): Record<string, SmartBaseline> {
  const t = schema.metricSamples
  const out: Record<string, SmartBaseline> = {}
  for (const id of ids) {
    const row = d
      .select({ ts: t.ts, v: t.value })
      .from(t)
      .where(and(eq(t.metric, `smart:${id}:crc`), gte(t.ts, now - CRC_WINDOW_DAYS * 24 * 3600_000)))
      .orderBy(asc(t.ts))
      .limit(1)
      .get()
    if (row) out[id] = { crc: { value: row.v, since: row.ts } }
  }
  return out
}

/** Demo: three months of SMART trends (fixtures only, once). */
export function seedSmartHistory(d: DB, disks: { id: string; samples: { key: string; value: number }[] }[], now = Date.now()) {
  const t = schema.metricSamples
  if (d.select({ n: sql<number>`count(*)` }).from(t).where(sql`${t.metric} LIKE 'smart:%'`).get()!.n > 0) return
  const rows: { ts: number; metric: string; value: number }[] = []
  const days = 90
  for (const disk of disks) {
    for (let h = days * 24; h > 0; h -= 3) {
      const ts = now - h * 3600_000
      const age = 1 - h / (days * 24) // 0 → 1 over the window
      const hour = new Date(ts).getHours()
      for (const s of disk.samples) {
        let v = s.value
        if (s.key === 'temp') v = s.value - 3 + 4 * Math.max(0, Math.sin(((hour - 8) / 24) * 2 * Math.PI)) + ((h * 7919) % 10) / 10
        // Counters grew over time to today's value (the interesting part of the demo).
        else if (s.value > 0) v = Math.floor(s.value * Math.min(1, Math.max(0, (age - 0.4) / 0.6)) ** 0.7)
        rows.push({ ts, metric: `smart:${disk.id}:${s.key}`, value: v })
      }
    }
  }
  d.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(t).values(rows.slice(i, i + 500)).run()
  })
}
