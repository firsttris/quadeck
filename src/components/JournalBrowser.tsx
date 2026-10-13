import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pickMsg } from '~/i18n'
import { api } from '~/lib/api'
import { dateTime } from '~/lib/format'
import { useLiveState } from '~/lib/live'
import { m } from '~/paraglide/messages'
import { JOURNAL_PRIOS, JOURNAL_SCOPES, JOURNAL_SINCE, type JournalBoot, type JournalQueryResult, type JournalScope, journalSource, type SystemJournalEntry } from '~/shared/journal'
import { Spinner } from './Busy'
import { Modal } from './Modal'
import { useToast } from './Toast'

/** The filters of the system view; they live in the URL (shareable, back/forward). */
export interface SystemFilters {
  q?: string
  since?: number
  boot?: string
  scope?: JournalScope
  level?: number
  /** "u:<unit>" or "i:<program>" */
  src?: string
}

export const DEFAULT_SINCE = 1440
export const DEFAULT_LEVEL = 6

const UNIT_SUFFIX = /\.(service|socket|timer|mount|scope|slice|target|path|swap|device)$/
const BUCKETS = 48

const levelLabel = (p: number) =>
  pickMsg(
    {
      emerg: m.journal_level_emerg,
      alert: m.journal_level_alert,
      crit: m.journal_level_crit,
      err: m.journal_level_err,
      warning: m.journal_level_warning,
      notice: m.journal_level_notice,
      info: m.journal_level_info,
      debug: m.journal_level_debug,
    },
    JOURNAL_PRIOS[Math.min(7, Math.max(0, p))]!,
  )
const sinceLabel = (s: number) =>
  pickMsg({ '15': m.journal_sys_since_15, '60': m.journal_sys_since_60, '1440': m.journal_sys_since_1440, '10080': m.journal_sys_since_10080, '0': m.journal_sys_since_0 }, String(s))
