// systemd timers: list with schedule, last result and command; Quadeck's own
// timers (service + timer in /etc/systemd/system); schedule overrides for
// every other timer via drop-in. SystemTimers runs where root is,
// FixtureTimers keeps demo data in memory.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { HttpError } from '../auth'
import { run, runOk } from '../exec'
import { writeFileAtomic } from '../atomic'
import { parseShow, parseTimestamp } from '../collectors/systemd'
import {
  CALENDAR,
  TIMER_ACTIONS,
  TIMER_BASE,
  TIMER_UNIT,
  overrideDropIn,
  parseSpec,
  renderService,
  renderTimer,
  specFromService,
  type CalendarPreview,
  type TimerAction,
  type TimerEntry,
  type TimerSpec,
  type TimersState,
} from '~/shared/timers'

export interface TimersAdmin {
  timersState(): Promise<TimersState>
  previewCalendar(expr: string): Promise<CalendarPreview>
  timerFiles(name: string): Promise<string>
}

/** Writes; the caller has checked the unlock. */
export interface TimersBackend extends TimersAdmin {
  saveTimer(spec: TimerSpec, previous: string | undefined, enable: boolean): Promise<TimersState>
  deleteTimer(name: string): Promise<TimersState>
  setTimerSchedule(name: string, calendar: string): Promise<TimersState>
  timerAction(name: string, action: TimerAction): Promise<TimersState>
}

export function assertTimerUnit(name: string) {
  if (!TIMER_UNIT.test(name) || name.startsWith('-')) throw new HttpError(400, msg(m.timers_error_invalidTimer, { name }))
}

export function assertCalendar(expr: string) {
  if (!CALENDAR.test(expr)) throw new HttpError(400, msg(m.quadlets_error_invalidSchedule))
}

/** Body of a save request (web app → helper). */
export function parseSave(v: unknown): {
  spec: TimerSpec
  previous?: string
  enable: boolean
} {
  const o = (v ?? {}) as Record<string, unknown>
  let spec: TimerSpec
  try {
    spec = parseSpec(o.spec)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
  const previous = typeof o.previous === 'string' && o.previous ? o.previous : undefined
  if (previous && !TIMER_BASE.test(previous)) throw new HttpError(400, msg(m.timers_error_invalidPrevious))
  return { spec, previous, enable: o.enable !== false }
}

export function parseTimerAction(v: unknown): TimerAction {
  if (!TIMER_ACTIONS.includes(v as TimerAction)) throw new HttpError(400, msg(m.timers_error_invalidAction))
  return v as TimerAction
}

/** All OnCalendar= of `TimersCalendar` ("{ OnCalendar=… ; next_elapse=… }" possibly several). */
export function calendarsOf(v: string | undefined): string[] {
  return [...(v ?? '').matchAll(/OnCalendar=([^;}]+)/g)].map((m) => m[1]!.trim())
}

/** `TimersMonotonic`: "{ OnBootUSec=15min ; next_elapse=… }" → "OnBootSec=15min". */
export function monotonicOf(v: string | undefined): string[] {
  return [...(v ?? '').matchAll(/(On\w+?)USec=([^;}]+)/g)].map((m) => `${m[1]}Sec=${m[2]!.trim()}`)
}

/** First command line of `ExecStart` ("{ path=… ; argv[]=/bin/sh -c … ; … }"). */
export function execOf(v: string | undefined): string | undefined {
  return v?.match(/argv\[\]=(.*?) ; (?:ignore_errors|start_time|stop_time|pid|code|status)=/)?.[1]?.trim() || undefined
}

/**
 * `systemd-analyze calendar --iterations=N`: normalized form and upcoming
 * times. The dates are printed in the host's local time, the same zone this
 * process uses.
 */
