// Quadlet files and Podman settings. SystemPodmanAdmin works on the host (root
// helper or single root process); FixturePodmanAdmin keeps demo data in memory.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { lineOf, lintQuadlet, parseIni } from '~/shared/ini'
import { QUADLET_SECTION } from '~/shared/quadlet-keys'
import {
  EDITABLE_CONFIGS,
  QUADLET_NAME,
  assertQuadletName,
  quadletType,
  quadletUnit,
  type Diagnostic,
  type PodmanConfigFile,
  type PodmanConfigName,
  type PodmanSettings,
  removalPlan,
  type QuadletFile,
  type RemovalPlan,
  type Revision,
  type ValidateResult,
} from '~/shared/quadlets'
import { HttpError } from '../auth'
import { calendarOf } from '../collectors/systemd'
import { run, runOk } from '../exec'

export interface PodmanAdmin {
  quadlets(): Promise<QuadletFile[]>
  readQuadlet(name: string): Promise<string>
  removalPlan(name: string): Promise<RemovalPlan>
  validateQuadlet(name: string, content: string): Promise<ValidateResult>
  quadletHistory(name: string): Promise<Revision[]>
  quadletRevision(name: string, id: string): Promise<string>
  podmanSettings(): Promise<PodmanSettings>
}

/** Delete dialog: also remove the image and the named volumes (never host directories). */
export interface RemoveAlso {
  image?: boolean
  volumes?: boolean
}

export interface WriteResult {
  unit: string
  restarted: boolean
  /** Restart failed etc. (the file is saved anyway). */
  warning?: string
}

/** Writes; the caller has checked the unlock. */
export interface PodmanAdminBackend extends PodmanAdmin {
  writeQuadlet(name: string, content: string, restart: boolean): Promise<WriteResult>
  deleteQuadlet(name: string, also?: RemoveAlso): Promise<{ warnings: string[] }>
  setAutoUpdateTimer(enabled: boolean, calendar: string): Promise<void>
  setAutoUpdateDefault(enabled: boolean): Promise<void>
  writePodmanConfig(name: PodmanConfigName, content: string): Promise<void>
}

const MAX_FILE = 256 * 1024
const TIMER = 'podman-auto-update.timer'
const CALENDAR = /^[A-Za-z0-9 *:,./~-]{1,80}$/

export function validName(name: string) {
  try {
    assertQuadletName(name)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
}

export function validContent(content: string) {
  if (typeof content !== 'string') throw new HttpError(400, msg(m.quadlets_error_contentMissing))
  if (content.length > MAX_FILE) throw new HttpError(413, msg(m.quadlets_error_fileTooLarge))
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(content)) throw new HttpError(400, msg(m.quadlets_error_controlChars))
}

export function validCalendar(cal: string) {
  if (cal && !CALENDAR.test(cal)) throw new HttpError(400, msg(m.quadlets_error_invalidSchedule))
}

/** Lint + generator messages mapped to lines. */
export function generatorDiagnostics(stderr: string, file: string, content: string): Diagnostic[] {
  const base = file.split('/').pop()!
  const section = QUADLET_SECTION[quadletType(file)]
  const out: Diagnostic[] = []
  for (const raw of stderr.split('\n')) {
    const l = raw.trim()
    if (!l || !l.includes(base)) continue
    const msg = l.replace(/^quadlet-generator\[\d+\]:\s*/, '').replace(/ in \/\S+/g, '')
    if (/^Loading source unit file/i.test(msg)) continue // progress output
    const key = l.match(/unsupported key '([^']+)' in group '([^']+)'/)
    const warning = /^warning:/i.test(msg)
    out.push({ severity: warning ? 'warning' : 'error', line: key ? lineOf(content, key[2]!, key[1]!) : undefined, message: `Generator: ${msg.replace(/^warning:\s*/i, '')}` })
  }
  return out
}

/** Picks the generated unit out of `quadlet -dryrun` output ("---name.service---"). */
export function generatedUnit(stdout: string, unit: string): string | undefined {
  const parts = stdout.split(/^---(.+)---$/m)
  for (let i = 1; i < parts.length; i += 2) if (parts[i] === unit) return parts[i + 1]!.trim()
  return undefined
}

