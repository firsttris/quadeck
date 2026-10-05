// Energy saving for hard disks: when a disk goes to standby (hdparm -S) and how hard it saves by
// itself (APM, hdparm -B). Set per disk, bound to its serial number through a udev rule, so it
// survives reboots and replugging. No I/O here.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'

export const STANDBY_MINUTES = [0, 10, 20, 30, 60, 120] as const
export type StandbyMinutes = (typeof STANDBY_MINUTES)[number]

/** APM: let the disk decide (not set), save (127: may spin down by itself), performance (254: never spins down by itself). */
export type ApmMode = 'disk' | 'save' | 'perf'
export const APM_VALUE: Record<Exclude<ApmMode, 'disk'>, number> = { save: 127, perf: 254 }

export interface PowerSetting {
  minutes: StandbyMinutes
  apm: ApmMode
}

export interface DiskPower {
  name: string
  serial?: string
  model?: string
  /** USB enclosures often ignore hdparm -S. */
  usb: boolean
  /** Holds /, /boot or /var: never offered. */
  system: boolean
  /** Member of an md RAID: the array decides. */
  raid: boolean
  state: 'active' | 'standby' | 'unknown'
  /** APM level the disk reports (only read while awake: the query could wake it). */
  apmNow?: number | 'off'
  /** Quadeck's own rule for this disk. */
  setting?: PowerSetting
  mounts: string[]
}

export interface PowerState {
  installed: boolean
  rulesPath: string
  /** Other places that set spindown (own udev rules, /etc/hdparm.conf): shown, never touched. */
  foreign: string[]
  disks: DiskPower[]
}

export const SERIAL = /^[A-Za-z0-9_.-]{1,80}$/

/** hdparm -S value: 1–240 are 5 s steps, 241–251 are 30 min steps. */
export function standbyValue(minutes: StandbyMinutes): number {
  if (minutes === 0) return 0
  if (minutes <= 20) return (minutes * 60) / 5
  return 240 + minutes / 30
}

export function hdparmArgs(s: PowerSetting): string[] {
  return [...(s.apm !== 'disk' ? ['-B', String(APM_VALUE[s.apm])] : []), '-S', String(standbyValue(s.minutes))]
}

export function parsePowerSetting(v: unknown): PowerSetting | undefined {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const minutes = Number(o.minutes) as StandbyMinutes
  if (!STANDBY_MINUTES.includes(minutes)) return undefined
  const apm = (['disk', 'save', 'perf'].includes(o.apm as string) ? o.apm : 'disk') as ApmMode
  return { minutes, apm }
}

const HEADER = '# Written by Quadeck (Disks → Energy saving) – changes are overwritten'

/** The udev rules file: one line per disk, matched by serial, applied on add and change. */
export function powerRules(settings: Record<string, PowerSetting>, hdparm: string): string {
  const lines = Object.entries(settings)
    .filter(([serial]) => SERIAL.test(serial))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([serial, s]) => `ACTION=="add|change", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ENV{ID_SERIAL_SHORT}=="${serial}", RUN+="${hdparm} ${hdparmArgs(s).join(' ')} /dev/%k"`)
  return [HEADER, ...lines].join('\n') + '\n'
}

/** Quadeck's own rules file back into settings (lines it did not write are ignored). */
export function parsePowerRules(text: string): Record<string, PowerSetting> {
  const out: Record<string, PowerSetting> = {}
  for (const l of text.split('\n')) {
    const serial = /ENV\{ID_SERIAL_SHORT\}=="([^"]+)"/.exec(l)?.[1]
    const run = /RUN\+="[^"]*?hdparm((?: -[BS] \d+)+) \/dev\/%k"/.exec(l)?.[1]
    if (!serial || !run || !SERIAL.test(serial)) continue
    const b = /-B (\d+)/.exec(run)?.[1]
    const s = Number(/-S (\d+)/.exec(run)?.[1] ?? NaN)
    const minutes = STANDBY_MINUTES.find((m) => standbyValue(m) === s)
    if (minutes === undefined) continue
    out[serial] = { minutes, apm: b === '127' ? 'save' : b === '254' ? 'perf' : 'disk' }
  }
  return out
}

/** `hdparm -C`: "drive state is:  standby" / "active/idle". */
export function parseHdparmState(out: string): DiskPower['state'] {
  const s = /drive state is:\s*(.+)/.exec(out)?.[1]?.trim() ?? ''
  if (/standby|sleeping/i.test(s)) return 'standby'
  if (/active|idle/i.test(s)) return 'active'
  return 'unknown'
}

/** `hdparm -B`: "APM_level = 254" / "APM_level = off" / "not supported". */
export function parseHdparmApm(out: string): number | 'off' | undefined {
  const v = /APM_level\s*=\s*(\w+)/.exec(out)?.[1]
  if (!v) return undefined
  return v === 'off' ? 'off' : Number.isFinite(Number(v)) ? Number(v) : undefined
}

/** Spin-ups per day from the Start_Stop_Count history (needs at least half a day). */
export function wakeRate(points: [number, number][], now = Date.now(), days = 7): number | undefined {
  const recent = points.filter(([t]) => t >= now - days * 86_400_000).sort((a, b) => a[0] - b[0])
  if (recent.length < 2) return undefined
  const [t0, v0] = recent[0]!
  const [t1, v1] = recent[recent.length - 1]!
  const span = (t1 - t0) / 86_400_000
  if (span < 0.5 || v1 < v0) return undefined
  return (v1 - v0) / span
}

/** More than this many spin-ups a day wear the motor and heads: lengthen the standby time. */
export const WAKE_WARN_PER_DAY = 24

export function standbyLabel(minutes: StandbyMinutes): string {
  return minutes === 0 ? msg(m.power_never) : minutes < 60 ? msg(m.power_afterMin, { n: minutes }) : msg(m.power_afterHours, { n: minutes / 60 })
}

/** Spin-ups per day as a series, from the counter's samples (one point per day boundary crossed). */
export function dailyWakes(points: [number, number][]): [number, number][] {
  const byDay = new Map<number, number>()
  for (const [t, v] of points) {
    const day = Math.floor(t / 86_400_000)
    byDay.set(day, Math.max(byDay.get(day) ?? 0, v))
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (let i = 1; i < days.length; i++) {
    const [d, v] = days[i]!
    const [d0, v0] = days[i - 1]!
    if (v >= v0) out.push([d * 86_400_000 + 43_200_000, (v - v0) / (d - d0)])
  }
  return out
}
