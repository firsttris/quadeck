// systemd timers ("Zeitpläne"): types, checks, the unit files Quadeck writes
// for its own timers, a schedule builder for OnCalendar= and a cron converter.
// Shared by the page, the web app and the root helper.

/** A timer Quadeck manages: `<name>.service` + `<name>.timer` in /etc/systemd/system. */
export interface TimerSpec {
  name: string
  description: string
  /** Shell command(s), run with /bin/sh -c; may span several lines. */
  command: string
  /** '' = root. */
  user: string
  workingDirectory: string
  /** OnCalendar= expression. */
  calendar: string
  /** Catch up on runs missed while the server was off. */
  persistent: boolean
  /** RandomizedDelaySec in minutes, 0 = off. */
  randomDelay: number
  /** Nice=10 and idle I/O. */
  lowPriority: boolean
  /** Wait for network-online.target. */
  network: boolean
}

export interface TimerEntry {
  /** x.timer */
  name: string
  /** Unit it triggers. */
  service?: string
  description?: string
  /** Effective OnCalendar= expressions. */
  calendars: string[]
  /** Monotonic triggers, e.g. "OnBootSec=15min". */
  monotonic: string[]
  /** Schedule from Quadeck's drop-in (foreign timers). */
  override?: string
  /** Set for timers Quadeck created. */
  managed?: TimerSpec
  /** Managed files were changed by hand: only the schedule is edited via drop-in then. */
  modified?: boolean
  /** Command of the service (ExecStart, first one). */
  command?: string
  enabled: boolean
  unitFileState?: string
  active: boolean
  next?: number
  last?: number
  /** Last result of the service: success, exit-code, … */
  result?: string
  exitStatus?: number
  serviceActive?: string
  /** Shipped by a package (/usr/lib/systemd): only the schedule can be overridden. */
  vendor: boolean
  path?: string
}

export interface TimersState {
  timers: TimerEntry[]
  unitDir: string
  error?: string
}

export interface CalendarPreview {
  ok: boolean
  normalized?: string
  next: number[]
  error?: string
}

export type TimerAction = 'run' | 'enable' | 'disable'
export const TIMER_ACTIONS: readonly TimerAction[] = ['run', 'enable', 'disable']

export const MANAGED_MARKER = '# quadeck-timer: '
export const TIMER_BASE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
export const TIMER_UNIT = /^[A-Za-z0-9:_.\\@-]{1,240}\.timer$/
export const CALENDAR = /^[A-Za-z0-9 *:,./~-]{1,120}$/
const USER = /^[a-z_][a-z0-9_.-]{0,31}\$?$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/
const MAX_COMMAND = 8000

export const emptySpec = (): TimerSpec => ({
  name: '',
  description: '',
  command: '',
  user: '',
  workingDirectory: '',
  calendar: '*-*-* 03:00:00',
  persistent: true,
  randomDelay: 0,
  lowPriority: false,
  network: false,
})

/** Problems with a spec (German), empty when fine. */
export function specErrors(s: TimerSpec): string[] {
  const out: string[] = []
  if (!TIMER_BASE.test(s.name) || /\.(service|timer)$/.test(s.name)) out.push('Name: Buchstaben, Ziffern, „-“, „_“ oder „.“ (ohne .service/.timer)')
  if (s.description.length > 200 || /[\n\r\\]/.test(s.description) || CONTROL.test(s.description)) out.push('Beschreibung: eine Zeile, ohne „\\“')
  if (!s.command.trim()) out.push('Befehl fehlt')
  else if (s.command.length > MAX_COMMAND || /[\x00\r]/.test(s.command) || CONTROL.test(s.command.replace(/\t/g, ''))) out.push('Befehl enthält Steuerzeichen oder ist zu lang')
  if (s.user && !USER.test(s.user)) out.push('Benutzer ungültig')
  if (s.workingDirectory && (!s.workingDirectory.startsWith('/') || /[\n\r\\]/.test(s.workingDirectory) || CONTROL.test(s.workingDirectory) || s.workingDirectory.length > 400)) out.push('Arbeitsverzeichnis muss ein absoluter Pfad sein')
  if (!CALENDAR.test(s.calendar.trim())) out.push('Zeitplan ungültig')
  if (!Number.isInteger(s.randomDelay) || s.randomDelay < 0 || s.randomDelay > 24 * 60) out.push('Zufällige Verzögerung: 0 bis 1440 Minuten')
  return out
}

