// Shared by the server collector and the UI alarm card.

import { m } from '~/paraglide/messages'
import { msg } from './i18n'
import type { Unit } from './types'

/** Human-readable reason for a failed unit (shown on the alarm card). */
export function failureReason(u: Unit): string | undefined {
  if (u.active !== 'failed') return undefined
  switch (u.result) {
    case 'oom-kill':
      return u.memoryMax ? msg(m.units_failure_oomLimit, { limit: formatLimit(u.memoryMax) }) : msg(m.units_failure_oomKernel)
    case 'exit-code':
      return msg(m.units_failure_exitCode, { status: u.exitStatus ?? '?' })
    case 'signal':
      return msg(m.units_failure_signal, { detail: u.exitStatus ? ` (${u.exitStatus})` : '' })
    case 'core-dump':
      return msg(m.units_failure_coreDump)
    case 'timeout':
      return msg(m.units_failure_timeout)
    case 'watchdog':
      return msg(m.units_failure_watchdog)
    case 'start-limit-hit':
      return msg(m.units_failure_startLimit)
    case 'resources':
      return msg(m.units_failure_resources)
    default:
      return u.result ? msg(m.units_failure_result, { result: u.result }) : undefined
  }
}

function formatLimit(b: number) {
  const g = b / 1024 ** 3
  if (g >= 1 && Number.isInteger(g)) return `${g}G`
  const m = b / 1024 ** 2
  return Number.isInteger(m) ? `${m}M` : `${b}`
}

/**
 * systemd lists only the units it has loaded. A Quadlet unit nothing wants (no WantedBy= in the
 * file) and that is not running is unloaded again after a daemon-reload, so it would drop out of
 * the units list although its file is still there. Every Quadlet file keeps a row: units systemd
 * does not list are added as stopped, without start at boot (nothing wants them, or they would be
 * loaded). Starting one loads it again.
 */
export function withQuadletFiles(units: Unit[], files: { name: string; type: string; unit: string }[]): Unit[] {
  const listed = new Set(units.map((u) => u.name))
  const missing = files
    .filter((f) => !listed.has(f.unit))
    .map(
      (f): Unit => ({
        name: f.unit,
        description: f.name,
        load: 'unloaded',
        active: 'inactive',
        sub: 'dead',
        kind: 'quadlet',
        quadlet: { file: f.name, type: f.type, boot: false },
        unitFileState: 'generated',
      }),
    )
  return missing.length ? [...units, ...missing] : units
}
