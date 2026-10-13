// Journal → System: browse and search the whole journal (not only the live tail of the units):
// time range, boot, kernel / login messages, priority, unit or program, full-text search over the
// range, older pages by cursor and every field of one entry. `journalctl -o json -r`, newest first.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { m } from '~/paraglide/messages'
import { msg } from '~/shared/i18n'
import type { JournalBoot, JournalQuery, JournalQueryResult, JournalScope, SystemJournalEntry } from '~/shared/journal'
import { HttpError } from './auth'
import { config } from './config'
import { run } from './exec'

const UNIT = /^[A-Za-z0-9:_.\\@-]{1,240}$/
const IDENT = /^[A-Za-z0-9:_.@/+-]{1,120}$/
const BOOT_ID = /^[0-9a-f]{32}$/
const CURSOR = /^[A-Za-z0-9=;]{1,400}$/
export const PAGE = 200

/** Search text is literal: regex characters are escaped before it goes to --grep (PCRE2). */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const SCOPE_MATCHES: Record<JournalScope, string[]> = {
  all: [],
  kernel: ['_TRANSPORT=kernel'],
  // auth and authpriv: logins, sudo, sshd, polkit
  auth: ['SYSLOG_FACILITY=4', 'SYSLOG_FACILITY=10'],
}

const bad = (key: Parameters<typeof msg>[0]) => new HttpError(400, msg(key))

/** Validated query from URL parameters; anything odd is refused, nothing reaches journalctl unchecked. */
export function parseJournalQuery(q: URLSearchParams): JournalQuery {
  const scope = (q.get('scope') || 'all') as JournalScope
  if (!(scope in SCOPE_MATCHES)) throw bad(m.journal_error_invalidFilter)
  const out: JournalQuery = { scope }
  const boot = q.get('boot')
  if (boot) {
    if (!(BOOT_ID.test(boot) || /^-?\d{1,4}$/.test(boot))) throw bad(m.journal_error_invalidFilter)
    out.boot = boot
  }
  const since = q.get('since')
  if (since) {
    const n = Number(since)
    if (!Number.isInteger(n) || n < 1 || n > 60 * 24 * 366) throw bad(m.journal_error_invalidFilter)
    out.since = n
  }
  const prio = q.get('prio')
  if (prio) {
    const n = Number(prio)
    if (!Number.isInteger(n) || n < 0 || n > 7) throw bad(m.journal_error_invalidPriority)
    out.prio = n
  }
  const unit = q.get('unit')
  if (unit) {
    if (!UNIT.test(unit) || unit.startsWith('-')) throw bad(m.journal_error_invalidUnit)
    out.unit = unit
  }
  const ident = q.get('ident')
  if (ident) {
    if (!IDENT.test(ident) || ident.startsWith('-')) throw bad(m.journal_error_invalidFilter)
    out.ident = ident
  }
  const text = q.get('q')?.trim()
  if (text) {
    if (text.length > 200 || /[\x00-\x1f]/.test(text)) throw bad(m.journal_error_invalidFilter)
    out.q = text
  }
  const before = q.get('before')
  if (before) {
    if (!CURSOR.test(before)) throw bad(m.journal_error_invalidFilter)
    out.before = before
  }
  return out
}

/** journalctl arguments for one page, newest first. */
export function journalQueryArgs(query: JournalQuery, now = Date.now(), grep = true): string[] {
  const args = ['journalctl', '-o', 'json', '--no-pager', '-r', '-n', String(PAGE)]
  if (query.boot) args.push(`--boot=${query.boot}`)
  if (query.since) args.push(`--since=@${Math.floor((now - query.since * 60_000) / 1000)}`)
  if (query.prio !== undefined) args.push(`--priority=0..${query.prio}`)
  if (query.unit) args.push(`--unit=${query.unit}`)
  if (query.ident) args.push(`--identifier=${query.ident}`)
  // reverse: --after-cursor continues with the entries older than the last one shown
  if (query.before) args.push(`--after-cursor=${query.before}`)
  if (query.q && grep) args.push(`--grep=${escapeRegex(query.q)}`, '--case-sensitive=false')
  args.push(...SCOPE_MATCHES[query.scope])
  return args
}

const text = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return Buffer.from(v as number[]).toString('utf8') // binary-safe fields
  return v === undefined || v === null ? '' : String(v)
}

