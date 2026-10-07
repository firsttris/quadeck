import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '~/lib/api'
import { msg } from '~/shared/i18n'
import type { JobInfo, JobSpec, JobState } from '~/shared/packages'
import { diagnoseJob, TERMINAL_COMMANDS, type Diagnosis } from '~/shared/job-diagnosis'
import { Link } from '@tanstack/react-router'
import { Spinner } from './Busy'
import { Glyph } from './Glyph'
import { Modal } from './Modal'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useUnlock } from './Unlock'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

interface Ctx {
  /** Unlocks if needed, starts the job and shows its output. */
  start: (spec: JobSpec) => Promise<JobInfo | null>
  /** Shows the output of an earlier job. */
  show: (id: string) => void
  running: JobInfo | null
  /** A job is being started (unlock done, request on its way): job buttons stay disabled. */
  starting: boolean
  /** Increments whenever a job ends (pages reload their data). */
  finished: number
}

const JobCtx = createContext<Ctx>({ start: async () => null, show: () => {}, running: null, starting: false, finished: 0 })
export const useJobs = () => useContext(JobCtx)

/** Job status labels (getters: the language is read on use). Components can also use t.shell.jobs.status. */
export const STATUS_LABEL: Record<JobInfo['status'], string> = {
  get running() {
    return msg(m.shell_jobs_status_running)
  },
  get ok() {
    return msg(m.shell_jobs_status_ok)
  },
  get failed() {
    return msg(m.shell_jobs_status_failed)
  },
}
export const statusTone = (s: JobInfo['status']) => (s === 'ok' ? 'ok' : s === 'failed' ? 'bad' : 'warn')

export function JobsProvider({ children }: { children: ReactNode }) {
  const unlock = useUnlock()
  const say = useToast()
  const [shown, setShown] = useState<string | null>(null)
  const [running, setRunning] = useState<JobInfo | null>(null)
  const [finished, setFinished] = useState(0)
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)

  // A job that was already running when the page loaded (or in another tab).
  useEffect(() => {
    fetch('/api/jobs')
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d: { jobs: JobInfo[] }) => setRunning(d.jobs.find((j) => j.status === 'running') ?? null))
      .catch(() => {})
  }, [])

  const start = useCallback(
    async (spec: JobSpec) => {
      if (startingRef.current) return null // a double click starts one job
      if (!(await unlock.ensure())) return null
      const call = () => api<JobInfo>('/api/jobs', { body: { spec } })
      startingRef.current = true
      setStarting(true)
      try {
        let job: JobInfo
        try {
          job = await call()
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 423)) throw e
          unlock.markLocked()
          if (!(await unlock.ensure())) return null
          job = await call()
        }
        setRunning(job)
        setShown(job.id)
        return job
      } catch (e) {
        say((e as Error).message, 'bad')
        return null
      } finally {
        startingRef.current = false
        setStarting(false)
      }
    },
    [unlock, say],
  )

  const onEnd = useCallback(
    (job: JobInfo) => {
      setRunning((r) => (r?.id === job.id ? null : r))
      setFinished((n) => n + 1)
      say(`${job.title}: ${pickMsg({ running: m.shell_jobs_status_running, ok: m.shell_jobs_status_ok, failed: m.shell_jobs_status_failed }, job.status)}`, job.status === 'ok' ? undefined : 'bad')
    },
    [say],
  )

  return (
    <JobCtx.Provider value={{ start, show: setShown, running, starting, finished }}>
      {children}
      {running && running.id !== shown && <JobWatcher id={running.id} onEnd={onEnd} />}
      <JobDialog id={shown} onClose={() => setShown(null)} onEnd={onEnd} />
    </JobCtx.Provider>
  )
}

/** Follows a job in the background (dialog closed) so its end is noticed. */
function JobWatcher({ id, onEnd }: { id: string; onEnd: (j: JobInfo) => void }) {
  useEffect(() => {
    let stop = false
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 2000))
        const r = await fetch(`/api/jobs/${id}?from=999999999`).catch(() => undefined)
        if (!r?.ok) continue
        const j = (await r.json()) as JobState
        if (j.status !== 'running') {
          if (!stop) onEnd(j)
          return
        }
      }
    }
    void tick()
    return () => {
      stop = true
    }
  }, [id, onEnd])
  return null
}

function lineClass(l: string) {
  if (l.startsWith('$ ')) return 'cmd'
  if (/^(error|fehler|e:|warning:|failed)/i.test(l)) return 'err'
  return undefined
}