/** Network=x.network, Volume=x.volume:/data, Pod=x.pod pointing at files that do not exist. */
export function missingReferences(content: string, name: string, files: string[]): Diagnostic[] {
  const base = new Set(files.map((f) => f.split('/').pop()!))
  base.add(name.split('/').pop()!)
  const out: Diagnostic[] = []
  for (const e of parseIni(content)) {
    if (e.kind !== 'kv' || !['Network', 'Volume', 'Pod'].includes(e.key!)) continue
    const ref = e.value!.split(':')[0]!
    if (/\.(network|volume|pod)$/.test(ref) && !base.has(ref)) out.push({ line: e.start + 1, severity: 'warning', message: msg(m.quadlets_lint_refMissing, { ref }) })
  }
  return out
}

/**
 * History entries are committed in English (versions before 0.4 wrote German
 * ones); either way they are shown in the viewer's language.
 */
export function commitLabel(message: string): string {
  if (message === 'Initial state' || message === 'Ausgangszustand') return msg(m.quadlets_history_initial)
  const all = message.match(/^(?:Auto-update for all containers (on|off)|Auto-Update für alle Container (an|aus))$/)
  if (all) {
    const on = all[1] === 'on' || all[2] === 'an'
    return msg(m.quadlets_history_autoUpdate, { enabled: String(on) })
  }
  const hit = message.match(/^(.+) (created|changed|deleted|angelegt|geändert|gelöscht)$/)
  if (hit) {
    const kind = ({ angelegt: 'created', geändert: 'changed', gelöscht: 'deleted' } as Record<string, string>)[hit[2]!] ?? hit[2]!
    return kind === 'created' ? msg(m.quadlets_history_created, { name: hit[1]! }) : kind === 'changed' ? msg(m.quadlets_history_changed, { name: hit[1]! }) : msg(m.quadlets_history_deleted, { name: hit[1]! })
  }
  return message
}

const GENERATORS = ['/usr/lib/systemd/system-generators/podman-system-generator', '/usr/libexec/podman/quadlet', '/usr/lib/podman/quadlet']

function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  const tmp = `${path}.quadeck-tmp`
  writeFileSync(tmp, content, { mode: 0o644 })
  renameSync(tmp, path)
}