/** One line of `journalctl -o json`, with every field kept (for the detail view) as text. */
export function parseSystemEntry(line: string): (SystemJournalEntry & { fields: Record<string, string> }) | undefined {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  const fields = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, text(v)]))
  const ts = Math.floor(Number(o.__REALTIME_TIMESTAMP) / 1000)
  if (!Number.isFinite(ts)) return undefined
  return {
    ts,
    priority: Number(o.PRIORITY ?? 6),
    message: fields.MESSAGE ?? '',
    cursor: fields.__CURSOR ?? '',
    unit: fields._SYSTEMD_UNIT || fields.UNIT || undefined,
    ident: fields.SYSLOG_IDENTIFIER || fields._COMM || undefined,
    transport: fields._TRANSPORT || undefined,
    pid: fields._PID || undefined,
    fields,
  }
}

/** `journalctl --list-boots`: JSON (systemd ≥ 251) or the table of older versions. */
export function parseBoots(out: string): JournalBoot[] {
  const t = out.trim()
  if (t.startsWith('[')) {
    try {
      return (JSON.parse(t) as { index: number; boot_id: string; first_entry: number; last_entry: number }[]).map((b) => ({
        offset: b.index,
        id: b.boot_id,
        first: Math.floor(b.first_entry / 1000),
        last: Math.floor(b.last_entry / 1000),
      }))
    } catch {
      return []
    }
  }
  const boots: JournalBoot[] = []
  for (const l of t.split('\n')) {
    // " -1 <id> Mon 2024-01-01 10:00:00 UTC Mon 2024-01-01 12:00:00 UTC" (older ones put a dash between)
    const stamp = String.raw`\w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?: [A-Za-z+0-9]+)?`
    const hit = l.match(new RegExp(String.raw`^\s*(-?\d+)\s+([0-9a-f]{32})\s+(${stamp})\s*[—–-]*\s*(${stamp})\s*$`))
    if (!hit) continue
    const date = (s: string) => Date.parse(s.replace(/^\w{3} /, '').replace(/ [A-Z]{3,5}$/, ''))
    boots.push({ offset: Number(hit[1]), id: hit[2]!, first: date(hit[3]!), last: date(hit[4]!) })
  }
  return boots
}

// ---------- demo (fixtures) ----------

interface FixtureEntry {
  /** minutes before now */
  ago: number
  priority: number
  message: string
  unit?: string
  ident?: string
  transport?: string
  facility?: number
  boot?: number
}

function fixtureEntries(now: number): (SystemJournalEntry & { fields: Record<string, string>; boot: number; facility?: number })[] {
  let raw: FixtureEntry[] = []
  try {
    raw = JSON.parse(readFileSync(join(config().fixturesDir!, 'journal-system.json'), 'utf8'))
  } catch {
    return []
  }
  return raw
    .map((e, i) => {
      const ts = now - Math.round(e.ago * 60_000)
      // stable across requests, like a real cursor (the times move with "now")
      const cursor = `s=demo;i=${i.toString(16)};b=${e.boot === -1 ? 'p' : 'c'}`
      const fields: Record<string, string> = {
        MESSAGE: e.message,
        PRIORITY: String(e.priority),
        __CURSOR: cursor,
        __REALTIME_TIMESTAMP: String(ts * 1000),
        _HOSTNAME: 'nas-01',
        _TRANSPORT: e.transport ?? 'journal',
        ...(e.unit ? { _SYSTEMD_UNIT: e.unit } : {}),
        ...(e.ident ? { SYSLOG_IDENTIFIER: e.ident } : {}),
        ...(e.facility !== undefined ? { SYSLOG_FACILITY: String(e.facility) } : {}),
        _BOOT_ID: e.boot === -1 ? '8f2d0c41a6b94e0c9d1f3b7a5e6c2d10' : '3b1e9a7c5d2f4e6a8b0c1d2e3f4a5b6c',
      }
      return { ts, priority: e.priority, message: e.message, cursor, unit: e.unit, ident: e.ident, transport: e.transport ?? 'journal', fields, boot: e.boot ?? 0, facility: e.facility }
    })
    .sort((a, b) => b.ts - a.ts)
}

export const FIXTURE_BOOTS = (now: number): JournalBoot[] => [
  { offset: -1, id: '8f2d0c41a6b94e0c9d1f3b7a5e6c2d10', first: now - 9 * 86_400_000, last: now - 3 * 86_400_000 - 600_000 },
  { offset: 0, id: '3b1e9a7c5d2f4e6a8b0c1d2e3f4a5b6c', first: now - 3 * 86_400_000, last: now },
]

