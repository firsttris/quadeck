import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '~/lib/api'
import { tr } from '~/shared/i18n'
import type { JobInfo, JobSpec, JobState } from '~/shared/packages'
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
  /** Increments whenever a job ends (pages reload their data). */
  finished: number
}

const JobCtx = createContext<Ctx>({ start: async () => null, show: () => {}, running: null, finished: 0 })
export const useJobs = () => useContext(JobCtx)

/** Job status labels (getters: the language is read on use). Components can also use t.shell.jobs.status. */
export const STATUS_LABEL: Record<JobInfo['status'], string> = {
  get running() {
    return tr('läuft', 'running')
  },
  get ok() {
    return tr('erfolgreich', 'succeeded')
  },
  get failed() {
    return tr('fehlgeschlagen', 'failed')
  },
}
export const statusTone = (s: JobInfo['status']) => (s === 'ok' ? 'ok' : s === 'failed' ? 'bad' : 'warn')

export function JobsProvider({ children }: { children: ReactNode }) {
  const unlock = useUnlock()
  const say = useToast()
  const [shown, setShown] = useState<string | null>(null)
  const [running, setRunning] = useState<JobInfo | null>(null)
  const [finished, setFinished] = useState(0)

  // A job that was already running when the page loaded (or in another tab).
  useEffect(() => {
    fetch('/api/jobs')
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d: { jobs: JobInfo[] }) => setRunning(d.jobs.find((j) => j.status === 'running') ?? null))
      .catch(() => {})
  }, [])

  const start = useCallback(
    async (spec: JobSpec) => {
      if (!(await unlock.ensure())) return null
      const call = () => api<JobInfo>('/api/jobs', { body: { spec } })
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
      }
    },
    [unlock, say],
  )

  const onEnd = useCallback(
    (job: JobInfo) => {
      setRunning((r) => (r?.id === job.id ? null : r))
      setFinished((n) => n + 1)
      say(`${job.title}: ${pickMsg({ "running": m.shell_jobs_status_running, "ok": m.shell_jobs_status_ok, "failed": m.shell_jobs_status_failed }, job.status)}`, job.status === 'ok' ? undefined : 'bad')
    },
    [say],
  )

  return (
    <JobCtx.Provider value={{ start, show: setShown, running, finished }}>
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

  return (
    <Modal open={!!id} onClose={onClose} title={job?.title ?? 'Job'} wide>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        {job && <Pill tone={statusTone(job.status)}>{pickMsg({ "running": m.shell_jobs_status_running, "ok": m.shell_jobs_status_ok, "failed": m.shell_jobs_status_failed }, job.status)}</Pill>}
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
          <div key={i} className={lineClass(l)}>
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
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose} autoFocus>
          {job?.status === 'running' ? m.shell_jobs_keepRunning() : m.common_close()}
        </button>
      </div>
    </Modal>
  )
}

/** Sidebar hint while a job runs. */
export function JobChip({ compact = false }: { compact?: boolean }) {
  const { running, show } = useJobs()
  if (!running) return null
  if (compact) {
    return (
      <button type="button" className="grid h-10 w-10 place-items-center rounded-lg text-accent hover:bg-[#161c24]" onClick={() => show(running.id)} aria-label={m.shell_jobs_running({ title: running.title })} title={running.title}>
        <span className="animate-pulse">
          <Glyph name="terminal" size={19} strokeWidth={2} />
        </span>
      </button>
    )
  }
  return (
    <button type="button" className="btn mx-1 justify-start text-[12px]" onClick={() => show(running.id)}>
      <Glyph name="terminal" size={14} />
      <span className="grow truncate text-left">{running.title}</span>
      <span className="animate-pulse text-accent">{m.shell_jobs_runningShort()}</span>
    </button>
  )
}
