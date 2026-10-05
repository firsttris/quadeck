// The energy meter (web app): every 30 s the helper's sample becomes watts per component; watts
// add up to Wh per hour in metric_samples (energy:<component>, energy:standby:<disk> in seconds),
// kept two years. The current hour is rewritten on every tick, so a restart loses nothing.

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { COMPONENTS, DEFAULT_ENERGY, withSettings, dailyAverage, dayStart, group, monthProjection, parseEnergySettings, powerNow, raplWatts, standbySavings, sumSplit, kwh, type DiskKind, type EnergySettings, type HourEnergy, type PowerNow, type PowerSample, type Split } from '~/shared/energy'
import type { GpuMetrics } from '~/shared/types'
import { db, metricPrefix, schema, type DB } from './db'
import { getSetting, setSetting } from './settings'

const SETTINGS = 'energy.settings'
/** A longer gap means the server or Quadeck was off: not counted. */
const MAX_GAP_MS = 120_000

export function energySettings(): EnergySettings {
  const v = getSetting<EnergySettings>(SETTINGS)
  try {
    return v ? parseEnergySettings(v) : DEFAULT_ENERGY
  } catch {
    return DEFAULT_ENERGY
  }
}
export function setEnergySettings(v: unknown): EnergySettings {
  const s = parseEnergySettings(v)
  setSetting(SETTINGS, s)
  return s
}

export const hourStart = (ts: number) => Math.floor(ts / 3_600_000) * 3_600_000

/** Sum of GPU watts, if any GPU reports them. */
export function gpuWatts(gpus: GpuMetrics[] | undefined): number | undefined {
  const w = (gpus ?? []).map((g) => g.powerW).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return w.length ? w.reduce((a, b) => a + b, 0) : undefined
}

export class EnergyMeter {
  private prev?: PowerSample
  private lastTick?: number
  private hour?: { ts: number; wh: Split; standby: Record<string, number> }
  private kinds = new Map<string, DiskKind>()
  now?: PowerNow

  constructor(private d: () => DB = db) {}

  /** One sample: returns the current power; adds the time since the last sample to this hour. */
  tick(sample: PowerSample, input: { load: number; gpus?: GpuMetrics[]; settings?: EnergySettings }, now = sample.at): PowerNow {
    const measured = raplWatts(this.prev, sample)
    this.prev = sample
    // The first sample after a start has no counter difference yet: keep the last measured CPU value.
    const cpuW = measured ?? (sample.rapl.length && this.now?.cpuMeasured ? this.now.cpu : undefined)
    const p = powerNow({ at: now, cpuW, load: input.load, gpuW: gpuWatts(input.gpus), disks: sample.disks, settings: input.settings ?? energySettings() })
    const dt = this.lastTick !== undefined && now > this.lastTick && now - this.lastTick <= MAX_GAP_MS ? now - this.lastTick : 0
    this.lastTick = now
    for (const disk of sample.disks) this.kinds.set(disk.name, disk.kind)
    const hs = hourStart(now)
    if (!this.hour || this.hour.ts !== hs) this.hour = this.load(hs)
    if (dt > 0) {
      for (const c of COMPONENTS) this.hour.wh[c] += (p[c] * dt) / 3_600_000
      for (const disk of sample.disks) if (disk.state === 'standby') this.hour.standby[disk.name] = (this.hour.standby[disk.name] ?? 0) + dt / 1000
      this.save()
    }
    this.now = p
    return p
  }

  private load(ts: number) {
    const t = schema.metricSamples
    const rows = this.d()
      .select()
      .from(t)
      .where(and(eq(t.ts, ts), metricPrefix('energy:')))
      .all()
    const wh: Split = { cpu: 0, gpu: 0, disks: 0, rest: 0 }
    const standby: Record<string, number> = {}
    for (const r of rows) {
      const m = r.metric.slice('energy:'.length)
      if ((COMPONENTS as readonly string[]).includes(m)) wh[m as keyof Split] = r.value
      else if (m.startsWith('standby:')) standby[m.slice('standby:'.length)] = r.value
    }
    return { ts, wh, standby }
  }

  private save() {
    const h = this.hour!
    const t = schema.metricSamples
    const rows = [...COMPONENTS.map((c) => ({ ts: h.ts, metric: `energy:${c}`, value: h.wh[c] })), ...Object.entries(h.standby).map(([disk, s]) => ({ ts: h.ts, metric: `energy:standby:${disk}`, value: s }))]
    const d = this.d()
    d.transaction((tx) => {
      tx.delete(t)
        .where(
          and(
            eq(t.ts, h.ts),
            inArray(
              t.metric,
              rows.map((r) => r.metric),
            ),
          ),
        )
        .run()
      tx.insert(t).values(rows).run()
    })
  }

  diskKind(name: string): DiskKind | undefined {
    return this.kinds.get(name)
  }
}