/** Spec from untrusted JSON (API, helper socket); throws a message for the user. */
export function parseSpec(v: unknown): TimerSpec {
  if (!v || typeof v !== 'object') throw new Error('Zeitplan fehlt')
  const o = v as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const spec: TimerSpec = {
    name: str('name').trim(),
    description: str('description').trim(),
    command: str('command').replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    user: str('user').trim(),
    workingDirectory: str('workingDirectory').trim(),
    calendar: str('calendar').trim(),
    persistent: o.persistent === true,
    randomDelay: typeof o.randomDelay === 'number' ? o.randomDelay : 0,
    lowPriority: o.lowPriority === true,
    network: o.network === true,
  }
  const errors = specErrors(spec)
  if (errors.length) throw new Error(errors.join(' · '))
  return spec
}

/** `%` starts a specifier in unit files. */
const pct = (s: string) => s.replace(/%/g, '%%')

/**
 * One double-quoted ExecStart word: systemd unquotes C escapes, expands `$VAR`
 * (escaped as `$$`) and `%` specifiers (`%%`).
 */
export function execQuote(s: string): string {
  const body = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\$/g, '$$$$').replace(/%/g, '%%')
  return `"${body}"`
}

/** Inverse of execQuote (tests, and reading the command back from a file). */
export function execUnquote(word: string): string {
  const inner = word.replace(/^"/, '').replace(/"$/, '')
  return inner.replace(/\\(.)|\$\$|%%/g, (m, c: string | undefined) => {
    if (m === '$$') return '$'
    if (m === '%%') return '%'
    return c === 'n' ? '\n' : c === 't' ? '\t' : c!
  })
}

const markerOf = (s: TimerSpec) => MANAGED_MARKER + JSON.stringify({ ...s })

export function renderService(s: TimerSpec): string {
  const lines = [markerOf(s), '# Angelegt von Quadeck – bitte über Units → Timer bearbeiten.', '[Unit]', `Description=${pct(s.description || s.name)}`]
  if (s.network) lines.push('Wants=network-online.target', 'After=network-online.target')
  lines.push('', '[Service]', 'Type=oneshot')
  if (s.user) lines.push(`User=${s.user}`)
  if (s.workingDirectory) lines.push(`WorkingDirectory=${pct(s.workingDirectory)}`)
  if (s.lowPriority) lines.push('Nice=10', 'IOSchedulingClass=idle')
  lines.push(`ExecStart=/bin/sh -c ${execQuote(s.command)}`)
  return lines.join('\n') + '\n'
}

export function renderTimer(s: TimerSpec): string {
  const lines = ['# Angelegt von Quadeck – bitte über Units → Timer bearbeiten.', '[Unit]', `Description=Zeitplan: ${pct(s.description || s.name)}`, '', '[Timer]', `OnCalendar=${s.calendar}`]
  if (s.persistent) lines.push('Persistent=true')
  if (s.randomDelay) lines.push(`RandomizedDelaySec=${s.randomDelay}min`)
  lines.push('', '[Install]', 'WantedBy=timers.target')
  return lines.join('\n') + '\n'
}

/** Spec from a service file Quadeck wrote (undefined for foreign files). */
export function specFromService(content: string): TimerSpec | undefined {
  const line = content.split('\n')[0]
  if (!line?.startsWith(MANAGED_MARKER)) return undefined
  try {
    return parseSpec(JSON.parse(line.slice(MANAGED_MARKER.length)))
  } catch {
    return undefined
  }
}

export function overrideDropIn(calendar: string) {
  return `# Quadeck: eigener Zeitplan\n[Timer]\nOnCalendar=\nOnCalendar=${calendar}\n`
}

// ---------- schedule builder ----------

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
export type Day = (typeof DAYS)[number]
export const DAY_LABEL: Record<Day, string> = {
  Mon: 'Mo',
  Tue: 'Di',
  Wed: 'Mi',
  Thu: 'Do',
  Fri: 'Fr',
  Sat: 'Sa',
  Sun: 'So',
}

export type Schedule =
  | { kind: 'minutes'; every: number }
  | { kind: 'hours'; every: number; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: Day[]; time: string }
  | { kind: 'monthly'; day: number; time: string }
  | { kind: 'custom'; expr: string }

const two = (n: number) => String(n).padStart(2, '0')

/** "HH:MM" → "HH:MM:00" (or undefined when not a time). */
function clock(t: string) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined
  return `${two(Number(m[1]))}:${m[2]}:00`
}

/** Collapses Mon,Tue,Wed,Thu,Fri into Mon..Fri. */
function dayList(days: Day[]) {
  const idx = [...new Set(days)].map((d) => DAYS.indexOf(d)).sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < idx.length;) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1] === idx[j]! + 1) j++
    parts.push(
      j - i >= 2
        ? `${DAYS[idx[i]!]}..${DAYS[idx[j]!]}`
        : idx
            .slice(i, j + 1)
            .map((k) => DAYS[k])
            .join(','),
    )
    i = j + 1
  }
  return parts.join(',')
}