const scopeLabel = (s: JournalScope) => pickMsg({ all: m.journal_sys_scope_all, kernel: m.journal_sys_scope_kernel, auth: m.journal_sys_scope_auth }, s)
const tone = (p: number) => (p <= 3 ? 'err' : p === 4 ? 'warning' : p === 5 ? 'notice' : p === 7 ? 'debug' : '')
const pad = (n: number) => String(n).padStart(2, '0')
const time = (ts: number) => {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const dayKey = (ts: number) => new Date(ts).toDateString()
function dayLabel(ts: number) {
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (dayKey(ts) === today.toDateString()) return m.journal_sys_today()
  if (dayKey(ts) === yesterday.toDateString()) return m.journal_sys_yesterday()
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
}

/** The search text marked in a message (case-insensitive, literal). */
function Highlight({ text, q }: { text: string; q?: string }) {
  if (!q) return <>{text}</>
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  for (let at = lower.indexOf(needle); at >= 0 && needle; at = lower.indexOf(needle, i)) {
    if (at > i) parts.push(text.slice(i, at))
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    i = at + needle.length
  }
  parts.push(text.slice(i))
  return <>{parts}</>
}

/** Journal → System: search and browse the whole journal. */
export function JournalBrowser({ filters, onChange }: { filters: SystemFilters; onChange: (f: SystemFilters) => void }) {
  const { snapshot } = useLiveState()
  const say = useToast()
  const since = filters.since ?? DEFAULT_SINCE
  const level = filters.level ?? DEFAULT_LEVEL
  const scope = filters.scope ?? 'all'
  const [text, setText] = useState(filters.q ?? '')
  const [source, setSource] = useState(filters.src?.slice(2) ?? '')
  const [entries, setEntries] = useState<SystemJournalEntry[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState<'new' | 'older' | null>('new')
  const [error, setError] = useState('')
  const [boots, setBoots] = useState<JournalBoot[]>([])
  const [open, setOpen] = useState<SystemJournalEntry | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  // Typing searches after a short pause; the URL follows.
  useEffect(() => setText(filters.q ?? ''), [filters.q])
  useEffect(() => setSource(filters.src?.slice(2) ?? ''), [filters.src])
  useEffect(() => {
    if (text === (filters.q ?? '')) return
    const t = setTimeout(() => onChange({ ...filters, q: text.trim() || undefined }), 350)
    return () => clearTimeout(t)
  }, [text, filters, onChange])

  // "/" jumps to the search field.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== '/' || e.ctrlKey || e.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return
      e.preventDefault()
      search.current?.focus()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  useEffect(() => {
    api<JournalBoot[]>('/api/journal-system?boots', { method: 'GET' })
      .then(setBoots)
      .catch(() => setBoots([]))
  }, [])

  const params = useCallback(
    (before?: string) => {
      const p = new URLSearchParams({ scope })
      if (since) p.set('since', String(since))
      if (filters.boot) p.set('boot', filters.boot)
      p.set('prio', String(level))
      if (filters.src?.startsWith('u:')) p.set('unit', filters.src.slice(2))
      if (filters.src?.startsWith('i:')) p.set('ident', filters.src.slice(2))
      if (filters.q) p.set('q', filters.q)
      if (before) p.set('before', before)
      return p
    },
    [scope, since, level, filters.boot, filters.src, filters.q],
  )

  const load = useCallback(
    async (older = false) => {
      const id = ++request.current
      setLoading(older ? 'older' : 'new')
      setError('')
      try {
        const r = await api<JournalQueryResult>(`/api/journal-system?${params(older ? entries.at(-1)?.cursor : undefined)}`, { method: 'GET' })
        if (id !== request.current) return // a newer filter was asked for meanwhile
        setEntries((prev) => (older ? [...prev, ...r.entries] : r.entries))
        setMore(r.more)
      } catch (e) {
        if (id !== request.current) return
        setError((e as Error).message)
        if (!older) setEntries([])
      } finally {
        if (id === request.current) setLoading(null)
      }
    },
    [params, entries],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search whenever the filters change
  useEffect(() => {
    void load(false)
  }, [params])

  const set = (patch: Partial<SystemFilters>) => onChange({ ...filters, ...patch })
  const applySource = (raw: string) => {
    const v = raw.trim()
    if (!v) return set({ src: undefined })
    const isUnit = UNIT_SUFFIX.test(v) || snapshot.units.some((u) => u.name === v)
    set({ src: `${isUnit ? 'u' : 'i'}:${v}` })
  }
  const filterBy = (e: SystemJournalEntry) => {
    if (e.transport === 'kernel') return set({ scope: 'kernel', src: undefined })
    set({ src: e.unit ? `u:${e.unit}` : e.ident ? `i:${e.ident}` : undefined })
  }
  const active = !!(filters.q || filters.src || filters.boot || scope !== 'all' || since !== DEFAULT_SINCE || level !== DEFAULT_LEVEL)

  const errors = entries.filter((e) => e.priority <= 3).length
  const warnings = entries.filter((e) => e.priority === 4).length
  const suggestions = useMemo(
    () => [...new Set([...snapshot.units.map((u) => u.name), ...entries.map((e) => e.ident).filter((x): x is string => !!x)])].sort().slice(0, 400),
    [snapshot.units, entries],
  )

  // Distribution over time of what is loaded: errors red, warnings yellow, the rest in the accent.
  const timeline = useMemo(() => {
    if (entries.length < 2) return null
    const end = since ? Date.now() : entries[0]!.ts
    const start = since && !more ? end - since * 60_000 : entries.at(-1)!.ts
    const span = Math.max(1, end - start)
    const b = Array.from({ length: BUCKETS }, (_, i) => ({ from: start + (i * span) / BUCKETS, to: start + ((i + 1) * span) / BUCKETS, err: 0, warn: 0, rest: 0 }))
    for (const e of entries) {
      const x = b[Math.min(BUCKETS - 1, Math.max(0, Math.floor(((e.ts - start) / span) * BUCKETS)))]!
      if (e.priority <= 3) x.err++
      else if (e.priority === 4) x.warn++
      else x.rest++
    }
    return { buckets: b, top: Math.max(1, ...b.map((x) => x.err + x.warn + x.rest)) }
  }, [entries, since, more])

  return (
    <div className="flex flex-col gap-3">
      <section className="panel flex flex-col gap-3 p-[14px]" aria-label={m.journal_sys_filters()}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] grow">
            <label className="sr-only" htmlFor="sys-q">
              {m.journal_fullText()}
            </label>
            <input
              id="sys-q"
              ref={search}
              type="search"
              className="field !pl-9"
              placeholder={m.journal_sys_search()}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && set({ q: text.trim() || undefined })}
            />
            <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 fill-none stroke-current text-muted" strokeWidth={2}>
              <path d="M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-3.5-3.5" />
            </svg>
          </div>
          <div role="group" aria-label={m.journal_sys_since()} className="flex flex-wrap gap-1.5">
            {JOURNAL_SINCE.map((s) => (
              <button key={s} type="button" className={`seg ${since === s ? 'on' : ''}`} aria-pressed={since === s} onClick={() => set({ since: s === DEFAULT_SINCE ? undefined : s })}>
                {sinceLabel(s)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div role="group" aria-label={m.journal_sys_scope()} className="flex flex-wrap gap-1.5">
            {JOURNAL_SCOPES.map((s) => (
              <button key={s} type="button" className={`seg ${scope === s ? 'on' : ''}`} aria-pressed={scope === s} onClick={() => set({ scope: s === 'all' ? undefined : s })}>
                {scopeLabel(s)}
              </button>
            ))}
          </div>
          <label className="flex min-w-[200px] grow flex-col gap-1 text-[12px] text-muted sm:grow-0">
            {m.journal_sys_source()}
            <input
              className="field !py-1.5 text-[13px]"
              list="sys-sources"
              placeholder={m.journal_sys_sourcePlaceholder()}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySource(source)}
              onBlur={() => source !== (filters.src?.slice(2) ?? '') && applySource(source)}
            />
            <datalist id="sys-sources">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            {m.journal_sys_level()}
            <select className="field !w-auto !py-1.5 text-[13px]" value={level} onChange={(e) => set({ level: Number(e.target.value) === DEFAULT_LEVEL ? undefined : Number(e.target.value) })}>
              {JOURNAL_PRIOS.map((name, p) => (
                <option key={name} value={p}>
                  {levelLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            {m.journal_sys_boot()}
            <select className="field !w-auto max-w-[18rem] !py-1.5 text-[13px]" value={filters.boot ?? ''} onChange={(e) => set({ boot: e.target.value || undefined })}>
              <option value="">{m.journal_sys_boot_all()}</option>
              {boots.map((b) => (
                <option key={b.id} value={String(b.offset)}>
                  {b.offset === 0 ? m.journal_sys_boot_current({ since: dateTime(b.first) }) : m.journal_sys_boot_earlier({ offset: String(b.offset), from: dateTime(b.first), to: dateTime(b.last) })}
                </option>
              ))}
            </select>
          </label>
          <span className="grow" />
          <div className="flex gap-2">
            {active && (
              <button type="button" className="btn sm" onClick={() => onChange({})}>
                {m.journal_sys_reset()}
              </button>
            )}
            <button type="button" className="btn sm" onClick={() => void load(false)} disabled={!!loading}>
              {m.journal_sys_refresh()}
            </button>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted" aria-live="polite">
        {loading === 'new' ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner />
            {m.journal_sys_loading()}
          </span>
        ) : (
          <>
            <span data-testid="sys-count">{m.journal_sys_count({ count: String(entries.length), more: String(more) })}</span>
            {errors > 0 && <span className="text-[#ff8a80]">{m.journal_sys_errors({ count: String(errors) })}</span>}
            {warnings > 0 && <span className="text-[#e3b341]">{m.journal_sys_warnings({ count: String(warnings) })}</span>}
          </>
        )}
        {filters.src && (
          <span className="chip q inline-flex items-center gap-1.5">
            {m.journal_sys_sourceChip({ name: filters.src.slice(2) })}
            <button type="button" className="cursor-pointer" aria-label={m.journal_sys_removeFilter({ name: filters.src.slice(2) })} onClick={() => set({ src: undefined })}>
              ×
            </button>
          </span>
        )}
      </div>

      {timeline && (
        <div className="flex h-10 items-end gap-px" role="img" aria-label={m.journal_sys_timeline()} data-testid="sys-timeline">
          {timeline.buckets.map((b) => {
            const n = b.err + b.warn + b.rest
            return (
              <div
                key={b.from}
                className="flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-t-[2px] bg-line/40"
                style={{ height: `${Math.max(4, (n / timeline.top) * 100)}%` }}
                title={m.journal_sys_bucket({ from: dateTime(b.from), to: dateTime(b.to), count: String(n), errors: String(b.err) })}
              >
                <span className="block bg-accent/50" style={{ height: `${(b.rest / Math.max(1, n)) * 100}%` }} />
                <span className="block bg-[#e3b341]" style={{ height: `${(b.warn / Math.max(1, n)) * 100}%` }} />
                <span className="block bg-[#ff8a80]" style={{ height: `${(b.err / Math.max(1, n)) * 100}%` }} />
              </div>
            )
          })}
        </div>
      )}

      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}

      <div className="panel overflow-hidden" role="list" aria-label={m.journal_sys_entries()} data-testid="sys-journal">
        {!loading && !error && entries.length === 0 && (
          <div className="flex flex-col items-start gap-2 px-4 py-6 text-[13px] text-muted">
            <span>{m.journal_sys_empty()}</span>
            {active && (
              <button type="button" className="btn sm" onClick={() => onChange({})}>
                {m.journal_sys_reset()}
              </button>
            )}
          </div>
        )}
        {entries.map((e, i) => (
          <Fragment key={e.cursor}>
            {(i === 0 || dayKey(entries[i - 1]!.ts) !== dayKey(e.ts)) && (
              <div className="sticky top-0 z-[1] border-b border-line bg-panel px-4 py-1.5 text-[11px] font-semibold tracking-[.06em] text-muted uppercase" role="presentation">
                {dayLabel(e.ts)}
              </div>
            )}
            <div role="listitem" className={`sj ${tone(e.priority)}`} data-testid="sys-entry">
              <span className="sj-time text-faint">{time(e.ts)}</span>
              <span className={`sj-prio ${tone(e.priority)}`}>{levelLabel(e.priority)}</span>
              <button type="button" className="sj-src truncate text-left text-accent hover:underline" title={m.journal_sys_filterSource({ name: journalSource(e) })} onClick={() => filterBy(e)}>
                {journalSource(e)}
              </button>
              <button type="button" className="sj-msg text-left" onClick={() => setOpen(e)} aria-label={m.journal_sys_openEntry({ time: time(e.ts) })}>
                <Highlight text={e.message} q={filters.q} />
              </button>
            </div>
          </Fragment>
        ))}
        {more && (
          <div className="flex justify-center border-t border-line p-3">
            <button type="button" className="btn sm" onClick={() => void load(true)} disabled={!!loading}>
              {loading === 'older' && <Spinner />}
              {m.journal_sys_older()}
            </button>
          </div>
        )}
      </div>

      {open && (
        <EntryDialog
          entry={open}
          onClose={() => setOpen(null)}
          onFilter={() => {
            filterBy(open)
            setOpen(null)
          }}
          onCopied={() => say(m.journal_sys_copied())}
        />
      )}
    </div>
  )
}

/** Every field of one entry; the usual ones on top. */
function EntryDialog({ entry, onClose, onFilter, onCopied }: { entry: SystemJournalEntry; onClose: () => void; onFilter: () => void; onCopied: () => void }) {
  const [fields, setFields] = useState<Record<string, string> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<{ fields: Record<string, string> }>(`/api/journal-system?entry=${encodeURIComponent(entry.cursor)}`, { method: 'GET' })
      .then((r) => setFields(r.fields))
      .catch((e: Error) => setError(e.message))
  }, [entry.cursor])
  const head: [string, string | undefined][] = [
    [m.journal_sys_field_time(), dateTime(entry.ts)],
    [m.journal_sys_field_priority(), `${levelLabel(entry.priority)} (${entry.priority})`],
    [m.journal_sys_field_source(), journalSource(entry)],
    ['Unit', entry.unit],
    [m.journal_sys_field_program(), entry.ident],
    ['PID', entry.pid ?? fields?._PID],
    ['Boot', fields?._BOOT_ID],
  ]
  return (
    <Modal open title={m.journal_sys_detailTitle()} onClose={onClose} wide>
      <pre
        className={`m-0 rounded-[8px] border border-line bg-surface p-3 font-mono text-[12.5px] whitespace-pre-wrap break-words ${entry.priority <= 3 ? 'text-[#ff8a80]' : entry.priority === 4 ? 'text-[#e3b341]' : ''}`}
      >
        {entry.message}
      </pre>
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
        {head
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="m-0 font-mono break-all">{v}</dd>
            </Fragment>
          ))}
      </dl>
      <details>
        <summary className="cursor-pointer text-[13px] text-muted">{m.journal_sys_fields()}</summary>
        {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
        {!fields && !error && <Spinner />}
        {fields && (
          <table className="tbl mt-2">
            <tbody>
              {Object.entries(fields)
                .sort(([a], [b]) => a.replace(/^_+/, '').localeCompare(b.replace(/^_+/, '')))
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="font-mono text-[12px] text-muted">{k}</td>
                    <td className="font-mono text-[12px] break-all">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </details>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(entry.message)
              .then(onCopied)
              .catch(() => {})
          }
        >
          {m.journal_sys_copy()}
        </button>
        <button type="button" className="btn" onClick={onFilter}>
          {m.journal_sys_filterSource({ name: journalSource(entry) })}
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          {m.common_close()}
        </button>
      </div>
    </Modal>
  )
}