export const managerCall = (method: string, sig?: string, ...args: string[]) =>
  runOk(['busctl', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', method, ...(sig ? [sig, ...args] : [])], { timeoutMs: 120_000 })

export class SystemPodmanAdmin implements PodmanAdminBackend {
  readonly dir: string
  private gitDir: string
  private confDir: string
  private manager: typeof managerCall
  private exec: typeof run

  constructor(opts: { dir?: string; gitDir?: string; confDir?: string; manager?: typeof managerCall; exec?: typeof run } = {}) {
    this.dir = opts.dir ?? (process.env.QUADECK_QUADLET_DIR?.trim() || '/etc/containers/systemd')
    this.gitDir = opts.gitDir ?? join(process.env.STATE_DIRECTORY?.split(':')[0] || '/var/lib/quadeck-helper', 'quadlets.git')
    this.confDir = opts.confDir ?? '/etc/containers'
    this.manager = opts.manager ?? managerCall
    this.exec = opts.exec ?? run
  }
  private timerDropIn = `/etc/systemd/system/${TIMER}.d/50-quadeck.conf`

  private get defaultsDropIn() {
    return join(this.dir, 'container.d', '50-quadeck-autoupdate.conf')
  }

  async quadlets(): Promise<QuadletFile[]> {
    const out: QuadletFile[] = []
    const add = (rel: string) => {
      if (!QUADLET_NAME.test(rel)) return
      try {
        const st = statSync(join(this.dir, rel))
        if (st.isFile()) out.push({ name: rel, type: quadletType(rel), unit: quadletUnit(rel), size: st.size, mtime: st.mtimeMs })
      } catch {
        // vanished
      }
    }
    let top: string[] = []
    try {
      top = readdirSync(this.dir)
    } catch {
      return []
    }
    for (const f of top) {
      const p = join(this.dir, f)
      try {
        if (statSync(p).isDirectory() && !f.endsWith('.d') && !f.startsWith('.')) for (const g of readdirSync(p)) add(`${f}/${g}`)
        else add(f)
      } catch {
        // unreadable
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async readQuadlet(name: string) {
    validName(name)
    try {
      return readFileSync(join(this.dir, name), 'utf8')
    } catch {
      throw new HttpError(404, msg(m.quadlets_error_notFound, { name }))
    }
  }

  private generator() {
    return GENERATORS.find((g) => existsSync(g))
  }

  async validateQuadlet(name: string, content: string): Promise<ValidateResult> {
    validName(name)
    validContent(content)
    const diagnostics = [
      ...lintQuadlet(content, quadletType(name)),
      ...missingReferences(
        content,
        name,
        (await this.quadlets()).map((f) => f.name),
      ),
    ]
    const gen = this.generator()
    let generated: string | undefined
    if (!gen) diagnostics.push({ severity: 'warning', message: msg(m.quadlets_lint_generatorMissing) })
    else {
      // Dry run over a copy of the whole directory (references to .network/.volume files resolve).
      const tmp = mkdtempSync(join(tmpdir(), 'quadeck-quadlet-'))
      try {
        for (const f of await this.quadlets()) if (f.name !== name) atomicWrite(join(tmp, f.name), readFileSync(join(this.dir, f.name), 'utf8'))
        atomicWrite(join(tmp, name), content)
        const r = await run([gen, '-dryrun'], { timeoutMs: 30_000, env: { QUADLET_UNIT_DIRS: tmp } })
        diagnostics.push(...generatorDiagnostics(r.stderr, name, content))
        generated = generatedUnit(r.stdout, quadletUnit(name))
        if (!generated && !diagnostics.some((d) => d.severity === 'error')) diagnostics.push({ severity: 'error', message: msg(m.quadlets_lint_noGeneratedUnit) + (r.stderr.trim() ? `: ${r.stderr.trim().split('\n').pop()}` : '') })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics, generated }
  }

  // ---------- git history (separate git dir, the Quadlet directory stays clean) ----------

  private git(...args: string[]) {
    return run(['git', `--git-dir=${this.gitDir}`, `--work-tree=${this.dir}`, '-c', 'user.name=Quadeck', '-c', 'user.email=quadeck@localhost', '-c', 'commit.gpgsign=false', ...args], { timeoutMs: 30_000 })
  }

  private async ensureRepo() {
    if (!Bun.which('git')) return false
    if (!existsSync(join(this.gitDir, 'HEAD'))) {
      mkdirSync(this.gitDir, { recursive: true, mode: 0o700 })
      await runOk(['git', `--git-dir=${this.gitDir}`, `--work-tree=${this.dir}`, 'init', '-q'])
      await this.commit('Initial state')
    }
    return true
  }

  private async commit(message: string) {
    await this.git('add', '-A', '.')
    await this.git('commit', '-q', '--allow-empty-message', '-m', message)
  }

  async quadletHistory(name: string): Promise<Revision[]> {
    validName(name)
    if (!existsSync(join(this.gitDir, 'HEAD'))) return []
    const r = await this.git('log', '-n', '30', '--format=%H%x09%ct%x09%s', '--', name)
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [id, t, ...m] = l.split('\t')
        return { id: id!, date: Number(t) * 1000, message: commitLabel(m.join('\t')) }
      })
  }

  async quadletRevision(name: string, id: string) {
    validName(name)
    if (!/^[0-9a-f]{7,40}$/.test(id)) throw new HttpError(400, msg(m.quadlets_error_invalidRevision))
    const r = await this.git('show', `${id}:${name}`)
    if (r.code !== 0) throw new HttpError(404, msg(m.quadlets_error_revisionNotFound))
    return r.stdout
  }

  // ---------- writes ----------

  async writeQuadlet(name: string, content: string, restart: boolean): Promise<WriteResult> {
    const v = await this.validateQuadlet(name, content)
    const err = v.diagnostics.find((d) => d.severity === 'error')
    if (err) throw new HttpError(422, `${err.line ? msg(m.fstab_label_linePrefix, { line: err.line }) : ''}${err.message}`)
    const history = await this.ensureRepo()
    const isNew = !existsSync(join(this.dir, name))
    atomicWrite(join(this.dir, name), content.endsWith('\n') ? content : content + '\n')
    if (history) await this.commit(`${name} ${isNew ? 'created' : 'changed'}`)
    await this.manager('Reload')
    const unit = quadletUnit(name)
    if (!restart) return { unit, restarted: false }
    try {
      await this.manager('RestartUnit', 'ss', unit, 'replace')
      return { unit, restarted: true }
    } catch (e) {
      return { unit, restarted: false, warning: msg(m.quadlets_warn_savedNotStarted, { unit }) + `: ${(e as Error).message}` }
    }
  }

  /** Every Quadlet file with its content, for what a deleted one leaves behind. */
  async removalPlan(name: string): Promise<RemovalPlan> {
    validName(name)
    const files = await Promise.all((await this.quadlets()).map(async (f) => ({ name: f.name, content: await this.readQuadlet(f.name).catch(() => '') })))
    return removalPlan(name, files)
  }

  async deleteQuadlet(name: string, also: RemoveAlso = {}) {
    validName(name)
    const path = join(this.dir, name)
    if (!existsSync(path)) throw new HttpError(404, msg(m.quadlets_error_notFound, { name }))
    // Read before anything is deleted: the plan needs this file and the .volume files.
    const plan = also.image || also.volumes ? await this.removalPlan(name) : undefined
    const history = await this.ensureRepo()
    const unit = quadletUnit(name)
    // With clean-up the container has to be gone first: systemctl waits, StopUnit only queues the job.
    if (plan) {
      const stop = await this.exec(['systemctl', 'stop', unit], { timeoutMs: 120_000 })
      // A unit that never loaded (broken file) may go; one that still runs must not lose its
      // file: the container would keep running without a unit and its volumes stay in use.
      if (stop.code !== 0) {
        const state = (await this.exec(['systemctl', 'is-active', unit])).stdout.trim()
        if (['active', 'activating', 'deactivating', 'reloading', 'refreshing'].includes(state)) throw new HttpError(409, msg(m.quadlets_error_stillRunning, { unit, error: (stop.stderr || stop.stdout).trim() || state }))
      }
    } else await this.manager('StopUnit', 'ss', unit, 'replace').catch(() => {})
    rmSync(path)
    const volumes = also.volumes ? (plan?.volumes.filter((v) => !v.shared) ?? []) : []
    for (const v of volumes) {
      if (!v.file || !existsSync(join(this.dir, v.file))) continue
      await this.manager('StopUnit', 'ss', quadletUnit(v.file), 'replace').catch(() => {})
      rmSync(join(this.dir, v.file))
    }
    if (history) await this.commit(`${name} deleted`)
    await this.manager('Reload')
    const warnings: string[] = []
    for (const v of volumes) {
      const r = await this.exec(['podman', 'volume', 'rm', '--', v.name], { timeoutMs: 60_000 })
      if (r.code !== 0 && !/no such volume/i.test(r.stderr)) warnings.push(msg(m.quadlets_warn_volumeKept, { name: v.name }) + `: ${r.stderr.trim()}`)
    }
    if (also.image && plan?.image && !plan.image.shared) {
      const r = await this.exec(['podman', 'rmi', '--', plan.image.name], { timeoutMs: 60_000 })
      if (r.code !== 0 && !/image not known|no such image/i.test(r.stderr)) warnings.push(msg(m.quadlets_warn_imageKept, { name: plan.image.name }) + `: ${r.stderr.trim()}`)
    }
    return { warnings }
  }

  // ---------- Podman settings ----------

  private async version() {
    const r = await run(['podman', 'version', '--format', '{{.Client.Version}}'])
    return r.code === 0 ? r.stdout.trim() : undefined
  }

  async podmanSettings(): Promise<PodmanSettings> {
    const version = await this.version()
    const show = await run(['systemctl', 'show', TIMER, '-p', 'LoadState,UnitFileState,ActiveState,TimersCalendar,NextElapseUSecRealtime', '--timestamp=unix'])
    const props = Object.fromEntries(show.stdout.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    let custom = ''
    try {
      custom =
        readFileSync(this.timerDropIn, 'utf8')
          .match(/^OnCalendar=(.+)$/m)?.[1]
          ?.trim() ?? ''
    } catch {
      // default schedule
    }
    const next = Number(props.NextElapseUSecRealtime?.replace('@', '')) * 1000
    const files: PodmanConfigFile[] = (['containers.conf', 'registries.conf', 'storage.conf'] as const).map((n) => {
      const path = join(this.confDir, n)
      let content = ''
      const exists = existsSync(path)
      try {
        content = exists ? readFileSync(path, 'utf8').slice(0, MAX_FILE) : ''
      } catch {
        // unreadable
      }
      return { name: n, path, exists, content, editable: EDITABLE_CONFIGS.includes(n) }
    })
    return {
      version,
      quadletDir: this.dir,
      history: !!Bun.which('git'),
      timer: {
        exists: props.LoadState === 'loaded',
        enabled: props.UnitFileState === 'enabled',
        active: props.ActiveState === 'active',
        calendar: custom || calendarOf(props.TimersCalendar) || 'daily',
        custom: !!custom,
        next: Number.isFinite(next) && next > 0 ? next : undefined,
      },
      autoUpdateDefault: { supported: Number(version?.split('.')[0]) >= 5, enabled: existsSync(this.defaultsDropIn), path: this.defaultsDropIn },
      files,
    }
  }

  async setAutoUpdateTimer(enabled: boolean, calendar: string) {
    validCalendar(calendar)
    if (calendar) {
      const check = await run(['systemd-analyze', 'calendar', '--', calendar])
      if (check.code !== 0) throw new HttpError(422, msg(m.quadlets_check_invalidSchedule) + `: ${(check.stderr || check.stdout).trim().split('\n')[0]}`)
      atomicWrite(this.timerDropIn, `# Quadeck: schedule for podman auto-update\n[Timer]\nOnCalendar=\nOnCalendar=${calendar}\n`)
    } else rmSync(this.timerDropIn, { force: true })
    await this.manager('Reload')
    await runOk(['systemctl', enabled ? 'enable' : 'disable', '--now', TIMER], { timeoutMs: 60_000 })
  }

  async setAutoUpdateDefault(enabled: boolean) {
    const v = await this.version()
    if (!(Number(v?.split('.')[0]) >= 5)) throw new HttpError(409, msg(m.quadlets_error_needsPodman5, { version: v ?? msg(m.packages_status_unknown) }))
    const history = await this.ensureRepo()
    if (enabled) atomicWrite(this.defaultsDropIn, '# Quadeck: auto-update for all .container files\n[Container]\nAutoUpdate=registry\n')
    else rmSync(this.defaultsDropIn, { force: true })
    if (history) await this.commit(`Auto-update for all containers ${enabled ? 'on' : 'off'}`)
    await this.manager('Reload')
  }

  async writePodmanConfig(name: PodmanConfigName, content: string) {
    if (!EDITABLE_CONFIGS.includes(name)) throw new HttpError(400, msg(m.quadlets_error_notEditable, { name }))
    validContent(content)
    try {
      Bun.TOML.parse(content)
    } catch (e) {
      throw new HttpError(422, msg(m.quadlets_error_toml) + `: ${(e as Error).message}`)
    }
    const path = join(this.confDir, name)
    if (existsSync(path)) writeFileSync(`${path}.quadeck-bak`, readFileSync(path), { mode: 0o644 })
    atomicWrite(path, content)
  }
}

// ---------- fixtures ----------

export class FixturePodmanAdmin implements PodmanAdminBackend {
  private files = new Map<string, { content: string; mtime: number; history: Revision[]; versions: Map<string, string> }>()
  private settings: PodmanSettings
  private rev = 0

  constructor(dir: string) {
    const qdir = join(dir, 'quadlets')
    for (const f of existsSync(qdir) ? readdirSync(qdir) : []) if (QUADLET_NAME.test(f)) this.put(f, readFileSync(join(qdir, f), 'utf8'), 'Initial state')
    this.settings = {
      version: '5.6.1',
      quadletDir: '/etc/containers/systemd',
      history: true,
      timer: { exists: true, enabled: true, active: true, calendar: 'daily', custom: false, next: Date.now() + 6 * 3600_000 },
      autoUpdateDefault: { supported: true, enabled: false, path: '/etc/containers/systemd/container.d/50-quadeck-autoupdate.conf' },
      files: [
        { name: 'containers.conf', path: '/etc/containers/containers.conf', exists: true, content: '[containers]\nlog_driver = "journald"\ntz = "local"\n\n[engine]\nevents_logger = "journald"\n', editable: true },
        { name: 'registries.conf', path: '/etc/containers/registries.conf', exists: true, content: '# Short names\nunqualified-search-registries = ["docker.io"]\nshort-name-mode = "enforcing"\n', editable: true },
        { name: 'storage.conf', path: '/etc/containers/storage.conf', exists: true, content: '[storage]\ndriver = "overlay"\nrunroot = "/run/containers/storage"\ngraphroot = "/var/lib/containers/storage"\n', editable: false },
      ],
    }
  }

  private put(name: string, content: string, message: string) {
    const id = (++this.rev).toString(16).padStart(7, '0')
    const f = this.files.get(name) ?? { content, mtime: 0, history: [] as Revision[], versions: new Map<string, string>() }
    f.content = content
    f.mtime = Date.now()
    f.history.unshift({ id, date: Date.now(), message })
    f.versions.set(id, content)
    this.files.set(name, f)
  }

  async quadlets() {
    return [...this.files].map(([name, f]) => ({ name, type: quadletType(name), unit: quadletUnit(name), size: f.content.length, mtime: f.mtime })).sort((a, b) => a.name.localeCompare(b.name))
  }
  async readQuadlet(name: string) {
    validName(name)
    const f = this.files.get(name)
    if (!f) throw new HttpError(404, msg(m.quadlets_error_notFound, { name }))
    return f.content
  }
  async validateQuadlet(name: string, content: string) {
    validName(name)
    validContent(content)
    const diagnostics = [...lintQuadlet(content, quadletType(name)), ...missingReferences(content, name, [...this.files.keys()])]
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics, generated: `[Unit]\nSourcePath=/etc/containers/systemd/${name}\n…` }
  }
  async quadletHistory(name: string) {
    validName(name)
    return (this.files.get(name)?.history ?? []).map((h) => ({ ...h, message: commitLabel(h.message) }))
  }
  async quadletRevision(name: string, id: string) {
    const v = this.files.get(name)?.versions.get(id)
    if (v === undefined) throw new HttpError(404, msg(m.quadlets_error_revisionNotFound))
    return v
  }
  async writeQuadlet(name: string, content: string, restart: boolean) {
    const v = await this.validateQuadlet(name, content)
    const err = v.diagnostics.find((d) => d.severity === 'error')
    if (err) throw new HttpError(422, `${err.line ? msg(m.fstab_label_linePrefix, { line: err.line }) : ''}${err.message}`)
    this.put(name, content.endsWith('\n') ? content : content + '\n', `${name} ${this.files.has(name) ? 'changed' : 'created'}`)
    return { unit: quadletUnit(name), restarted: restart }
  }
  async removalPlan(name: string) {
    validName(name)
    return removalPlan(name, [...this.files].map(([n, f]) => ({ name: n, content: f.content })))
  }
  async deleteQuadlet(name: string, also: RemoveAlso = {}) {
    validName(name)
    if (!this.files.has(name)) throw new HttpError(404, msg(m.quadlets_error_notFound, { name }))
    const plan = await this.removalPlan(name)
    this.files.delete(name)
    if (also.volumes) for (const v of plan.volumes) if (!v.shared && v.file) this.files.delete(v.file)
    return { warnings: [] }
  }
  async podmanSettings() {
    return structuredClone(this.settings)
  }
  async setAutoUpdateTimer(enabled: boolean, calendar: string) {
    validCalendar(calendar)
    this.settings.timer = { ...this.settings.timer, enabled, active: enabled, calendar: calendar || 'daily', custom: !!calendar }
  }
  async setAutoUpdateDefault(enabled: boolean) {
    this.settings.autoUpdateDefault.enabled = enabled
  }
  async writePodmanConfig(name: PodmanConfigName, content: string) {
    if (!EDITABLE_CONFIGS.includes(name)) throw new HttpError(400, msg(m.quadlets_error_notEditable, { name }))
    validContent(content)
    try {
      Bun.TOML.parse(content)
    } catch (e) {
      throw new HttpError(422, msg(m.quadlets_error_toml) + `: ${(e as Error).message}`)
    }
    const f = this.settings.files.find((x) => x.name === name)!
    f.content = content
  }
}