export function JobDialog({ id, onClose, onEnd }: { id: string | null; onClose: () => void; onEnd: (j: JobInfo) => void }) {
  const [job, setJob] = useState<JobState | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState('')
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    setJob(null)
    setLines([])
    setError('')
    if (!id) return
    let stop = false
    let from = 0
    let wasRunning = false
    const poll = async () => {
      while (!stop) {
        try {
          const r = await fetch(`/api/jobs/${id}?from=${from}`)
          const data = (await r.json()) as JobState & { error?: string }
          if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
          if (stop) return
          if (data.lines.length) setLines((l) => [...l, ...data.lines])
          from = data.from + data.lines.length
          setJob(data)
          if (data.status === 'running') wasRunning = true
          else {
            if (wasRunning) onEnd(data)
            return
          }
        } catch (e) {
          setError((e as Error).message)
        }
        await new Promise((r) => setTimeout(r, 700))
      }
    }
    void poll()
    return () => {
      stop = true
    }
  }, [id, onEnd])

  useEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [lines])

  // a failed package job: what went wrong and the next step
  const diagnosis = useMemo(() => (job?.status === 'failed' && job.id === id ? diagnoseJob(job.spec, lines) : undefined), [job?.status, job?.id, job?.spec, id, lines])
  const marked = useMemo(() => new Set(diagnosis?.lines ?? []), [diagnosis])

  return (
    <Modal open={!!id} onClose={onClose} title={job?.title ?? 'Job'} wide>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        {job && <Pill tone={statusTone(job.status)}>{pickMsg({ running: m.shell_jobs_status_running, ok: m.shell_jobs_status_ok, failed: m.shell_jobs_status_failed }, job.status)}</Pill>}
        {job?.status === 'running' && <span>{m.shell_jobs_background()}</span>}
        {job?.exitCode !== undefined && job.status === 'failed' && <span>{m.shell_jobs_exitCode({ code: job.exitCode })}</span>}
      </div>
      <pre
        ref={pre}
        className="joblog"
        aria-label={m.shell_jobs_output()}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className={marked.has(i) ? 'hl' : lineClass(l)}>
            {l || ' '}
          </div>
        ))}
        {job?.status === 'running' && <div className="text-muted">…</div>}
      </pre>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      {job && diagnosis && <JobHint job={job} lines={lines} diagnosis={diagnosis} onClose={onClose} />}
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose} autoFocus>
          {job?.status === 'running' ? m.shell_jobs_keepRunning() : m.common_close()}
        </button>
      </div>
    </Modal>
  )
}

function hintText(d: Diagnosis): { title: string; body: string; tip?: string } {
  const a = d.a ?? ''
  const b = d.b ?? ''
  switch (d.kind) {
    case 'conflict':
      return { title: m.shell_jobs_hint_conflict_title({ a, b }), body: m.shell_jobs_hint_conflict_body({ a, b }), tip: m.shell_jobs_hint_conflict_tip() }
    case 'fileExists':
      return { title: m.shell_jobs_hint_fileExists_title({ a }), body: d.b ? m.shell_jobs_hint_fileExists_owned({ b }) : m.shell_jobs_hint_fileExists_body() }
    case 'signature':
      return { title: m.shell_jobs_hint_signature_title(), body: m.shell_jobs_hint_signature_body() }
    case 'aurSignature':
      return { title: m.shell_jobs_hint_aurSignature_title({ b: b || 'AUR' }), body: d.a ? m.shell_jobs_hint_aurSignature_key({ a }) : m.shell_jobs_hint_aurSignature_body() }
    case 'dbLock':
      return { title: m.shell_jobs_hint_dbLock_title(), body: m.shell_jobs_hint_dbLock_body({ a }), tip: m.shell_jobs_hint_dbLock_tip() }
    case 'dpkgBusy':
      return { title: m.shell_jobs_hint_dpkgBusy_title(), body: d.a ? m.shell_jobs_hint_dpkgBusy_body({ a }) : m.shell_jobs_hint_dpkgBusy_anon() }
    case 'dpkgInterrupted':
      return { title: m.shell_jobs_hint_dpkgInterrupted_title(), body: m.shell_jobs_hint_dpkgInterrupted_body() }
    case 'download':
      return { title: m.shell_jobs_hint_download_title(), body: m.shell_jobs_hint_download_body() }
    case 'diskFull':
      return { title: m.shell_jobs_hint_diskFull_title(), body: d.a ? m.shell_jobs_hint_diskFull_on({ a }) : m.shell_jobs_hint_diskFull_body() }
    case 'aurBuild':
      return { title: d.a ? m.shell_jobs_hint_aurBuild_title({ a }) : m.shell_jobs_hint_aurBuild_anon(), body: m.shell_jobs_hint_aurBuild_body(), tip: m.shell_jobs_hint_aurBuild_tip() }
    case 'unknown':
      return { title: m.shell_jobs_hint_unknown_title(), body: m.shell_jobs_hint_unknown_body() }
  }
}

