// Journal → System: the query of the browser and what it gets back (shared by UI and server).

/** all; kernel: _TRANSPORT=kernel; auth: syslog facilities auth and authpriv (logins, sudo, sshd). */
export const JOURNAL_SCOPES = ['all', 'kernel', 'auth'] as const
export type JournalScope = (typeof JOURNAL_SCOPES)[number]

/** Time ranges offered, in minutes; 0 = no limit. */
export const JOURNAL_SINCE = [15, 60, 1440, 10080, 0] as const

/** syslog priorities 0..7; the filter shows this level and everything more severe. */
export const JOURNAL_PRIOS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'] as const

export interface JournalQuery {
  scope: JournalScope
  /** offset (0 = this boot, -1 = the one before) or a boot ID */
  boot?: string
  /** minutes back from now */
  since?: number
  /** highest priority number shown (0..7) */
  prio?: number
  unit?: string
  /** SYSLOG_IDENTIFIER (program) */
  ident?: string
  /** full text, literal, case-insensitive */
  q?: string
  /** cursor of the oldest entry shown: the next page continues below it */
  before?: string
}

export interface SystemJournalEntry {
  ts: number
  priority: number
  message: string
  cursor: string
  unit?: string
  ident?: string
  transport?: string
  pid?: string
}

export interface JournalQueryResult {
  /** newest first */
  entries: SystemJournalEntry[]
  /** there are older entries for the same filter */
  more: boolean
}

export interface JournalBoot {
  offset: number
  id: string
  first: number
  last: number
}

/** What a line shows as its source: the unit without .service, else the program, else the kernel. */
export function journalSource(e: Pick<SystemJournalEntry, 'unit' | 'ident' | 'transport'>): string {
  if (e.transport === 'kernel') return 'kernel'
  return e.unit?.replace(/\.service$/, '') || e.ident || '–'
}
