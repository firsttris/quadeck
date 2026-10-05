// Maintenance jobs (updates, removals, image updates): one at a time, output
// kept in memory for the live view. The work itself runs in `quadeck job`.

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { JobInfo, JobSpec, JobState } from '~/shared/packages'
import { localize, msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { HttpError } from '../auth'
import { run } from '../exec'
import { EXIT_MARKER, encodeSpec, jobTitle } from './job'

export interface JobSink {
  line(s: string): void
  exit(code: number): void
}

export interface Launcher {
  start(id: string, spec: JobSpec, sink: JobSink): Promise<void>
}

const MAX_LINES = 20_000
const KEEP_JOBS = 20
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** Splits a chunk stream into lines; a carriage return overwrites the line (progress bars). */
export function lineSplitter(emit: (l: string) => void) {
  let buf = ''
  const clean = (l: string) => l.replace(ANSI, '').split('\r').filter(Boolean).pop() ?? ''
  return {
    push(chunk: string) {
      buf += chunk
      const parts = buf.split('\n')
      buf = parts.pop()!
      for (const p of parts) emit(clean(p))
    },
    flush() {
      if (buf) emit(clean(buf))
      buf = ''
    },
  }
}

interface Job {
  info: JobInfo
  lines: string[]
}

export class JobManager {
  private jobs: Job[] = []

  /** onEnd runs as soon as a job is done (ok or failed), before anyone can see the new status. */
  constructor(
    private launcher: Launcher,
    private onEnd?: (job: JobInfo) => void,
  ) {}

  running() {
    return this.jobs.find((j) => j.info.status === 'running')?.info
  }

  async start(spec: JobSpec): Promise<JobInfo> {
    if (this.running()) throw new HttpError(409, msg(m.packages_error_jobBusy))
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const job: Job = { info: { id, spec, title: jobTitle(spec), status: 'running', startedAt: Date.now() }, lines: [] }
    this.jobs.unshift(job)
    this.jobs.splice(KEEP_JOBS)
    const sink: JobSink = {
      line: (s) => {
        if (job.info.status !== 'running') return
        if (s.startsWith(EXIT_MARKER)) return sink.exit(Number(s.slice(EXIT_MARKER.length)) || 0)
        if (job.lines.length < MAX_LINES) job.lines.push(s)
        else if (job.lines.length === MAX_LINES) job.lines.push(msg(m.packages_job_outputCut))
      },
      exit: (code) => {
        if (job.info.status !== 'running') return
        job.info = { ...job.info, status: code === 0 ? 'ok' : 'failed', exitCode: code, endedAt: Date.now() }
        this.onEnd?.(job.info)
      },
    }
    try {
      await this.launcher.start(id, spec, sink)
    } catch (e) {
      // Refused before anything ran (e.g. another job still active): no record.
      if (e instanceof HttpError) {
        this.jobs = this.jobs.filter((j) => j !== job)
        throw e
      }
      sink.line(msg(m.packages_job_error, { message: (e as Error).message }))
      sink.exit(1)
    }
    return job.info
  }

  list(): JobInfo[] {
    return this.jobs.map((j) => j.info)
  }

  get(id: string, from = 0): JobState | null {
    const j = this.jobs.find((x) => x.info.id === id)
    if (!j) return null
    const start = Math.max(0, Math.min(from, j.lines.length))
    return { ...j.info, lines: j.lines.slice(start), from: start, total: j.lines.length }
  }
}

/** How to start this binary again (compiled: itself; dev: bun + entry script). */
export function selfArgv(): string[] {
  if (process.env.QUADECK_SELF) return [process.env.QUADECK_SELF]
  return /^bun(-debug)?$/.test(basename(process.execPath)) ? [process.execPath, Bun.main] : [process.execPath]
}

const FORWARD_ENV = ['QUADECK_BACKUP_DIR', 'QUADECK_PACKAGE_MANAGER', 'QUADECK_AUR_USER', 'QUADECK_SHADOW', 'QUADECK_GROUP', 'QUADECK_FILE_ROOTS']

/** Child process of the helper (containers, systems without systemd-run). */
export class SpawnLauncher implements Launcher {
  async start(_id: string, spec: JobSpec, sink: JobSink) {
    const proc = Bun.spawn([...selfArgv(), 'job', encodeSpec(spec)], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const split = lineSplitter(sink.line)
      const dec = new TextDecoder()
      for await (const chunk of stream) split.push(dec.decode(chunk, { stream: true }))
      split.flush()
    }
    // Normally the exit marker has ended the job already; without it the job failed.
    void Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]).then(([, , code]) => sink.exit(code || 1))
  }
}

