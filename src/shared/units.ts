// Shared by the server collector and the UI alarm card.
import type { Unit } from './types'

/** Human-readable reason for a failed unit (shown on the alarm card). */
export function failureReason(u: Unit): string | undefined {
  if (u.active !== 'failed') return undefined
  switch (u.result) {
    case 'oom-kill':
      return u.memoryMax ? `OOM-Kill: Speicherlimit MemoryMax=${formatLimit(u.memoryMax)} erreicht` : 'OOM-Kill: vom Kernel wegen Speichermangel beendet'
    case 'exit-code':
      return `Prozess endete mit Exit ${u.exitStatus ?? '?'}`
    case 'signal':
      return `Prozess durch Signal beendet${u.exitStatus ? ` (${u.exitStatus})` : ''}`
    case 'core-dump':
      return 'Prozess abgestürzt (Core-Dump)'
    case 'timeout':
      return 'Zeitüberschreitung beim Starten oder Stoppen'
    case 'watchdog':
      return 'Watchdog ausgelöst'
    case 'start-limit-hit':
      return 'Zu viele Neustarts in kurzer Zeit (Start-Limit)'
    case 'resources':
      return 'Ressourcen fehlen (z. B. Image, Volume oder Netzwerk)'
    default:
      return u.result ? `Ergebnis: ${u.result}` : undefined
  }
}

function formatLimit(b: number) {
  const g = b / 1024 ** 3
  if (g >= 1 && Number.isInteger(g)) return `${g}G`
  const m = b / 1024 ** 2
  return Number.isInteger(m) ? `${m}M` : `${b}`
}
