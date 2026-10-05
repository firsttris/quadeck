// Power and energy of the server: CPU from its own energy counter (RAPL), GPU from its driver,
// disks estimated from type and state, the rest from a base value plus power supply loss. The
// total is therefore always an estimate. No I/O here.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'

export type DiskKind = 'hdd' | 'ssd' | 'nvme'

/** One RAPL zone (/sys/class/powercap/intel-rapl:N[:M]). */
export interface RaplZone {
  id: string
  name: string
  energyUj: number
  maxUj: number
}

export interface SampleDisk {
  name: string
  model?: string
  kind: DiskKind
  usb: boolean
  state: 'active' | 'standby' | 'unknown'
}

/** What the root helper reads every 30 s. */
export interface PowerSample {
  at: number
  rapl: RaplZone[]
  disks: SampleDisk[]
}

export interface EnergySettings {
  /** € per kWh. */
  price: number
  /** Mainboard, RAM, fans, network: watts. */
  baseW: number
  /** Power supply loss in percent of everything else. */
  lossPct: number
}
export const DEFAULT_ENERGY: EnergySettings = { price: 0.35, baseW: 15, lossPct: 10 }

export const COMPONENTS = ['cpu', 'gpu', 'disks', 'rest'] as const
export type Component = (typeof COMPONENTS)[number]
export type Split = Record<Component, number>

export interface DiskPowerNow extends SampleDisk {
  watts: number
}

export interface PowerNow extends Split {
  at: number
  total: number
  /** RAPL measured the CPU (else estimated from the load). */
  cpuMeasured: boolean
  /** The GPU driver reports watts (false: no GPU or none reported). */
  gpuMeasured: boolean
  base: number
  loss: number
  disksNow: DiskPowerNow[]
}

/** Typical watts: spinning 3.5″ disk, standby, SATA SSD, NVMe (averages over idle and light use). */
export const DISK_W: Record<DiskKind, { active: number; standby: number }> = {
  hdd: { active: 6, standby: 0.8 },
  ssd: { active: 1.2, standby: 1.2 },
  nvme: { active: 3, standby: 3 },
}

export const diskWatts = (d: Pick<SampleDisk, 'kind' | 'state'>) => (d.state === 'standby' ? DISK_W[d.kind].standby : DISK_W[d.kind].active)

/** What a disk saves per standby hour, Wh. */
export const standbySavingW = (kind: DiskKind) => DISK_W[kind].active - DISK_W[kind].standby

/**
 * The zones that add up to the CPU: each package, plus DRAM (Intel reports it apart from the
 * package). Not psys (the whole platform, would count twice), not cores/uncore (inside the package).
 */
export const cpuZone = (z: Pick<RaplZone, 'id' | 'name'>) => /^intel-rapl:\d+(:\d+)?$/.test(z.id) && (/^package/.test(z.name) || z.name === 'dram')

/** Average CPU watts between two samples; undefined without counters or time. */
export function raplWatts(prev: PowerSample | undefined, cur: PowerSample): number | undefined {
  if (!prev || cur.at <= prev.at) return undefined
  const zones = cur.rapl.filter(cpuZone)
  if (!zones.length) return undefined
  let uj = 0
  for (const z of zones) {
    const p = prev.rapl.find((x) => x.id === z.id)
    if (!p) return undefined
    // the counter wraps at max_energy_range_uj
    uj += z.energyUj >= p.energyUj ? z.energyUj - p.energyUj : z.energyUj + z.maxUj - p.energyUj
  }
  return uj / ((cur.at - prev.at) / 1000) / 1e6
}

/** Without RAPL: a rough guess from the load (idle a few watts, a home server CPU rarely above 35 W). */
export const cpuEstimate = (load: number) => 4 + Math.min(1, Math.max(0, load)) * 30

export function powerNow(input: { at: number; cpuW?: number; load: number; gpuW?: number; disks: SampleDisk[]; settings: EnergySettings }): PowerNow {
  const cpu = input.cpuW ?? cpuEstimate(input.load)
  const gpu = input.gpuW ?? 0
  const disksNow = input.disks.map((d) => ({ ...d, watts: diskWatts(d) }))
  const disks = disksNow.reduce((n, d) => n + d.watts, 0)
  const base = input.settings.baseW
  const loss = ((cpu + gpu + disks + base) * input.settings.lossPct) / 100
  const rest = base + loss
  return { at: input.at, cpu, gpu, disks, rest, total: cpu + gpu + disks + rest, cpuMeasured: input.cpuW !== undefined, gpuMeasured: input.gpuW !== undefined, base, loss, disksNow }
}

