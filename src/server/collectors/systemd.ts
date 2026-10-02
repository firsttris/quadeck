// systemd collector: units over D-Bus (busctl ListUnits) plus per-unit
// properties via `systemctl show`. Quadlet units are recognised by their
// SourcePath pointing at a .container/.pod/.network/.volume/.kube file.

import type { Unit, UnitKind } from '~/shared/types'
import { run, runOk } from '../exec'

export interface ListedUnit {
  name: string
  description: string
  load: string
  active: string
  sub: string
}

/** Parses `busctl --json=short call … ListUnits` (signature a(ssssssouso)). */
export function parseListUnits(json: string): ListedUnit[] {
  const parsed = JSON.parse(json) as { data: unknown[] }
  const rows = (Array.isArray(parsed.data[0]) ? parsed.data[0] : parsed.data) as string[][]
  return rows.map((r) => ({ name: r[0]!, description: r[1]!, load: r[2]!, active: r[3]!, sub: r[4]! }))
}

/** Parses `systemctl show -p … unit…`: blocks of Key=Value separated by blank lines. */
export function parseShow(text: string): Record<string, string>[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const o: Record<string, string> = {}
      for (const line of block.split('\n')) {
        const i = line.indexOf('=')
        if (i <= 0) continue
        const k = line.slice(0, i)
        // Listen= appears once per address of a socket.
        o[k] = k === 'Listen' && o[k] ? `${o[k]}\n${line.slice(i + 1)}` : line.slice(i + 1)
      }
      return o
    })
    .filter((o) => o.Id)
}

/** `--timestamp=unix` prints "@1712345678"; older systemd prints a date string. */
export function parseTimestamp(v: string | undefined): number | undefined {
  if (!v || v === 'n/a' || v === '0') return undefined
  const unix = v.match(/^@(\d+)/)
  if (unix) return Number(unix[1]) * 1000
  const t = Date.parse(v.replace(/^\w{3} /, '').replace(/ [A-Z]{3,5}$/, ''))
  return Number.isFinite(t) ? t : undefined
}

const bytes = (v: string | undefined) => {
  if (!v || v === '[not set]' || v === 'infinity') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n < 2 ** 63 - 1 ? n : undefined
}

const QUADLET_EXT = /\.(container|pod|network|volume|kube|image|build)$/
const QUADLET_DIR = /\/containers\/systemd\//

export function quadletOf(sourcePath: string | undefined): Unit['quadlet'] {
  if (!sourcePath || !QUADLET_EXT.test(sourcePath) || !QUADLET_DIR.test(sourcePath)) return undefined
  const file = sourcePath.split('/').pop()!
  return { file, type: file.split('.').pop()! }
}

export function calendarOf(timersCalendar: string | undefined): string | undefined {
  // "{ OnCalendar=*-*-* 03:00:00 ; next_elapse=… }"
  return timersCalendar?.match(/OnCalendar=([^;}]+)/)?.[1]?.trim()
}

export function buildUnit(l: ListedUnit, p: Record<string, string>): Unit {
  const quadlet = quadletOf(p.SourcePath)
  const isTimer = l.name.endsWith('.timer')
  const isSocket = l.name.endsWith('.socket')
  const kind: UnitKind = quadlet ? 'quadlet' : isTimer ? 'timer' : isSocket ? 'socket' : l.name.endsWith('.service') ? 'service' : 'other'
  const exit = Number(p.ExecMainStatus)
  return {
    name: l.name,
    description: l.description,
    load: l.load,
    active: l.active,
    sub: l.sub,
    kind,
    quadlet,
    type: p.Type || undefined,
    result: p.Result || undefined,
    exitStatus: Number.isFinite(exit) && p.ExecMainStatus !== '' ? exit : undefined,
    memory: bytes(p.MemoryCurrent),
    memoryMax: bytes(p.MemoryMax),
    since: parseTimestamp(p.StateChangeTimestamp),
    unitFileState: p.UnitFileState || undefined,
    timer: isTimer
      ? {
          calendar: calendarOf(p.TimersCalendar),
          next: parseTimestamp(p.NextElapseUSecRealtime),
          last: parseTimestamp(p.LastTriggerUSec),
          unit: p.Unit || undefined,
        }
      : undefined,
    socket: isSocket ? { listen: (p.Listen ?? '').split('\n').filter(Boolean), triggers: p.Triggers?.split(/\s+/)[0] || undefined } : undefined,
  }
}

const PROPS = ['Id', 'Type', 'Result', 'ExecMainStatus', 'MemoryCurrent', 'MemoryMax', 'StateChangeTimestamp', 'UnitFileState', 'SourcePath', 'TimersCalendar', 'NextElapseUSecRealtime', 'LastTriggerUSec', 'Unit', 'Listen', 'Triggers']

/** Which units are worth showing: services, timers, sockets and anything generated from a Quadlet. */
const relevant = (u: ListedUnit) => u.load !== 'not-found' && /\.(service|timer|socket)$/.test(u.name)

export async function listUnits(): Promise<ListedUnit[]> {
  const out = await runOk(['busctl', '--json=short', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'ListUnits'])
  return parseListUnits(out)
}

export async function collectUnits(): Promise<Unit[]> {
  const listed = (await listUnits()).filter(relevant)
  const props = new Map<string, Record<string, string>>()
  // Batch to keep argv sizes sane on hosts with many units.
  for (let i = 0; i < listed.length; i += 150) {
    const batch = listed.slice(i, i + 150).map((u) => u.name)
    const r = await run(['systemctl', 'show', '--timestamp=unix', ...PROPS.flatMap((p) => ['-p', p]), '--', ...batch])
    let text = r.stdout
    if (r.code !== 0) {
      // systemd < 251 has no --timestamp option.
      text = (await run(['systemctl', 'show', ...PROPS.flatMap((p) => ['-p', p]), '--', ...batch])).stdout
    }
    for (const o of parseShow(text)) props.set(o.Id!, o)
  }
  return listed.map((l) => buildUnit(l, props.get(l.name) ?? {})).sort((a, b) => a.name.localeCompare(b.name))
}

export async function systemdVersion(): Promise<string | undefined> {
  const r = await run(['systemctl', '--version'])
  return r.stdout.match(/systemd (\d+)/)?.[1]
}