/** Under a failed job: what the output says went wrong, and buttons for the next step. */
function JobHint({ job, lines, diagnosis: d, onClose }: { job: JobState; lines: string[]; diagnosis: Diagnosis; onClose: () => void }) {
  const { start, starting, running } = useJobs()
  const say = useToast()
  const text = hintText(d)
  const known = d.kind !== 'unknown'
  const errLines = d.lines.map((i) => lines[i]).filter((l): l is string => l !== undefined)
  return (
    <section aria-label={m.shell_jobs_hint_label()} data-testid="job-hint" className={`flex flex-col gap-2 rounded-[10px] border px-3.5 py-3 ${known ? 'border-[#5b2a2a] bg-[rgba(248,81,73,0.07)]' : 'border-edge bg-panel-2'}`}>
      <h3 className={`m-0 text-[14px] font-semibold ${known ? 'text-[#ff7b72]' : ''}`}>{text.title}</h3>
      <p className="m-0 text-[13px] text-[#c9d1d9]">
        {text.body}
        {d.unchanged && <b> {m.shell_jobs_hint_unchanged()}</b>}
      </p>
      {text.tip && <p className="m-0 text-[12px] text-muted">{text.tip}</p>}
      <div className="flex flex-wrap gap-2">
        {d.actions.map((a, i) => {
          const primary = i === 0 ? 'btn sm primary' : 'btn sm'
          switch (a.type) {
            case 'terminal':
              return (
                <Link key={i} to="/terminal" search={a.command ? { type: a.command } : {}} className={primary} onClick={onClose}>
                  {a.command ? m.shell_jobs_hint_terminalCmd({ cmd: TERMINAL_COMMANDS[a.command].argv }) : m.shell_jobs_hint_terminal()}
                </Link>
              )
            case 'link':
              return (
                <a key={i} href={a.href} target="_blank" rel="noreferrer" className={primary}>
                  {a.label === 'aurPage' ? m.shell_jobs_hint_aurPage({ name: d.a ?? '' }) : m.shell_jobs_hint_archNews()}
                </a>
              )
            case 'job':
              return (
                <button key={i} type="button" className={primary} disabled={starting || !!running} onClick={() => void start(a.spec)}>
                  {a.label === 'keyringRetry' ? m.shell_jobs_hint_keyringRetry() : a.spec.kind === 'pacman-unlock' && a.spec.retry ? m.shell_jobs_hint_unlockRetry() : m.shell_jobs_hint_unlock()}
                </button>
              )
            case 'retry':
              return (
                <button key={i} type="button" className={primary} disabled={starting || !!running} onClick={() => void start(job.spec)}>
                  {m.shell_jobs_hint_retry()}
                </button>
              )
            case 'cache':
              return (
                <Link key={i} to="/system" className={primary} onClick={onClose}>
                  {m.shell_jobs_hint_cache()}
                </Link>
              )
            case 'disks':
              return (
                <Link key={i} to="/disks" className={primary} onClick={onClose}>
                  {m.shell_jobs_hint_disks()}
                </Link>
              )
          }
        })}
        {errLines.length > 0 && (
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(errLines.join('\n'))
                .then(() => say(m.shell_jobs_hint_copied()))
                .catch(() => {})
            }
          >
            {m.shell_jobs_hint_copy()}
          </button>
        )}
      </div>
    </section>
  )
}

/** Sidebar hint while a job runs. */
export function JobChip({ compact = false }: { compact?: boolean }) {
  const { running, starting, show } = useJobs()
  if (!running) {
    if (!starting) return null
    return compact ? (
      <span className="grid h-10 w-10 place-items-center text-accent" aria-live="polite" aria-label={m.shell_jobs_starting()}>
        <Spinner />
      </span>
    ) : (
      <span className="btn mx-1 justify-start text-[12px]" aria-live="polite">
        <Spinner className="text-accent" />
        <span className="grow truncate text-left">{m.shell_jobs_starting()}</span>
      </span>
    )
  }
  if (compact) {
    return (
      <button type="button" className="grid h-10 w-10 place-items-center rounded-lg text-accent hover:bg-surface" onClick={() => show(running.id)} aria-label={m.shell_jobs_running({ title: running.title })} title={running.title}>
        <span className="animate-pulse">
          <Glyph name="terminal" size={19} strokeWidth={2} />
        </span>
      </button>
    )
  }
  return (
    <button type="button" className="jobchip btn mx-1 justify-start text-[12px]" onClick={() => show(running.id)}>
      <Glyph name="terminal" size={14} />
      <span className="grow truncate text-left">{running.title}</span>
      <span className="animate-pulse text-accent">{m.shell_jobs_runningShort()}</span>
    </button>
  )
}
