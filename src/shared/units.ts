// Shared by the server collector and the UI alarm card.
import { tr } from './i18n'
import type { Unit } from './types'

/** Human-readable reason for a failed unit (shown on the alarm card). */
export function failureReason(u: Unit): string | undefined {
  if (u.active !== 'failed') return undefined
  switch (u.result) {
    case 'oom-kill':
      return u.memoryMax
        ? tr(`OOM-Kill: Speicherlimit MemoryMax=${formatLimit(u.memoryMax)} erreicht`, `OOM kill: memory limit MemoryMax=${formatLimit(u.memoryMax)} reached`)
        : tr('OOM-Kill: vom Kernel wegen Speichermangel beendet', 'OOM kill: terminated by the kernel due to low memory')
    case 'exit-code':
      return tr(`Prozess endete mit Exit ${u.exitStatus ?? '?'}`, `Process exited with status ${u.exitStatus ?? '?'}`)
    case 'signal':
      return tr(`Prozess durch Signal beendet${u.exitStatus ? ` (${u.exitStatus})` : ''}`, `Process killed by signal${u.exitStatus ? ` (${u.exitStatus})` : ''}`)
    case 'core-dump':
      return tr('Prozess abgestürzt (Core-Dump)', 'Process crashed (core dump)')
    case 'timeout':
      return tr('Zeitüberschreitung beim Starten oder Stoppen', 'Timed out while starting or stopping')
    case 'watchdog':
      return tr('Watchdog ausgelöst', 'Watchdog triggered')
    case 'start-limit-hit':
      return tr('Zu viele Neustarts in kurzer Zeit (Start-Limit)', 'Too many restarts in a short time (start limit)')
    case 'resources':
      return tr('Ressourcen fehlen (z. B. Image, Volume oder Netzwerk)', 'Resources missing (e.g. image, volume or network)')
    default:
      return u.result ? tr(`Ergebnis: ${u.result}`, `Result: ${u.result}`) : undefined
  }
}

function formatLimit(b: number) {
  const g = b / 1024 ** 3
  if (g >= 1 && Number.isInteger(g)) return `${g}G`
  const m = b / 1024 ** 2
  return Number.isInteger(m) ? `${m}M` : `${b}`
}
