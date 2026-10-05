import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { memo, useEffect, useRef, useState } from 'react'
import { PageHeader } from '~/components/PageHeader'
import { clock } from '~/lib/format'
import { useLive } from '~/lib/live'
import type { JournalEntry } from '~/shared/types'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

// Labels come from t.journal.prio.
const PRIOS = [
  ['all', undefined],
  ['err', 3],
  ['warning', 4],
] as const
type Prio = (typeof PRIOS)[number][0]
const MAX_LINES = 1000
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 60_000

type Line = JournalEntry & { fresh?: boolean; id: number }

export const Route = createFileRoute('/_app/journal')({
  validateSearch: (s: Record<string, unknown>): { unit?: string; prio?: Prio } => ({
    unit: typeof s.unit === 'string' && s.unit ? s.unit : undefined,
    prio: PRIOS.some(([k]) => k === s.prio) ? (s.prio as Prio) : undefined,
  }),
  head: () => ({ meta: [{ title: 'Journal · Quadeck' }] }),
  component: Journal,
})

function lineClass(p: number) {
  return p <= 3 ? 'err' : p === 4 ? 'warning' : ''
}

function Journal() {
  const { snapshot } = useLive()
  const { unit, prio = 'all' } = Route.useSearch()
  const navigate = useNavigate({ from: '/journal' })
  const [lines, setLines] = useState<Line[]>([])
  const [live, setLive] = useState(true)
  const [status, setStatus] = useState<'connecting' | 'live' | 'paused' | 'error'>('connecting')
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const seq = useRef(0)
  const [attempt, setAttempt] = useState(0)
  // What a reconnect of the same view must not show twice, and how long to wait before the next try.
  const view = useRef('')
  const seen = useRef(new Set<string>())
  const delay = useRef(RETRY_MIN_MS)

  useEffect(() => {
    if (!live) {
      setStatus('paused')
      return
    }
    // A new unit/priority filter starts empty; a reconnect or "follow" again keeps what is shown.
    const key = `${unit ?? ''}|${prio}`
    if (view.current !== key) {
      view.current = key
      seen.current.clear()
      delay.current = RETRY_MIN_MS
      setLines([])
    }
    setStatus('connecting')
    const q = new URLSearchParams()
    if (unit) q.set('unit', unit)
    const p = PRIOS.find(([k]) => k === prio)?.[1]
    if (p !== undefined) q.set('priority', String(p))
    const es = new EventSource(`/api/journal?${q}`)
    let initial = true
    const settle = setTimeout(() => (initial = false), 1500)
    es.addEventListener('open', () => {
      setStatus('live')
      delay.current = RETRY_MIN_MS
    })
    // The backlog arrives as hundreds of events in a row: collect them and render once per frame.
    let pending: Line[] = []
    let frame: number | undefined
    const flush = () => {
      frame = undefined
      const add = pending
      pending = []
      setLines((l) => [...l, ...add].slice(-MAX_LINES))
    }
    es.addEventListener('entry', (e) => {
      const entry = JSON.parse((e as MessageEvent).data) as JournalEntry
      if (entry.cursor) {
        if (seen.current.has(entry.cursor)) return // replayed after a reconnect
        seen.current.add(entry.cursor)
        if (seen.current.size > 4 * MAX_LINES) seen.current = new Set([...seen.current].slice(-2 * MAX_LINES))
      }
      pending.push({ ...entry, fresh: !initial, id: seq.current++ })
      if (pending.length > MAX_LINES) pending = pending.slice(-MAX_LINES)
      frame ??= requestAnimationFrame(flush)
    })
    // EventSource would reconnect on its own and replay the backlog (duplicates):
    // close instead and start a fresh stream after a pause that grows while it keeps failing.
    let retry: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      es.close()
      setStatus('error')
      retry = setTimeout(() => setAttempt((a) => a + 1), delay.current)
      delay.current = Math.min(RETRY_MAX_MS, delay.current * 2)
    }
    es.addEventListener('end', stop)
    es.addEventListener('error', stop)
    return () => {
      clearTimeout(settle)
      clearTimeout(retry)
      if (frame !== undefined) cancelAnimationFrame(frame)
      es.close()
    }
  }, [unit, prio, live, attempt])

  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])

  // Units worth a quick filter chip: failed ones and container units.
  const chips = [...new Set([...snapshot.units.filter((u) => u.active === 'failed').map((u) => u.name), ...snapshot.containers.map((c) => c.unit).filter((x): x is string => !!x)])].slice(0, 8)
  if (unit && !chips.includes(unit)) chips.unshift(unit)
  const shown = query ? lines.filter((l) => l.message.toLowerCase().includes(query.toLowerCase()) || l.unit.toLowerCase().includes(query.toLowerCase())) : lines

  return (
    <>
      <PageHeader title="Journal" subtitle={m.journal_subtitle({ unit: unit ?? "", hasUnit: String(!!unit) })} />
      <div className="flex flex-wrap items-center gap-[10px]">
        <div role="group" aria-label={m.journal_unitGroup()} className="flex flex-wrap gap-1.5">
          <button type="button" className={`seg ${!unit ? 'on' : ''}`} onClick={() => navigate({ search: (s) => ({ ...s, unit: undefined }) })}>
            {m.journal_allUnits()}
          </button>
          {chips.map((u) => (
            <button key={u} type="button" className={`seg ${unit === u ? 'on' : ''}`} onClick={() => navigate({ search: (s) => ({ ...s, unit: u }) })}>
              {u.replace(/\.service$/, '')}
            </button>
          ))}
        </div>
        <span className="hidden h-[22px] w-px bg-[#2a323d] sm:block" />
        <div role="group" aria-label={m.journal_prioGroup()} className="flex gap-1.5">
          {PRIOS.map(([k]) => (
            <button key={k} type="button" className={`seg ${prio === k ? 'on' : ''}`} onClick={() => navigate({ search: (s) => ({ ...s, prio: k === 'all' ? undefined : k }) })}>
              {pickMsg({ "all": m.journal_prio_all, "err": m.journal_prio_err, "warning": m.journal_prio_warning }, k)}
            </button>
          ))}
        </div>
        <span className="grow" />
        <label className="sr-only" htmlFor="jsearch">
          {m.journal_fullText()}
        </label>
        <input id="jsearch" className="field !w-48 !py-1.5 text-[13px]" placeholder={m.journal_search()} value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className={`live ${status === 'live' ? '' : 'off'}`}>{pickMsg({ "live": m.journal_status_live, "paused": m.journal_status_paused, "error": m.journal_status_error, "connecting": m.journal_status_connecting }, status)}</span>
        <button type="button" className="btn sm" onClick={() => setLive(!live)}>
          {live ? m.journal_pause() : m.journal_follow()}
        </button>
      </div>
      <div
        ref={box}
        className="panel max-h-[calc(100vh-220px)] min-h-[300px] overflow-auto py-2"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        data-testid="journal"
      >
        {shown.length === 0 && <p className="m-0 px-4 py-2 text-[13px] text-muted">{status === 'connecting' ? m.journal_loading() : m.journal_empty()}</p>}
        {shown.map((l) => (
          <JournalLine key={l.id} line={l} />
        ))}
      </div>
    </>
  )
}

/** Lines never change once shown: only new ones render. */
const JournalLine = memo(function JournalLine({ line: l }: { line: Line }) {
  return (
    <div className={`jl ${lineClass(l.priority)} ${l.fresh ? 'new' : ''}`}>
      <span className="text-faint">{clock(l.ts)}</span>
      <span className="truncate text-accent">{l.unit}</span>
      <span className="m break-words whitespace-pre-wrap">{l.message}</span>
    </div>
  )
})