/**
 * Transient unit `quadeck-job-<id>.service`: keeps running when Quadeck or
 * its helper restarts during an update. Output is read back from the journal.
 */
export class SystemdLauncher implements Launcher {
  static available() {
    return existsSync('/run/systemd/system') && !!Bun.which('systemd-run') && process.env.QUADECK_JOB_LAUNCHER !== 'spawn'
  }

  async start(id: string, spec: JobSpec, sink: JobSink) {
    const unit = `quadeck-job-${id}.service`
    // A job from before a restart of the helper may still be running.
    const active = await run(['systemctl', 'list-units', '--plain', '--no-legend', '--state=active,activating', 'quadeck-job-*'])
    const other = active.stdout.trim().split(/\s+/)[0]
    if (other) throw new HttpError(409, msg(m.packages_error_jobRunning, { job: other }))
    const env = FORWARD_ENV.filter((k) => process.env[k]).map((k) => `--setenv=${k}=${process.env[k]}`)
    const r = await run(['systemd-run', `--unit=${unit}`, '--collect', '--quiet', `--description=Quadeck: ${localize(jobTitle(spec), 'en')}`, '--property=Type=exec', ...env, '--', ...selfArgv(), 'job', encodeSpec(spec)], {
      timeoutMs: 30_000,
    })
    if (r.code !== 0) throw new Error(`systemd-run: ${r.stderr.trim()}`)
    sink.line(msg(m.packages_job_runningAsUnit, { unit }))
    void this.follow(unit, sink)
  }

  private async follow(unit: string, sink: JobSink) {
    let cursor: string | undefined
    let done = false
    let inactivePolls = 0
    const wrapped: JobSink = {
      line: (l) => {
        if (l.startsWith(EXIT_MARKER)) done = true
        sink.line(l)
      },
      exit: sink.exit,
    }
    while (!done) {
      await Bun.sleep(700)
      const r = await run(['journalctl', `_SYSTEMD_UNIT=${unit}`, '-o', 'cat', '--no-pager', '--all', '--show-cursor', ...(cursor ? [`--after-cursor=${cursor}`] : [])], { timeoutMs: 15_000 })
      const lines = r.stdout.split('\n')
      const cur = lines.findLast((l) => l.startsWith('-- cursor: '))
      if (cur) cursor = cur.slice('-- cursor: '.length)
      const split = lineSplitter(wrapped.line)
      split.push(lines.filter((l) => !l.startsWith('-- cursor: ') && l !== '-- No entries --').join('\n') + '\n')
      if (done) break
      const active = (await run(['systemctl', 'is-active', unit])).stdout.trim()
      inactivePolls = active === 'active' || active === 'activating' ? 0 : inactivePolls + 1
      // Gone without the exit marker (killed, journal lost): give the journal a moment, then give up.
      if (inactivePolls >= 4) {
        sink.line(msg(m.packages_job_noResult, { unit, state: active || msg(m.packages_status_unknown) }))
        sink.exit(1)
        return
      }
    }
  }
}

export function defaultLauncher(): Launcher {
  return SystemdLauncher.available() ? new SystemdLauncher() : new SpawnLauncher()
}