export function parseCalendarOutput(out: string): {
  normalized?: string
  next: number[]
} {
  const normalized = out.match(/Normalized form: (.+)/)?.[1]?.trim()
  const next: number[] = []
  for (const m of out.matchAll(/(?:Next elapse|Iteration #\d+): \w{3} (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/g)) {
    const [, y, mo, d, h, mi, s] = m.map(Number) as number[]
    next.push(new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime())
  }
  return { normalized, next }
}

const atomicWrite = (path: string, content: string) => writeFileAtomic(path, content, { mkdir: 0o755 })

/**
 * `systemd-analyze verify` on copies in a temp folder (its directory joins the unit search path,
 * so the timer finds its service): the real folder only gets units that passed. Returns the
 * complaints about these units; none when systemd-analyze is missing.
 */
export async function verifyUnits(files: { name: string; content: string }[]): Promise<string[]> {
  const tmp = mkdtempSync(join(tmpdir(), 'quadeck-timer-'))
  try {
    for (const f of files) writeFileSync(join(tmp, f.name), f.content)
    const verify = await run(['systemd-analyze', 'verify', '--', ...files.map((f) => join(tmp, f.name))], { timeoutMs: 60_000 })
    if (verify.code === 0 || verify.code === 127) return []
    return `${verify.stdout}\n${verify.stderr}`
      .split('\n')
      .filter((l) => files.some((f) => l.includes(f.name)))
      .map((l) => l.replaceAll(`${tmp}/`, ''))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export const OVERRIDE_FILE = '50-quadeck.conf'
const TIMER_PROPS = ['Id', 'Description', 'LoadState', 'UnitFileState', 'ActiveState', 'TimersCalendar', 'TimersMonotonic', 'NextElapseUSecRealtime', 'LastTriggerUSec', 'Unit', 'FragmentPath']
const SERVICE_PROPS = ['Id', 'ActiveState', 'Result', 'ExecMainStatus', 'ExecStart']

export class SystemTimers implements TimersBackend {
  constructor(private dir = process.env.QUADECK_UNIT_DIR || '/etc/systemd/system') {}

  private async show(names: string[], props: string[]) {
    if (!names.length) return new Map<string, Record<string, string>>()
    const args = props.flatMap((p) => ['-p', p])
    let r = await run(['systemctl', 'show', '--timestamp=unix', ...args, '--', ...names], { timeoutMs: 30_000 })
    if (r.code !== 0 && /timestamp/.test(r.stderr))
      r = await run(['systemctl', 'show', ...args, '--', ...names], {
        timeoutMs: 30_000,
      })
    return new Map(parseShow(r.stdout).map((o) => [o.Id!, o]))
  }

  /** Quadeck's own timers by base name. */
  private managed() {
    const out = new Map<string, { spec: TimerSpec; modified: boolean }>()
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.service'))
    } catch {
      return out
    }
    for (const f of files) {
      const svc = read(join(this.dir, f))
      const spec = svc ? specFromService(svc) : undefined
      if (!spec || `${spec.name}.service` !== f) continue
      const tmr = read(join(this.dir, `${spec.name}.timer`))
      out.set(spec.name, {
        spec,
        // Unchanged = exactly what Quadeck writes now, or what an older (German) version wrote.
        modified: !(svc === renderService(spec) && tmr === renderTimer(spec)) && !(svc === renderService(spec, true) && tmr === renderTimer(spec, true)),
      })
    }
    return out
  }

  private override(name: string) {
    const c = read(join(this.dir, `${name}.d`, OVERRIDE_FILE))
    return c?.match(/^OnCalendar=(.+)$/m)?.[1]?.trim()
  }

  async timersState(): Promise<TimersState> {
    const names = new Set<string>()
    const files = await run(['systemctl', 'list-unit-files', '--type=timer', '--no-legend', '--plain', '--no-pager'])
    const loaded = await run(['systemctl', 'list-units', '--type=timer', '--all', '--no-legend', '--plain', '--no-pager'])
    if (files.code !== 0 && loaded.code !== 0)
      return {
        timers: [],
        unitDir: this.dir,
        error: (files.stderr || loaded.stderr).trim() || msg(m.timers_error_noSystemctl),
      }
    for (const l of `${files.stdout}\n${loaded.stdout}`.split('\n')) {
      const n = l.trim().split(/\s+/)[0]
      if (n && n.endsWith('.timer') && !n.includes('@.') && TIMER_UNIT.test(n)) names.add(n)
    }
    const managed = this.managed()
    for (const base of managed.keys()) names.add(`${base}.timer`)
    const timers = await this.show([...names], TIMER_PROPS)
    const services = await this.show([...new Set([...timers.values()].map((t) => t.Unit).filter((u): u is string => !!u))], SERVICE_PROPS)
    const entries: TimerEntry[] = []
    for (const name of names) {
      const t = timers.get(name) ?? {}
      if (t.LoadState === 'not-found') continue
      const svc = t.Unit ? services.get(t.Unit) : undefined
      const m = managed.get(name.replace(/\.timer$/, ''))
      const exit = Number(svc?.ExecMainStatus)
      entries.push({
        name,
        service: t.Unit || undefined,
        description: t.Description && t.Description !== name ? t.Description : undefined,
        calendars: calendarsOf(t.TimersCalendar),
        monotonic: monotonicOf(t.TimersMonotonic),
        override: m ? undefined : this.override(name),
        managed: m?.spec,
        modified: m?.modified || undefined,
        command: m && !m.modified ? m.spec.command : execOf(svc?.ExecStart),
        enabled: t.UnitFileState === 'enabled',
        unitFileState: t.UnitFileState || undefined,
        active: t.ActiveState === 'active',
        next: parseTimestamp(t.NextElapseUSecRealtime),
        last: parseTimestamp(t.LastTriggerUSec),
        result: svc?.Result || undefined,
        exitStatus: svc?.ExecMainStatus && Number.isFinite(exit) ? exit : undefined,
        serviceActive: svc?.ActiveState || undefined,
        vendor: !m && !!t.FragmentPath && !t.FragmentPath.startsWith('/etc/'),
        path: t.FragmentPath || undefined,
      })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { timers: entries, unitDir: this.dir }
  }

  async previewCalendar(expr: string): Promise<CalendarPreview> {
    const e = expr.trim()
    if (!CALENDAR.test(e))
      return {
        ok: false,
        next: [],
        error: msg(m.timers_error_calendarChars),
      }
    const r = await run(['systemd-analyze', 'calendar', '--iterations=5', '--', e])
    if (r.code === 127) return { ok: false, next: [], error: msg(m.timers_error_noAnalyze) }
    if (r.code !== 0) {
      const reason = (r.stderr || r.stdout)
        .trim()
        .split('\n')[0]
        ?.replace(/^Failed to parse calendar specification '[^']*': /, '')
      return { ok: false, next: [], error: !reason || reason === 'Invalid argument' ? msg(m.timers_error_notUnderstood) : reason }
    }
    return { ok: true, ...parseCalendarOutput(r.stdout) }
  }

  async timerFiles(name: string) {
    assertTimerUnit(name)
    const svc = (await run(['systemctl', 'show', '-p', 'Unit', '--value', '--', name])).stdout.trim()
    const r = await run(['systemctl', 'cat', '--no-pager', '--', name, ...(svc && /^[\w:.\\@-]+$/.test(svc) ? [svc] : [])])
    if (!r.stdout.trim()) throw new HttpError(404, (r.stderr || msg(m.quadlets_error_notFound, { name })).trim())
    return r.stdout
  }

  private async reload() {
    await runOk(['systemctl', 'daemon-reload'], { timeoutMs: 60_000 })
  }

  private async loadState(unit: string) {
    return (await run(['systemctl', 'show', '-p', 'LoadState', '--value', '--', unit])).stdout.trim()
  }

  async saveTimer(spec: TimerSpec, previous: string | undefined, enable: boolean) {
    const check = await this.previewCalendar(spec.calendar)
    if (!check.ok) throw new HttpError(422, msg(m.timers_error_invalidSchedule, { error: check.error ?? '' }))
    if (spec.user && spec.user !== 'root' && (await run(['getent', 'passwd', spec.user])).code !== 0) throw new HttpError(422, msg(m.timers_error_userMissing, { user: spec.user }))
    if (spec.workingDirectory && !existsSync(spec.workingDirectory)) throw new HttpError(422, msg(m.timers_error_workDirMissing, { path: spec.workingDirectory }))
    const managed = this.managed()
    if (previous && !managed.has(previous)) throw new HttpError(404, msg(m.timers_error_notManaged, { previous }))
    if (!managed.has(spec.name) || (previous && previous !== spec.name)) {
      if (managed.has(spec.name)) throw new HttpError(409, msg(m.files_explorer_exists, { name: spec.name }))
      for (const u of [`${spec.name}.service`, `${spec.name}.timer`]) {
        const state = await this.loadState(u)
        if ((state && state !== 'not-found') || existsSync(join(this.dir, u))) throw new HttpError(409, msg(m.timers_error_unitExists, { unit: u }))
      }
    }
    const svcPath = join(this.dir, `${spec.name}.service`)
    const tmrPath = join(this.dir, `${spec.name}.timer`)
    const units = [
      { name: `${spec.name}.service`, content: renderService(spec) },
      { name: `${spec.name}.timer`, content: renderTimer(spec) },
    ]
    const complaints = await verifyUnits(units)
    if (complaints.length) throw new HttpError(422, msg(m.timers_error_unitRejected, { list: complaints.join(' · ') }))
    atomicWrite(svcPath, units[0]!.content)
    atomicWrite(tmrPath, units[1]!.content)
    if (previous && previous !== spec.name) {
      await run(['systemctl', 'disable', '--now', '--', `${previous}.timer`], {
        timeoutMs: 60_000,
      })
      rmSync(join(this.dir, `${previous}.service`), { force: true })
      rmSync(join(this.dir, `${previous}.timer`), { force: true })
    }
    await this.reload()
    await runOk(['systemctl', enable ? 'enable' : 'disable', '--now', '--', `${spec.name}.timer`], { timeoutMs: 60_000 })
    return this.timersState()
  }

  async deleteTimer(name: string) {
    const base = name.replace(/\.timer$/, '')
    if (!this.managed().has(base)) throw new HttpError(409, msg(m.timers_error_notDeletable, { name }))
    await run(['systemctl', 'disable', '--now', '--', `${base}.timer`], {
      timeoutMs: 60_000,
    })
    await run(['systemctl', 'stop', '--no-block', '--', `${base}.service`])
    rmSync(join(this.dir, `${base}.service`), { force: true })
    rmSync(join(this.dir, `${base}.timer`), { force: true })
    await this.reload()
    await run(['systemctl', 'reset-failed', '--', `${base}.service`])
    return this.timersState()
  }

  async setTimerSchedule(name: string, calendar: string) {
    assertTimerUnit(name)
    if (this.managed().has(name.replace(/\.timer$/, ''))) throw new HttpError(409, msg(m.timers_error_useEditor))
    const state = await this.loadState(name)
    if (state !== 'loaded') throw new HttpError(404, msg(m.quadlets_error_notFound, { name }))
    const path = join(this.dir, `${name}.d`, OVERRIDE_FILE)
    if (calendar) {
      const check = await this.previewCalendar(calendar)
      if (!check.ok) throw new HttpError(422, msg(m.timers_error_invalidSchedule, { error: check.error ?? '' }))
      atomicWrite(path, overrideDropIn(calendar))
    } else rmSync(path, { force: true })
    await this.reload()
    return this.timersState()
  }

  async timerAction(name: string, action: TimerAction) {
    assertTimerUnit(name)
    if (action === 'run') {
      const svc = (await run(['systemctl', 'show', '-p', 'Unit', '--value', '--', name])).stdout.trim()
      if (!svc || !/^[\w:.\\@-]+\.service$/.test(svc)) throw new HttpError(404, msg(m.timers_error_noService, { name }))
      await runOk(['systemctl', 'start', '--no-block', '--', svc], {
        timeoutMs: 30_000,
      })
    } else
      await runOk(['systemctl', action, '--now', '--', name], {
        timeoutMs: 60_000,
      })
    return this.timersState()
  }
}

// ---------- fixtures ----------

interface FixtureUnit {
  name: string
  description: string
  active: string
  result?: string
  exitStatus?: number
  unitFileState?: string
  timer?: { calendar?: string; next?: number; last?: number; unit?: string }
}

const FIXTURE_COMMANDS: Record<string, string> = {
  'restic-backup.service': '/usr/bin/restic backup /srv /home --exclude-caches',
  'snapraid-sync.service': '/usr/bin/snapraid sync',
  'podman-auto-update.service': '/usr/bin/podman auto-update',
  'backup-offsite.service': '/usr/local/bin/backup-offsite.sh',
}

const DEMO_SPEC: TimerSpec = {
  name: 'podman-cleanup',
  description: 'Remove old Podman images',
  command: 'podman image prune -af --filter until=168h',
  user: '',
  workingDirectory: '',
  calendar: 'Sun *-*-* 05:00:00',
  persistent: true,
  randomDelay: 0,
  lowPriority: true,
  network: false,
}

export class FixtureTimers implements TimersBackend {
  private entries = new Map<string, TimerEntry>()
  private real = !!Bun.which('systemd-analyze')
  /** Schedule before an override. */
  private originals = new Map<string, string>()

  constructor(dir: string) {
    const units = JSON.parse(readFileSync(join(dir, 'units.json'), 'utf8')) as FixtureUnit[]
    const byName = new Map(units.map((u) => [u.name, u]))
    for (const u of units) {
      if (!u.timer) continue
      const svc = u.timer.unit ? byName.get(u.timer.unit) : undefined
      this.entries.set(u.name, {
        name: u.name,
        service: u.timer.unit,
        description: svc?.description !== svc?.name ? svc?.description : undefined,
        calendars: u.timer.calendar ? [u.timer.calendar] : [],
        monotonic: [],
        command: u.timer.unit ? FIXTURE_COMMANDS[u.timer.unit] : undefined,
        enabled: u.unitFileState === 'enabled',
        unitFileState: u.unitFileState,
        active: u.active === 'active',
        next: u.timer.next,
        last: u.timer.last,
        result: svc?.result,
        exitStatus: svc?.exitStatus,
        serviceActive: svc?.active,
        vendor: u.name.startsWith('podman-'),
        path: u.name.startsWith('podman-') ? `/usr/lib/systemd/system/${u.name}` : `/etc/systemd/system/${u.name}`,
      })
    }
    this.put(DEMO_SPEC, true)
    const demo = this.entries.get(`${DEMO_SPEC.name}.timer`)!
    demo.last = Date.now() - 4 * 86_400_000
    demo.result = 'success'
    demo.exitStatus = 0
  }

  private put(spec: TimerSpec, enabled: boolean) {
    const name = `${spec.name}.timer`
    const old = this.entries.get(name)
    this.entries.set(name, {
      ...old,
      name,
      service: `${spec.name}.service`,
      description: spec.description || undefined,
      calendars: [spec.calendar],
      monotonic: [],
      managed: spec,
      command: spec.command,
      enabled,
      unitFileState: enabled ? 'enabled' : 'disabled',
      active: enabled,
      next: enabled ? Date.now() + 86_400_000 : undefined,
      vendor: false,
      path: `/etc/systemd/system/${name}`,
    })
  }

  private get(name: string) {
    assertTimerUnit(name)
    const e = this.entries.get(name)
    if (!e) throw new HttpError(404, msg(m.quadlets_error_notFound, { name }))
    return e
  }

  async timersState(): Promise<TimersState> {
    return {
      timers: structuredClone([...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name))),
      unitDir: '/etc/systemd/system',
    }
  }

  async previewCalendar(expr: string): Promise<CalendarPreview> {
    if (this.real) return new SystemTimers().previewCalendar(expr)
    return CALENDAR.test(expr.trim()) ? { ok: true, normalized: expr.trim(), next: [] } : { ok: false, next: [], error: msg(m.timers_error_invalid) }
  }

  async timerFiles(name: string) {
    const e = this.get(name)
    const spec = e.managed
    if (spec) return `# ${e.path}\n${renderTimer(spec)}\n# /etc/systemd/system/${e.service}\n${renderService(spec)}`
    const timer = `# ${e.path}\n[Unit]\nDescription=${e.description ?? e.name}\n\n[Timer]\nOnCalendar=${this.originals.get(name) ?? e.calendars[0] ?? 'daily'}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`
    const drop = e.override ? `\n# /etc/systemd/system/${name}.d/${OVERRIDE_FILE}\n${overrideDropIn(e.override)}` : ''
    const svc = e.service ? `\n# ${dirname(e.path ?? '/etc/systemd/system/x')}/${e.service}\n[Unit]\nDescription=${e.description ?? e.service}\n\n[Service]\nType=oneshot\nExecStart=${e.command ?? '/bin/true'}\n` : ''
    return timer + drop + svc
  }

  async saveTimer(spec: TimerSpec, previous: string | undefined, enable: boolean) {
    const check = await this.previewCalendar(spec.calendar)
    if (!check.ok) throw new HttpError(422, msg(m.timers_error_invalidSchedule, { error: check.error ?? '' }))
    if (previous && !this.entries.get(`${previous}.timer`)?.managed) throw new HttpError(404, msg(m.timers_error_notManaged, { previous }))
    const existing = this.entries.get(`${spec.name}.timer`)
    if (existing && (!existing.managed || (previous ?? '') !== spec.name)) throw new HttpError(409, msg(m.timers_error_timerExists, { name: spec.name }))
    if (previous && previous !== spec.name) this.entries.delete(`${previous}.timer`)
    this.put(spec, enable)
    return this.timersState()
  }

  async deleteTimer(name: string) {
    const e = this.get(name)
    if (!e.managed) throw new HttpError(409, msg(m.timers_error_notDeletable, { name }))
    this.entries.delete(name)
    return this.timersState()
  }

  async setTimerSchedule(name: string, calendar: string) {
    const e = this.get(name)
    if (e.managed) throw new HttpError(409, msg(m.timers_error_useEditor))
    if (calendar) {
      const check = await this.previewCalendar(calendar)
      if (!check.ok) throw new HttpError(422, msg(m.timers_error_invalidSchedule, { error: check.error ?? '' }))
    }
    if (!this.originals.has(name)) this.originals.set(name, e.calendars[0] ?? 'daily')
    e.override = calendar || undefined
    e.calendars = [calendar || this.originals.get(name)!]
    return this.timersState()
  }

  async timerAction(name: string, action: TimerAction) {
    const e = this.get(name)
    if (action === 'run') {
      e.last = Date.now()
      e.result = 'success'
      e.exitStatus = 0
      e.serviceActive = 'inactive'
    } else {
      e.enabled = e.active = action === 'enable'
      e.unitFileState = e.enabled ? 'enabled' : 'disabled'
      e.next = e.enabled ? (e.next ?? Date.now() + 86_400_000) : undefined
    }
    return this.timersState()
  }
}