export function buildCalendar(s: Schedule): string {
  switch (s.kind) {
    case 'minutes':
      return s.every === 1 ? '*-*-* *:*:00' : `*-*-* *:00/${s.every}:00`
    case 'hours':
      return s.every === 1 ? `*-*-* *:${two(s.minute)}:00` : `*-*-* 00/${s.every}:${two(s.minute)}:00`
    case 'daily':
      return `*-*-* ${clock(s.time) ?? '00:00:00'}`
    case 'weekly':
      return `${dayList(s.days.length ? s.days : ['Mon'])} *-*-* ${clock(s.time) ?? '00:00:00'}`
    case 'monthly':
      return `*-*-${two(s.day)} ${clock(s.time) ?? '00:00:00'}`
    case 'custom':
      return s.expr.trim()
  }
}

function expandDays(spec: string): Day[] | undefined {
  const out: Day[] = []
  for (const part of spec.split(',')) {
    const r = part.split('..')
    const a = DAYS.indexOf(r[0] as Day)
    const b = r.length === 2 ? DAYS.indexOf(r[1] as Day) : a
    if (a < 0 || b < a || r.length > 2) return undefined
    for (let i = a; i <= b; i++) out.push(DAYS[i]!)
  }
  return out
}

/** Back from an expression to the builder; custom when it does not fit. */
export function parseCalendar(expr: string): Schedule {
  const e = expr.trim().replace(/\s+/g, ' ')
  const custom: Schedule = { kind: 'custom', expr: e }
  const named: Record<string, Schedule> = {
    minutely: { kind: 'minutes', every: 1 },
    hourly: { kind: 'hours', every: 1, minute: 0 },
    daily: { kind: 'daily', time: '00:00' },
    weekly: { kind: 'weekly', days: ['Mon'], time: '00:00' },
    monthly: { kind: 'monthly', day: 1, time: '00:00' },
  }
  if (named[e]) return named[e]
  const m = e.match(/^(?:([A-Za-z.,]+) )?(?:\*-\*-(\*|\d{1,2}) )?(\S+)$/)
  if (!m) return custom
  const [, dow, dom = '*', time] = m
  const t = time!.split(':')
  if (t.length < 2 || t.length > 3 || (t[2] !== undefined && !/^0?0$/.test(t[2]))) return custom
  const [h, mi] = t as [string, string]
  const num = (v: string) => (/^\d{1,2}$/.test(v) ? Number(v) : undefined)
  // Every N minutes / hours (no day restriction).
  if (!dow && dom === '*') {
    if (h === '*' && mi === '*') return { kind: 'minutes', every: 1 }
    const step = mi.match(/^0?0\/(\d{1,2})$/)
    if (h === '*' && step) return { kind: 'minutes', every: Number(step[1]) }
    if (h === '*' && num(mi) !== undefined) return { kind: 'hours', every: 1, minute: num(mi)! }
    const hstep = h.match(/^0?0\/(\d{1,2})$/)
    if (hstep && num(mi) !== undefined) return { kind: 'hours', every: Number(hstep[1]), minute: num(mi)! }
  }
  if (num(h) === undefined || num(mi) === undefined || num(h)! > 23 || num(mi)! > 59) return custom
  const hhmm = `${two(num(h)!)}:${two(num(mi)!)}`
  if (dow) {
    const days = dom === '*' ? expandDays(dow) : undefined
    return days ? { kind: 'weekly', days, time: hhmm } : custom
  }
  if (dom === '*') return { kind: 'daily', time: hhmm }
  const d = num(dom)
  return d && d <= 31 ? { kind: 'monthly', day: d, time: hhmm } : custom
}

/** Short German description ("täglich 03:30", "Mo–Fr 07:00", "alle 15 Minuten"). */
export function describeCalendar(expr: string | undefined): string {
  if (!expr) return '–'
  const s = parseCalendar(expr)
  switch (s.kind) {
    case 'minutes':
      return s.every === 1 ? 'jede Minute' : `alle ${s.every} Minuten`
    case 'hours':
      return s.every === 1 ? (s.minute ? `stündlich um :${two(s.minute)}` : 'stündlich') : `alle ${s.every} Stunden${s.minute ? ` um :${two(s.minute)}` : ''}`
    case 'daily':
      return `täglich ${s.time}`
    case 'weekly': {
      const days = s.days.length === 5 && !s.days.includes('Sat') && !s.days.includes('Sun') ? 'Mo–Fr' : s.days.length === 7 ? 'täglich' : s.days.map((d) => DAY_LABEL[d]).join(', ')
      return `${days} ${s.time}`
    }
    case 'monthly':
      return `monatlich am ${s.day}. um ${s.time}`
    case 'custom':
      return s.expr
  }
}