function fixtureQuery(query: JournalQuery, now: number): JournalQueryResult {
  let all = fixtureEntries(now)
  const boot = query.boot ? (BOOT_ID.test(query.boot) ? FIXTURE_BOOTS(now).find((b) => b.id === query.boot)?.offset : Number(query.boot)) : undefined
  all = all.filter(
    (e) =>
      (boot === undefined || e.boot === boot) &&
      (!query.since || e.ts >= now - query.since * 60_000) &&
      (query.prio === undefined || e.priority <= query.prio) &&
      (!query.unit || e.unit === query.unit || e.unit === `${query.unit}.service`) &&
      (!query.ident || e.ident === query.ident) &&
      (query.scope !== 'kernel' || e.transport === 'kernel') &&
      (query.scope !== 'auth' || e.facility === 4 || e.facility === 10) &&
      (!query.q || e.message.toLowerCase().includes(query.q.toLowerCase())),
  )
  const start = query.before ? all.findIndex((e) => e.cursor === query.before) + 1 : 0
  const page = all.slice(start, start + PAGE)
  return { entries: page.map(({ fields: _f, boot: _b, facility: _fa, ...e }) => e), more: start + PAGE < all.length }
}

// ---------- host ----------

async function readLines(args: string[], max: number, timeoutMs = 20_000): Promise<{ lines: string[]; error: string }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const lines: string[] = []
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true })
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        lines.push(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
      if (lines.length >= max) break
    }
    if (buf.trim() && lines.length < max) lines.push(buf)
  } finally {
    clearTimeout(timer)
    proc.kill()
  }
  const error = lines.length ? '' : (await new Response(proc.stderr).text()).trim()
  return { lines: lines.slice(0, max), error }
}

export async function queryJournal(query: JournalQuery, now = Date.now()): Promise<JournalQueryResult> {
  if (config().fixturesDir) return fixtureQuery(query, now)
  let r = await readLines(journalQueryArgs(query, now), PAGE)
  let filterHere = false
  // journalctl built without PCRE2: search the page here instead (only within what was read).
  if (!r.lines.length && query.q && /pattern|pcre/i.test(r.error)) {
    r = await readLines(journalQueryArgs(query, now, false), PAGE * 10)
    filterHere = true
  }
  if (!r.lines.length && r.error && !/-- No entries --/.test(r.error)) {
    // "No journal files", "Data from the specified boot is not available", a bad regex …
    if (/specified boot|boot id/i.test(r.error)) return { entries: [], more: false }
    throw new HttpError(422, r.error.split('\n')[0]!)
  }
  let entries = r.lines.map(parseSystemEntry).filter((e): e is NonNullable<typeof e> => !!e)
  if (filterHere) entries = entries.filter((e) => e.message.toLowerCase().includes(query.q!.toLowerCase())).slice(0, PAGE)
  return { entries: entries.map(({ fields: _f, ...e }) => e), more: r.lines.length >= PAGE }
}

export async function journalBoots(now = Date.now()): Promise<JournalBoot[]> {
  if (config().fixturesDir) return FIXTURE_BOOTS(now).sort((a, b) => b.offset - a.offset)
  let r = await run(['journalctl', '--list-boots', '--no-pager', '-o', 'json'], { timeoutMs: 20_000 })
  if (r.code !== 0 || !r.stdout.trim().startsWith('[')) r = await run(['journalctl', '--list-boots', '--no-pager'], { timeoutMs: 20_000 })
  return parseBoots(r.stdout).sort((a, b) => b.offset - a.offset)
}

/** Every field of one entry (detail view). */
export async function journalEntry(cursor: string, now = Date.now()): Promise<Record<string, string>> {
  if (!CURSOR.test(cursor)) throw bad(m.journal_error_invalidFilter)
  if (config().fixturesDir) {
    const e = fixtureEntries(now).find((x) => x.cursor === cursor)
    if (!e) throw new HttpError(404, msg(m.journal_error_entryNotFound))
    return e.fields
  }
  const r = await readLines(['journalctl', '-o', 'json', '--no-pager', `--cursor=${cursor}`], 1)
  const e = r.lines[0] ? parseSystemEntry(r.lines[0]) : undefined
  if (!e || e.cursor !== cursor) throw new HttpError(404, msg(m.journal_error_entryNotFound))
  return e.fields
}