/** Hourly energy since `from`, oldest first. */
export function energyHours(d: DB, from: number, now = Date.now()): HourEnergy[] {
  const t = schema.metricSamples
  const rows = d
    .select()
    .from(t)
    .where(and(gte(t.ts, from), lt(t.ts, now + 3_600_000), inArray(t.metric, COMPONENTS.map((c) => `energy:${c}`))))
    .all()
  const by = new Map<number, HourEnergy>()
  for (const r of rows) {
    const e = by.get(r.ts) ?? { ts: r.ts, cpu: 0, gpu: 0, disks: 0, rest: 0 }
    e[r.metric.slice('energy:'.length) as keyof Split] = r.value
    by.set(r.ts, e)
  }
  return [...by.values()].sort((a, b) => a.ts - b.ts)
}

/** Standby seconds per disk since `from`. */
export function standbySeconds(d: DB, from: number): Record<string, number> {
  const t = schema.metricSamples
  const rows = d
    .select({ metric: t.metric, s: sql<number>`sum(${t.value})` })
    .from(t)
    .where(and(gte(t.ts, from), metricPrefix('energy:standby:')))
    .groupBy(t.metric)
    .all()
  return Object.fromEntries(rows.map((r) => [r.metric.slice('energy:standby:'.length), r.s]))
}

export interface EnergyReport {
  now?: PowerNow
  settings: EnergySettings
  hours: HourEnergy[]
  days: HourEnergy[]
  months: HourEnergy[]
  today: number
  month: { kwh: number; projected: number }
  year?: number
  dayAverage?: number
  /** Per disk: standby hours today. */
  standbyToday: Record<string, number>
  /** kWh a month that disk standby saves (last 30 days). */
  standbySavings?: number
  since?: number
}

export function energyReport(d: DB, now: PowerNow | undefined, kindOf: (disk: string) => DiskKind | undefined, at = Date.now()): EnergyReport {
  const settings = energySettings()
  const year = energyHours(d, at - 366 * 86_400_000, at)
  const today = dayStart(at)
  const hours = year.filter((h) => h.ts >= hourStart(at) - 23 * 3_600_000)
  const days = group(
    year.filter((h) => h.ts >= dayStart(at - 29 * 86_400_000)),
    'day',
  )
  const months = group(year, 'month').slice(-12)
  const avg = dailyAverage(year, at)
  const month30 = at - 30 * 86_400_000
  const standby = standbySeconds(d, month30)
  const covered = year.filter((h) => h.ts >= month30).length / 24
  const savingsInput = Object.entries(standby).flatMap(([disk, seconds]) => {
    const kind = kindOf(disk)
    return kind ? [{ kind, seconds }] : []
  })
  return {
    ...(now ? { now: withSettings(now, settings) } : {}),
    settings,
    hours,
    days,
    months,
    today: kwh(year.filter((h) => h.ts >= today).reduce((n, h) => n + sumSplit(h), 0)),
    month: monthProjection(year, at),
    ...(avg !== undefined ? { year: avg * 365, dayAverage: avg } : {}),
    standbyToday: Object.fromEntries(Object.entries(standbySeconds(d, today)).map(([k, s]) => [k, s / 3600])),
    ...(savingsInput.length && covered >= 1 ? { standbySavings: standbySavings(savingsInput, Math.min(30, covered)) } : {}),
    ...(year.length ? { since: year[0]!.ts } : {}),
  }
}

/** Demo: a year of plausible hours (fixtures only, when there are none). */
export function seedEnergyHistory(d: DB, now = Date.now()) {
  const t = schema.metricSamples
  if (
    d
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(metricPrefix('energy:'))
      .get()!.n > 0
  )
    return
  let seed = 11
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const rows: { ts: number; metric: string; value: number }[] = []
  const end = hourStart(now)
  for (let ts = end - 365 * 86_400_000; ts < end; ts += 3_600_000) {
    const h = new Date(ts).getHours()
    const busy = h >= 17 && h <= 23 ? 1 : h >= 2 && h <= 4 ? 0.6 : 0.2
    const winter = 1 + 0.08 * Math.cos(((new Date(ts).getMonth() + 0.5) / 12) * 2 * Math.PI)
    const cpu = (11 + busy * 9 + rnd() * 3) * winter
    const gpu = h >= 18 && h <= 23 && rnd() > 0.6 ? 18 + rnd() * 10 : 8 + rnd()
    const standby = h >= 1 && h <= 15 ? 2 : 1
    const disks = 3 + (4 - standby) * 6 + standby * 0.8
    const rest = 15 + (cpu + gpu + disks + 15) * 0.1
    rows.push({ ts, metric: 'energy:cpu', value: cpu }, { ts, metric: 'energy:gpu', value: gpu }, { ts, metric: 'energy:disks', value: disks }, { ts, metric: 'energy:rest', value: rest })
    rows.push({ ts, metric: 'energy:standby:sdd', value: 3600 })
    if (standby === 2) rows.push({ ts, metric: 'energy:standby:sdc', value: 3600 })
  }
  for (let i = 0; i < rows.length; i += 500) d.insert(t).values(rows.slice(i, i + 500)).run()
}
