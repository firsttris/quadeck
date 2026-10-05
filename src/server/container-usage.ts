// CPU and RAM per container over days: the 5 s samples of the Podman collector, averaged into
// 5-minute buckets (plus the peak) in metric_samples as ct:<container>:cpu|cpumax|mem|memmax,
// kept 30 days. Keyed by container name, which a Quadlet keeps across re-creation.

import { and, gte, lt, sql } from 'drizzle-orm'
import { USAGE_RANGES, type ContainerUsage, type UsageRange } from '~/shared/container-usage'
import type { Container } from '~/shared/types'
import type { DB } from './db'
import { metricPrefix, schema } from './db'

export const USAGE_BUCKET_MS = 5 * 60_000
export const USAGE_KEEP_MS = 30 * 86_400_000
const POINTS = 120
const KINDS = ['cpu', 'cpumax', 'mem', 'memmax'] as const
type Kind = (typeof KINDS)[number]

interface Acc {
  cpu: number
  cpuMax: number
  mem: number
  memMax: number
  n: number
}

export class UsageRecorder {
  private ts?: number
  private acc = new Map<string, Acc>()
  /** Container name → systemd unit, from the latest sample. */
  readonly units = new Map<string, string>()

  constructor(private d: () => DB) {}

  /** Adds one sample of the running containers; writes the bucket when a new one starts. */
  record(containers: Pick<Container, 'name' | 'state' | 'cpu' | 'memUsage' | 'unit'>[], now = Date.now()) {
    const ts = Math.floor(now / USAGE_BUCKET_MS) * USAGE_BUCKET_MS
    if (this.ts !== undefined && ts !== this.ts) this.flush()
    this.ts = ts
    for (const c of containers) {
      if (c.unit) this.units.set(c.name, c.unit)
      if (c.state !== 'running' || (c.cpu === undefined && c.memUsage === undefined)) continue
      const a = this.acc.get(c.name) ?? { cpu: 0, cpuMax: 0, mem: 0, memMax: 0, n: 0 }
      const cpu = c.cpu ?? 0
      const mem = c.memUsage ?? 0
      a.cpu += cpu
      a.mem += mem
      a.cpuMax = Math.max(a.cpuMax, cpu)
      a.memMax = Math.max(a.memMax, mem)
      a.n++
      this.acc.set(c.name, a)
    }
  }

  /** Writes the averages of the current bucket (also on shutdown). */
  flush() {
    if (this.ts === undefined || !this.acc.size) return
    const ts = this.ts
    const rows = [...this.acc.entries()].flatMap(([name, a]) => [
      { ts, metric: `ct:${name}:cpu`, value: a.cpu / a.n },
      { ts, metric: `ct:${name}:cpumax`, value: a.cpuMax },
      { ts, metric: `ct:${name}:mem`, value: a.mem / a.n },
      { ts, metric: `ct:${name}:memmax`, value: a.memMax },
    ])
    this.acc.clear()
    const t = schema.metricSamples
    this.d().transaction((tx) => {
      for (let i = 0; i < rows.length; i += 500) tx.insert(t).values(rows.slice(i, i + 500)).run()
    })
  }
}

/** Per container over the range: averages, peaks and ~120 points per series, highest CPU first. */
export function queryUsage(d: DB, range: UsageRange, units: Map<string, string> = new Map(), now = Date.now()): ContainerUsage[] {
  const span = USAGE_RANGES[range]
  const step = Math.max(USAGE_BUCKET_MS, Math.ceil(span / POINTS / USAGE_BUCKET_MS) * USAGE_BUCKET_MS)
  const t = schema.metricSamples
  const rows = d
    .select()
    .from(t)
    .where(and(gte(t.ts, now - span), lt(t.ts, now + USAGE_BUCKET_MS), metricPrefix('ct:')))
    .all()
  const by = new Map<string, Map<Kind, [number, number][]>>()
  for (const r of rows) {
    const i = r.metric.lastIndexOf(':')
    const name = r.metric.slice(3, i)
    const kind = r.metric.slice(i + 1) as Kind
    if (!KINDS.includes(kind) || !name) continue
    const m = by.get(name) ?? new Map<Kind, [number, number][]>()
    ;(m.get(kind) ?? m.set(kind, []).get(kind)!).push([r.ts, r.value])
    by.set(name, m)
  }
  const out: ContainerUsage[] = []
  for (const [name, m] of by) {
    const series = (kind: Kind, peak: boolean): [number, number][] => {
      const buckets = new Map<number, number[]>()
      for (const [ts, v] of m.get(kind) ?? []) {
        const b = Math.floor(ts / step) * step
        ;(buckets.get(b) ?? buckets.set(b, []).get(b)!).push(v)
      }
      return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, vs]) => [b + step / 2, peak ? Math.max(...vs) : vs.reduce((x, y) => x + y, 0) / vs.length])
    }
    const all = (kind: Kind) => (m.get(kind) ?? []).map(([, v]) => v)
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    const cpuAll = all('cpu')
    out.push({
      name,
      ...(units.get(name) ? { unit: units.get(name) } : {}),
      cpuAvg: avg(cpuAll),
      cpuMax: Math.max(0, ...all('cpumax')),
      memAvg: avg(all('mem')),
      memMax: Math.max(0, ...all('memmax')),
      uptime: Math.min(1, (cpuAll.length * USAGE_BUCKET_MS) / span),
      cpu: series('cpu', false),
      cpuPeak: series('cpumax', true),
      mem: series('mem', false),
    })
  }
  return out.sort((a, b) => b.cpuAvg - a.cpuAvg || b.memAvg - a.memAvg)
}

/** Demo: 30 days for the fixture containers (fixtures only, when there is nothing yet). */
export function seedUsageHistory(d: DB, containers: Pick<Container, 'name' | 'state' | 'cpu' | 'memUsage'>[], now = Date.now()) {
  const t = schema.metricSamples
  if (
    d
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(metricPrefix('ct:'))
      .get()!.n > 0
  )
    return
  let seed = 23
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const rows: { ts: number; metric: string; value: number }[] = []
  const end = Math.floor(now / USAGE_BUCKET_MS) * USAGE_BUCKET_MS
  for (const c of containers) {
    const baseCpu = Math.max(0.3, c.cpu ?? 1)
    const baseMem = c.memUsage ?? 80 * 1024 ** 2
    for (let ts = end - USAGE_KEEP_MS; ts < end; ts += USAGE_BUCKET_MS) {
      // stopped containers ran until three days ago
      if (c.state !== 'running' && ts > end - 3 * 86_400_000) break
      const h = new Date(ts).getHours()
      const evening = h >= 18 && h <= 23 ? 1 : 0
      const night = h >= 2 && h <= 4 ? 1 : 0
      const busy = c.name === 'jellyfin' ? evening * (rnd() > 0.5 ? 6 : 1.5) : c.name.startsWith('immich') ? night * 4 + evening : evening * 0.5
      const cpu = baseCpu * (0.5 + rnd() * 0.5) * (1 + busy)
      const mem = baseMem * (0.85 + rnd() * 0.15) * (1 + busy * 0.08)
      rows.push({ ts, metric: `ct:${c.name}:cpu`, value: cpu }, { ts, metric: `ct:${c.name}:cpumax`, value: cpu * (1.3 + rnd()) }, { ts, metric: `ct:${c.name}:mem`, value: mem }, { ts, metric: `ct:${c.name}:memmax`, value: mem * 1.05 })
    }
  }
  d.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(t).values(rows.slice(i, i + 500)).run()
  })
}