/** The same reading with other settings (base value, loss): what the page shows right after saving. */
export function withSettings(p: PowerNow, settings: EnergySettings): PowerNow {
  const loss = ((p.cpu + p.gpu + p.disks + settings.baseW) * settings.lossPct) / 100
  const rest = settings.baseW + loss
  return { ...p, base: settings.baseW, loss, rest, total: p.cpu + p.gpu + p.disks + rest }
}

export function parseEnergySettings(v: unknown): EnergySettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const num = (x: unknown) => (typeof x === 'string' ? Number(x.replace(',', '.')) : Number(x))
  const price = num(o.price)
  const baseW = num(o.baseW)
  const lossPct = num(o.lossPct)
  if (!(price >= 0 && price <= 5) || !(baseW >= 0 && baseW <= 500) || !(lossPct >= 0 && lossPct <= 50)) throw new Error(msg(m.energy_error_settings))
  return { price: Math.round(price * 10000) / 10000, baseW: Math.round(baseW * 10) / 10, lossPct: Math.round(lossPct * 10) / 10 }
}

// ---------- energy over time ----------

/** One hour of energy, Wh per component, ts = start of the hour. */
export interface HourEnergy extends Split {
  ts: number
}

export const sumSplit = (s: Split) => s.cpu + s.gpu + s.disks + s.rest
export const kwh = (wh: number) => wh / 1000

/** Local calendar day / month of a timestamp, as the start of it. */
export function dayStart(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
export function monthStart(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** Hours → days or months (local time), oldest first. */
export function group(hours: HourEnergy[], by: 'day' | 'month'): HourEnergy[] {
  const key = by === 'day' ? dayStart : monthStart
  const out = new Map<number, HourEnergy>()
  for (const h of hours) {
    const k = key(h.ts)
    const e = out.get(k) ?? { ts: k, cpu: 0, gpu: 0, disks: 0, rest: 0 }
    for (const c of COMPONENTS) e[c] += h[c]
    out.set(k, e)
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts)
}

/** This month so far and projected to its end (from the average per hour that was measured). */
export function monthProjection(hours: HourEnergy[], now: number): { kwh: number; projected: number } {
  const start = monthStart(now)
  const d = new Date(now)
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  const these = hours.filter((h) => h.ts >= start)
  const wh = these.reduce((n, h) => n + sumSplit(h), 0)
  const covered = these.length
  return { kwh: kwh(wh), projected: covered ? kwh((wh / covered) * ((end - start) / 3_600_000)) : 0 }
}

/** Average kWh per day over the hours there are (up to the last 30 days). */
export function dailyAverage(hours: HourEnergy[], now: number): number | undefined {
  const recent = hours.filter((h) => h.ts >= now - 30 * 86_400_000)
  if (recent.length < 3) return undefined
  return (kwh(recent.reduce((n, h) => n + sumSplit(h), 0)) / recent.length) * 24
}

/** kWh a month that standby saves, from standby seconds per disk over the last days. */
export function standbySavings(standby: { kind: DiskKind; seconds: number }[], days: number): number {
  if (days <= 0) return 0
  const wh = standby.reduce((n, s) => n + (s.seconds / 3600) * standbySavingW(s.kind), 0)
  return kwh(wh) * (30 / days)
}

/** lsblk -J -o NAME,TYPE,ROTA,TRAN,MODEL: the real disks with their kind. */
export function parseLsblkKinds(json: string): Omit<SampleDisk, 'state'>[] {
  let nodes: { name: string; type?: string; rota?: boolean | string | number; tran?: string | null; model?: string | null }[] = []
  try {
    nodes = (JSON.parse(json) as { blockdevices?: typeof nodes }).blockdevices ?? []
  } catch {
    return []
  }
  const yes = (v: unknown) => v === true || v === '1' || v === 1
  return nodes
    .filter((n) => n.type === 'disk' && /^(sd|hd|vd|xvd|nvme|mmcblk)/.test(n.name))
    .map((n) => ({
      name: n.name,
      ...(n.model ? { model: n.model.trim() } : {}),
      kind: n.name.startsWith('nvme') ? 'nvme' : yes(n.rota) ? 'hdd' : 'ssd',
      usb: n.tran === 'usb',
    }))
}