// ---------- cron ----------

const CRON_SPECIAL: Record<string, string> = {
  '@yearly': '*-01-01 00:00:00',
  '@annually': '*-01-01 00:00:00',
  '@monthly': '*-*-01 00:00:00',
  '@weekly': 'Sun *-*-* 00:00:00',
  '@daily': '*-*-* 00:00:00',
  '@midnight': '*-*-* 00:00:00',
  '@hourly': '*-*-* *:00:00',
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const CRON_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface CronResult {
  calendar?: string
  command?: string
  error?: string
  warning?: string
}

/** One cron field → systemd calendar component. */
function cronField(f: string, min: number, max: number, names?: string[]): string {
  const value = (v: string) => {
    const i = names?.indexOf(v.toLowerCase()) ?? -1
    const n = i >= 0 ? i + (names === MONTHS ? 1 : 0) : /^\d+$/.test(v) ? Number(v) : NaN
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Wert „${v}“ außerhalb ${min}–${max}`)
    return n
  }
  return f
    .split(',')
    .map((part) => {
      const [range, step] = part.split('/') as [string, string | undefined]
      if (step !== undefined && !/^\d+$/.test(step)) throw new Error(`Schritt „${step}“ ungültig`)
      let out: string
      if (range === '*') out = step ? two(min) : '*'
      else if (range.includes('-')) {
        const [a, b] = range.split('-') as [string, string]
        out = `${two(value(a))}..${two(value(b))}`
      } else out = two(value(range))
      return step ? `${out}/${Number(step)}` : out
    })
    .join(',')
}

function cronDays(f: string): string {
  const day = (v: string) => {
    const i = CRON_DAYS.indexOf(v.toLowerCase().slice(0, 3))
    const n = i >= 0 ? i : /^\d$/.test(v) ? Number(v) % 7 : NaN
    if (!Number.isInteger(n) || n > 6) throw new Error(`Wochentag „${v}“ ungültig`)
    return n
  }
  const name = (n: number) => DAYS[(n + 6) % 7]!
  return f
    .split(',')
    .map((part) => {
      if (part.includes('/')) throw new Error('Schritte bei Wochentagen kann systemd nicht')
      if (!part.includes('-')) return name(day(part))
      const [a, b] = part.split('-').map(day) as [number, number]
      // Sun is 0 in cron but last in systemd: 0-2 → Sun,Mon..Tue
      if (a === 0 && b > 0) return b === 1 ? 'Sun,Mon' : `Sun,Mon..${name(b)}`
      if (b === 0 && a > 0) return a === 6 ? 'Sat,Sun' : `${name(a)}..Sun`
      return `${name(a)}..${name(b)}`
    })
    .join(',')
}

/**
 * A crontab line ("30 3 * * 1-5 /usr/local/bin/backup.sh") → OnCalendar=
 * plus the command. Cron's day-of-month OR day-of-week rule has no systemd
 * equivalent (systemd needs both to match): that gives a warning.
 */
export function cronToCalendar(line: string): CronResult {
  const l = line.trim()
  if (!l) return { error: 'Leer' }
  const special = l.match(/^(@\w+)\s*(.*)$/)
  if (special) {
    if (special[1] === '@reboot')
      return {
        error: '@reboot ist kein Zeitplan – dafür passt eine Unit mit WantedBy=multi-user.target besser',
      }
    const cal = CRON_SPECIAL[special[1]!.toLowerCase()]
    return cal ? { calendar: cal, command: special[2] || undefined } : { error: `${special[1]} kennt cron nicht` }
  }
  const parts = l.split(/\s+/)
  if (parts.length < 5)
    return {
      error: 'Cron braucht fünf Felder: Minute Stunde Tag Monat Wochentag',
    }
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string]
  const command = l.match(/^(?:\S+\s+){4}\S+\s+([\s\S]+)$/)?.[1]?.trim() || undefined
  try {
    const days = dow === '*' || dow === '?' ? '' : cronDays(dow)
    const calendar = `${days ? days + ' ' : ''}*-${cronField(mon, 1, 12, MONTHS)}-${dom === '?' ? '*' : cronField(dom, 1, 31)} ${cronField(h, 0, 23)}:${cronField(mi, 0, 59)}:00`
    const warning = days && dom !== '*' && dom !== '?' ? 'Cron startet, wenn Tag ODER Wochentag passt – systemd verlangt beides. Bitte prüfen.' : undefined
    return { calendar, command, warning }
  } catch (e) {
    return { error: (e as Error).message }
  }
}
