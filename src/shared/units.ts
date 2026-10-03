// Shared by the server collector and the UI alarm card.
import { msg } from './i18n'
import type { Unit } from './types'

/** Human-readable reason for a failed unit (shown on the alarm card). */
export function failureReason(u: Unit): string | undefined {
  if (u.active !== 'failed') return undefined
  switch (u.result) {
    case 'oom-kill':
      return u.memoryMax ? msg('units_failure_oomLimit', { limit: formatLimit(u.memoryMax) }) : msg('units_failure_oomKernel')
    case 'exit-code':
      return msg('units_failure_exitCode', { status: u.exitStatus ?? '?' })
    case 'signal':
      return msg('units_failure_signal', { detail: u.exitStatus ? ` (${u.exitStatus})` : '' })
    case 'core-dump':
      return msg('units_failure_coreDump')
    case 'timeout':
      return msg('units_failure_timeout')
    case 'watchdog':
      return msg('units_failure_watchdog')
    case 'start-limit-hit':
      return msg('units_failure_startLimit')
    case 'resources':
      return msg('units_failure_resources')
    default:
      return u.result ? msg('units_failure_result', { result: u.result }) : undefined
  }
}

function formatLimit(b: number) {
  const g = b / 1024 ** 3
  if (g >= 1 && Number.isInteger(g)) return `${g}G`
  const m = b / 1024 ** 2
  return Number.isInteger(m) ? `${m}M` : `${b}`
}
