// Fill level of each mounted file system over time: one sample per hour as fs:<mount> (used bytes)
// in metric_samples, kept 400 days, and the 30-day trend that the disk cards and the
// "full in N days" notification use. statfs only reads the kernel's numbers: no disk access,
// sleeping disks stay asleep.

import { and, gte, sql } from 'drizzle-orm'
import { FS_BUCKET_MS, TREND_SPAN_MS, fsTrend, type FsTrend } from '~/shared/disk-usage'
import type { Disk } from '~/shared/types'
import type { DB } from './db'
import { schema } from './db'

export const fsMetric = (mount: string) => `fs:${mount}`

export class FsHistory {
  /** Mount → the hour already written. */
  private written = new Map<string, number>()

  constructor(private d: () => DB) {}

  /** Writes each file system once per hour. */
  record(disks: Pick<Disk, 'mount' | 'size' | 'used'>[], now = Date.now()) {
    const ts = Math.floor(now / FS_BUCKET_MS) * FS_BUCKET_MS
    const rows = disks.filter((x) => x.size > 0 && this.written.get(x.mount) !== ts).map((x) => ({ ts, metric: fsMetric(x.mount), value: x.used }))
    if (!rows.length) return
    this.d().insert(schema.metricSamples).values(rows).run()
    for (const r of rows) this.written.set(r.metric.slice(3), ts)
  }
}

/** The trend per mount from the last 30 days. */
export function fsTrends(d: DB, disks: Pick<Disk, 'mount' | 'size' | 'used'>[], now = Date.now()): Map<string, FsTrend> {
  const t = schema.metricSamples
  const rows = d
    .select()
    .from(t)
    .where(and(gte(t.ts, now - TREND_SPAN_MS), sql`${t.metric} LIKE 'fs:%'`))
    .all()
  const byMount = new Map<string, [number, number][]>()
  for (const r of rows) {
    const mount = r.metric.slice(3)
    const list = byMount.get(mount) ?? []
    list.push([r.ts, r.value])
    byMount.set(mount, list)
  }
  const out = new Map<string, FsTrend>()
  for (const x of disks) {
    const trend = fsTrend(byMount.get(x.mount) ?? [], x.size, now)
    if (trend) out.set(x.mount, trend)
  }
  return out
}

/**
 * Demo: 60 days of history so the cards show a trend. The data disks grow at different paces,
 * the system disk stays steady.
 */
export function seedFsHistory(d: DB, disks: Pick<Disk, 'mount' | 'size' | 'used'>[], now = Date.now()) {
  const t = schema.metricSamples
  if (d.select({ n: sql<number>`count(*)` }).from(t).where(sql`${t.metric} LIKE 'fs:%'`).get()!.n > 0) return
  const end = Math.floor(now / FS_BUCKET_MS) * FS_BUCKET_MS
  const rows: { ts: number; metric: string; value: number }[] = []
  for (const [i, x] of disks.entries()) {
    // bytes per day: steady for the system disk, otherwise 20–60 GB with a weekly rhythm
    const perDay = x.mount === '/' ? 0 : [20e9, 60e9, 35e9, 12e9][i % 4]!
    for (let ts = end - 60 * 86_400_000; ts <= end; ts += 3 * FS_BUCKET_MS) {
      const days = (end - ts) / 86_400_000
      const wiggle = Math.sin(ts / 86_400_000 / 7 * Math.PI * 2) * perDay * 1.5
      rows.push({ ts, metric: fsMetric(x.mount), value: Math.max(0, x.used - perDay * days + wiggle) })
    }
  }
  d.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(t).values(rows.slice(i, i + 500)).run()
  })
}
