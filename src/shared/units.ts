// Shared by the server collector and the UI alarm card.
import { msg } from './i18n'
import type { Unit } from './types'

/** Human-readable reason for a failed unit (shown on the alarm card). */
export function failureReason(u: Unit): string | undefined {
  if (u.active !== 'failed') return undefined
  switch (u.result) {
    case 'oom-kill':
      return u.memoryMax ? msg('units_oomKillMemoryLimitMemorymax', { value: formatLimit(u.memoryMax) }) : msg('units_oomKillTerminatedByKernel')
    case 'exit-code':
      return msg('units_processExitedStatus', { value: u.exitStatus ?? '?' })
    case 'signal':
      return msg('units_processKilledBySignal', { value: u.exitStatus ? ` (${u.exitStatus})` : '' })
    case 'core-dump':
      return msg('units_processCrashedCoreDump')
    case 'timeout':
      return msg('units_timedOutWhileStartingStopping')
    case 'watchdog':
      return msg('units_watchdogTriggered')
    case 'start-limit-hit':
      return msg('units_tooManyRestartsShortTime')
    case 'resources':
      return msg('units_resourcesMissingEGImage')
    default:
      return u.result ? msg('units_result', { result: u.result }) : undefined
  }
}

function formatLimit(b: number) {
  const g = b / 1024 ** 3
  if (g >= 1 && Number.isInteger(g)) return `${g}G`
  const m = b / 1024 ** 2
  return Number.isInteger(m) ? `${m}M` : `${b}`
}
