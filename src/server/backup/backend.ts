// Server backups with restic. SystemBackup works on the host (root helper or a
// single root process, and `quadeck backup run|check` started by its timer);
// FixtureBackup keeps demo data in memory.
//
// Everything lives in one root-only directory (QUADECK_BACKUP_DIR, default
// /var/lib/quadeck-helper/backup): plan.json, the repository password, the
// credentials (env), the exclude file, the run records and a cache of the
// snapshot list. The schedule is a pair of systemd units in /etc/systemd/system.

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  BACKUP_TIMER,
  BACKUP_UNIT,
  CHECK_TIMER,
  CHECK_UNIT,
  REPO_SECRETS,
  SNAPSHOT_ID,
  VOLUME_PATH,
  absPathProblem,
  backupArgs,
  backupRunFrom,
  backupUnits,
  excludeFile,
  forgetArgs,
  parseLs,
  parseSnapshots,
  repoString,
  suggestBackup,
  type BackupPlan,
  type BackupRun,
  type BackupSizes,
  type BackupSnapshot,
  type BackupState,
  type BackupSuggestion,
  type LsEntry,
  CLIENT_NAME,
  targetQuadlet,
  clientRepo,
  type BackupClient,
  type TargetConfig,
  type TargetState,
} from '~/shared/backup'
import { localize, msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { clientScript, defaultClientPlan, type ClientPlan } from '~/shared/backup-client'
import { HttpError } from '../auth'
import { run, type ExecResult } from '../exec'
import type { PodmanAdmin } from '../quadlets/backend'

export interface BackupAdmin {
  backupState(refresh?: boolean): Promise<BackupState>
  backupSuggest(): Promise<BackupSuggestion>
  backupSizes(paths: string[], excludes: string[]): Promise<BackupSizes>
  backupLs(snapshot: string, dir: string): Promise<LsEntry[]>
  targetState(refresh?: boolean): Promise<TargetState>
}

/** Writes and reads of backed-up content; the caller has checked the unlock. */
export interface BackupBackend extends BackupAdmin {
  saveBackupPlan(plan: BackupPlan, secrets: Record<string, string>): Promise<BackupState>
  disableBackup(): Promise<BackupState>
  backupPassword(): Promise<string>
  startBackup(kind: 'backup' | 'check'): Promise<void>
  backupDump(snapshot: string, path: string): Promise<Response>
  /** Stores the target and returns its Quadlet (written by the caller through the Quadlet backend). */
  saveTarget(config: TargetConfig): Promise<string>
  clearTarget(): Promise<void>
  addClient(name: string, warnDays: number | undefined): Promise<{ password: string }>
  updateClient(name: string, change: { warnDays?: number | null; disabled?: boolean }): Promise<TargetState>
  renewClient(name: string): Promise<{ password: string }>
  removeClient(name: string, deleteData: boolean): Promise<TargetState>
  setClientPlan(name: string, plan: ClientPlan): Promise<TargetState>
  /** A one-time link (30 minutes) for the client's install/update script. */
  clientLink(name: string, quadeckUrl: string): Promise<{ token: string; expires: number }>
  /** The script behind a link; the link is used up, the access password renewed. */
  redeemClientLink(token: string): Promise<string | undefined>
}

const LINK_MINUTES = 30
export const LINK_TOKEN = /^[A-Za-z0-9_-]{32}$/

/** One-time links, in memory: a restart of the helper only invalidates links that were not used yet. */
export class LinkStore {
  private links = new Map<string, { name: string; url: string; expires: number }>()
  create(name: string, url: string, now = Date.now()) {
    for (const [k, v] of this.links) if (v.expires < now || v.name === name) this.links.delete(k)
    const token = randomBytes(24).toString('base64url')
    const expires = now + LINK_MINUTES * 60_000
    this.links.set(token, { name, url, expires })
    return { token, expires }
  }
  take(token: string, now = Date.now()) {
    if (!LINK_TOKEN.test(token)) return undefined
    const l = this.links.get(token)
    this.links.delete(token)
    return l && l.expires >= now ? l : undefined
  }
}

interface StoredClient extends Omit<BackupClient, 'lastAt' | 'snapshots' | 'size'> {
  /** bcrypt, kept so a disabled client can be enabled again with the same access. */
  hash: string
}

interface TargetFile {
  config?: TargetConfig
  clients: StoredClient[]
  sizes?: Record<string, number>
}

/** A random access password (letters and digits, easy to paste). */
export function accessPassword(len = 28) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(len)
  return Array.from(bytes, (b) => abc[b % abc.length]).join('')
}

/** Last backup of a client from its repository, without the password: snapshot files are written per backup. */
export function clientRepoStatus(repoDir: string): { lastAt?: number; snapshots: number } {
  let names: string[] = []
  try {
    names = readdirSync(join(repoDir, 'snapshots'))
  } catch {
    return { snapshots: 0 }
  }
  let lastAt: number | undefined
  for (const n of names) {
    try {
      const t = statSync(join(repoDir, 'snapshots', n)).mtimeMs
      if (lastAt === undefined || t > lastAt) lastAt = t
    } catch {
      // removed meanwhile (prune)
    }
  }
  return { lastAt, snapshots: names.length }
}

export interface RestoreSpec {
  snapshot: string
  paths: string[]
  /** Absent: back to where the files came from. */
  target?: string
  /** Units stopped during an in-place restore. */
  stop: string[]
}

type Exec = (argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>

export interface SystemBackupOptions {
  dir?: string
  unitDir?: string
  /** How systemd starts this binary (`quadeck`), for the units. */
  self?: string[]
  exec?: Exec
  /** Quadlet files with content, for the suggestions. */
  quadlets?: () => Promise<{ name: string; content: string }[]>
  /** Output lines of a run (journal of the unit, or a job's live view). */
  log?: (line: string) => void
}

const MAX_RUNS = 100

function writePrivate(path: string, content: string) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** KEY=value lines; values never contain a newline (checked in parseSecrets). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of text.split('\n')) {
    const i = l.indexOf('=')
    if (i > 0 && /^[A-Z0-9_]+$/.test(l.slice(0, i))) out[l.slice(0, i)] = l.slice(i + 1)
  }
  return out
}

const NO_REPO = /Is there a repository|does not exist|no such file or directory|unable to open config|NoSuchBucket|NoSuchKey|404/i

export class SystemBackup implements BackupBackend {
  readonly dir: string
  private unitDir: string
  private self: string[]
  private exec: Exec
  private quadlets: () => Promise<{ name: string; content: string }[]>
  private log: (line: string) => void

  constructor(o: SystemBackupOptions = {}) {
    this.dir = o.dir ?? (process.env.QUADECK_BACKUP_DIR?.trim() || join(process.env.STATE_DIRECTORY?.split(':')[0] || '/var/lib/quadeck-helper', 'backup'))
    this.unitDir = o.unitDir ?? '/etc/systemd/system'
    this.self = o.self ?? ['/usr/local/bin/quadeck']
    this.exec = o.exec ?? run
    this.quadlets = o.quadlets ?? (async () => [])
    // The journal of the unit: in English, stored texts stay language-neutral.
    this.log = o.log ?? ((l) => console.log(localize(l, 'en')))
  }

  private file = (name: string) => join(this.dir, name)

  private ensureDir() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
  }

  plan(): BackupPlan | undefined {
    return readJson<BackupPlan | undefined>(this.file('plan.json'), undefined)
  }

  runs(): BackupRun[] {
    return readJson<BackupRun[]>(this.file('runs.json'), [])
  }

  private addRun(r: BackupRun) {
    this.ensureDir()
    writePrivate(this.file('runs.json'), JSON.stringify([r, ...this.runs()].slice(0, MAX_RUNS)))
  }

  private secrets(): Record<string, string> {
    try {
      return parseEnvFile(readFileSync(this.file('env'), 'utf8'))
    } catch {
      return {}
    }
  }

  /** Environment for restic: repository, password file, cache, credentials. */
  resticEnv(plan: BackupPlan, secrets = this.secrets()): Record<string, string> {
    const allowed = Object.fromEntries(REPO_SECRETS[plan.repo.kind].filter((k) => secrets[k]).map((k) => [k, secrets[k]!]))
    return { ...allowed, RESTIC_REPOSITORY: repoString(plan.repo), RESTIC_PASSWORD_FILE: this.file('password'), RESTIC_CACHE_DIR: this.file('cache'), RESTIC_PROGRESS_FPS: '0.1' }
  }

  /** secrets: credentials not saved yet (checking a new plan); otherwise the stored ones. */
  private restic(plan: BackupPlan, args: string[], timeoutMs = 60_000, secrets?: Record<string, string>) {
    return this.exec(['restic', ...args], { env: this.resticEnv(plan, secrets), timeoutMs })
  }

  private installed() {
    return !!Bun.which('restic')
  }

  private async systemctl(...args: string[]) {
    return this.exec(['systemctl', ...args], { timeoutMs: 120_000 })
  }

  // ---------- reads ----------

  async backupState(refresh = false): Promise<BackupState> {
    const plan = this.plan()
    const runs = this.runs()
    const installed = this.installed()
    const state: BackupState = { installed, secretsSet: plan ? REPO_SECRETS[plan.repo.kind].filter((k) => this.secrets()[k]) : [], runs: runs.slice(0, 30), snapshots: [] }
    if (installed) {
      const v = await this.exec(['restic', 'version'], { timeoutMs: 10_000 })
      state.version = /restic ([\d.]+)/.exec(v.stdout)?.[1]
    }
    if (!plan) return state
    state.plan = plan
    const cache = readJson<{ at: number; snapshots: BackupSnapshot[]; size?: number; error?: string } | undefined>(this.file('snapshots.json'), undefined)
    if (refresh && installed) await this.refreshSnapshots(plan)
    const fresh = refresh ? readJson<typeof cache>(this.file('snapshots.json'), undefined) : cache
    if (fresh) Object.assign(state, { snapshots: fresh.snapshots, snapshotsAt: fresh.at, repoSize: fresh.size, ...(fresh.error ? { repoError: fresh.error } : {}) })
    const show = await this.systemctl('show', BACKUP_UNIT, CHECK_UNIT, BACKUP_TIMER, CHECK_TIMER, '-p', 'Id,ActiveState,NextElapseUSecRealtime', '--timestamp=unix')
    for (const block of show.stdout.split('\n\n')) {
      const p = Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      const next = Number((p.NextElapseUSecRealtime ?? '').replace('@', '')) * 1000
      if (p.Id === BACKUP_UNIT && p.ActiveState === 'activating') state.running = 'backup'
      if (p.Id === CHECK_UNIT && p.ActiveState === 'activating') state.running ??= 'check'
      if (p.Id === BACKUP_TIMER && next > 0) state.next = next
      if (p.Id === CHECK_TIMER && next > 0) state.nextCheck = next
    }
    if (plan.repo.kind === 'local') {
      let p = plan.repo.location
      while (!existsSync(p) && p !== '/') p = dirname(p)
      try {
        const s = await statfs(p)
        state.target = { free: s.bavail * s.bsize, size: s.blocks * s.bsize }
      } catch {
        // not reachable
      }
    }
    return state
  }

  /** Snapshot list and repository size into the cache (also after every run). */
  async refreshSnapshots(plan: BackupPlan) {
    const r = await this.restic(plan, ['snapshots', '--json', '--no-lock'], 120_000)
    if (r.code !== 0) {
      const old = readJson<Record<string, unknown>>(this.file('snapshots.json'), {})
      writePrivate(this.file('snapshots.json'), JSON.stringify({ ...old, at: Date.now(), error: r.stderr.trim().split('\n').filter(Boolean).pop() ?? `restic ${r.code}` }))
      return
    }
    const snapshots = parseSnapshots(r.stdout, this.runs())
    const stats = await this.restic(plan, ['stats', '--json', '--no-lock', '--mode', 'raw-data'], 300_000)
    let size: number | undefined
    try {
      size = (JSON.parse(stats.stdout) as { total_size?: number }).total_size
    } catch {
      // older restic or no access: no size
    }
    writePrivate(this.file('snapshots.json'), JSON.stringify({ at: Date.now(), snapshots, size }))
  }

  async backupSuggest() {
    return suggestBackup(await this.quadlets())
  }

  /** `volume:<name>` → its directory on the host. */
  async resolvePath(p: string): Promise<string | undefined> {
    if (!VOLUME_PATH.test(p)) return p
    const r = await this.exec(['podman', 'volume', 'inspect', '--format', '{{.Mountpoint}}', '--', p.slice('volume:'.length)], { timeoutMs: 20_000 })
    const mp = r.stdout.trim()
    return r.code === 0 && mp.startsWith('/') ? mp : undefined
  }

  async backupSizes(paths: string[], excludes: string[]): Promise<BackupSizes> {
    const valid = (p: string) => VOLUME_PATH.test(p) || !absPathProblem(p)
    if (paths.length > 50 || excludes.length > 50 || ![...paths, ...excludes].every((p) => typeof p === 'string' && valid(p))) throw new HttpError(400, msg(m.backup_error_tooMany))
    const du = async (p: string) => {
      const real = await this.resolvePath(p)
      if (!real || !existsSync(real)) return undefined
      const r = await this.exec(['du', '-sb', '--', real], { timeoutMs: 180_000 })
      const n = Number(r.stdout.split(/\s/)[0])
      return r.stdout && Number.isFinite(n) ? n : undefined
    }
    return {
      paths: await Promise.all(paths.map(async (path) => ({ path, bytes: await du(path) }))),
      excludes: await Promise.all(excludes.map(async (path) => ({ path, bytes: await du(path) }))),
    }
  }

  async backupLs(snapshot: string, dir: string): Promise<LsEntry[]> {
    const plan = this.requirePlan()
    if (!SNAPSHOT_ID.test(snapshot) || (dir !== '/' && absPathProblem(dir))) throw new HttpError(400, msg(m.backup_error_path, { path: dir }))
    const r = await this.restic(plan, ['ls', '--json', '--no-lock', snapshot, dir], 120_000)
    if (r.code !== 0) throw new HttpError(502, r.stderr.trim() || `restic ${r.code}`)
    return parseLs(r.stdout, dir).map((e) => {
      try {
        const st = lstatSync(e.path)
        if (e.type !== 'file') return { ...e, now: 'same' as const }
        const same = st.size === e.size && (e.mtime === undefined || Math.abs(st.mtimeMs - e.mtime) < 1000)
        return { ...e, now: same ? ('same' as const) : ('changed' as const) }
      } catch {
        return { ...e, now: 'missing' as const }
      }
    })
  }

  private requirePlan(): BackupPlan {
    const plan = this.plan()
    if (!plan) throw new HttpError(409, msg(m.backup_error_notConfigured))
    if (!this.installed()) throw new HttpError(409, msg(m.backup_error_notInstalled))
    return plan
  }

  // ---------- writes ----------

  async saveBackupPlan(plan: BackupPlan, secrets: Record<string, string>): Promise<BackupState> {
    if (!this.installed()) throw new HttpError(409, msg(m.backup_error_notInstalled))
    this.ensureDir()
    if (!existsSync(this.file('password'))) writePrivate(this.file('password'), randomBytes(32).toString('base64url') + '\n')
    const merged = { ...this.secrets(), ...secrets }
    const needed = REPO_SECRETS[plan.repo.kind]
    const missing = needed.filter((k) => !merged[k])
    if (missing.length) throw new HttpError(400, msg(m.backup_error_secretMissing, { keys: missing.join(', ') }))
    if (plan.repo.kind === 'local' && !existsSync(dirname(plan.repo.location))) throw new HttpError(422, msg(m.backup_error_parentMissing, { path: dirname(plan.repo.location) }))

    // The repository: open it, or create it where there is none yet – with the new credentials,
    // which are stored only once they work (a typo must not replace credentials that worked).
    const cfg = await this.restic(plan, ['cat', 'config', '--no-lock'], 120_000, merged)
    if (cfg.code !== 0) {
      if (!NO_REPO.test(cfg.stderr)) throw new HttpError(422, msg(m.backup_error_repoOpen, { message: cfg.stderr.trim() }))
      const init = await this.restic(plan, ['init'], 180_000, merged)
      if (init.code !== 0) throw new HttpError(422, msg(m.backup_error_repoInit, { message: init.stderr.trim() }))
      this.log(msg(m.backup_log_initialised, { repo: repoString(plan.repo) }))
    }
    writePrivate(this.file('env'), Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')

    writePrivate(this.file('plan.json'), JSON.stringify(plan, null, 2))
    writePrivate(this.file('excludes'), excludeFile(plan))
    for (const [name, content] of Object.entries(backupUnits(plan, this.self, this.dir))) {
      const path = join(this.unitDir, name)
      if (content === null) {
        if (existsSync(path)) {
          await this.systemctl('disable', '--now', name)
          rmSync(path)
        }
      } else writeFileSync(path, content, { mode: 0o644 })
    }
    await this.systemctl('daemon-reload')
    const en = await this.systemctl('enable', '--now', BACKUP_TIMER)
    if (en.code !== 0) throw new HttpError(500, en.stderr.trim())
    if (plan.check !== 'never') await this.systemctl('enable', '--now', CHECK_TIMER)
    return this.backupState()
  }

  async disableBackup(): Promise<BackupState> {
    for (const name of [BACKUP_TIMER, CHECK_TIMER]) await this.systemctl('disable', '--now', name)
    for (const name of [BACKUP_UNIT, BACKUP_TIMER, CHECK_UNIT, CHECK_TIMER]) rmSync(join(this.unitDir, name), { force: true })
    await this.systemctl('daemon-reload')
    // Password, credentials and run records stay: the repository is still readable after switching on again.
    rmSync(this.file('plan.json'), { force: true })
    return this.backupState()
  }

  async backupPassword() {
    this.requirePlan()
    return readFileSync(this.file('password'), 'utf8').trim()
  }

  async startBackup(kind: 'backup' | 'check') {
    const plan = this.requirePlan()
    if (kind === 'check' && plan.check === 'never') {
      // No unit for it: a one-off run of the same command.
      const r = await this.exec(['systemd-run', '--unit=quadeck-backup-check-once', '--collect', '--quiet', '--description=Quadeck: check the backup repository (restic)', '--', ...this.self, 'backup', 'check'], { timeoutMs: 30_000 })
      if (r.code !== 0) throw new HttpError(500, r.stderr.trim())
      return
    }
    const r = await this.systemctl('start', '--no-block', kind === 'backup' ? BACKUP_UNIT : CHECK_UNIT)
    if (r.code !== 0) throw new HttpError(500, r.stderr.trim())
  }

  async backupDump(snapshot: string, path: string): Promise<Response> {
    const plan = this.requirePlan()
    if (!SNAPSHOT_ID.test(snapshot) || absPathProblem(path)) throw new HttpError(400, msg(m.backup_error_path, { path }))
    // A directory comes as a zip; ls tells which it is.
    const parent = dirname(path)
    const entry = (await this.backupLs(snapshot, parent)).find((e) => e.path === path)
    if (!entry) throw new HttpError(404, msg(m.backup_error_notInSnapshot, { path }))
    const zip = entry.type === 'dir'
    const proc = Bun.spawn(['restic', 'dump', '--no-lock', ...(zip ? ['--archive', 'zip'] : []), snapshot, path], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LC_ALL: 'C', ...this.resticEnv(plan) },
    })
    const reader = proc.stdout.getReader()
    const first = await reader.read()
    if (first.done) {
      const code = await proc.exited
      if (code !== 0) throw new HttpError(502, (await new Response(proc.stderr).text()).trim() || `restic ${code}`)
    }
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        if (!first.done) ctrl.enqueue(first.value)
        else ctrl.close()
      },
      async pull(ctrl) {
        const next = await reader.read()
        if (next.done) ctrl.close()
        else ctrl.enqueue(next.value)
      },
      cancel() {
        proc.kill()
      },
    })
    const name = basename(path) + (zip ? '.zip' : '')
    return new Response(first.done ? null : body, {
      headers: {
        'content-type': zip ? 'application/zip' : 'application/octet-stream',
        'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  // ---------- backup target for clients ----------

  private target(): TargetFile {
    return readJson<TargetFile>(this.file('target.json'), { clients: [] })
  }

  private writeTarget(t: TargetFile) {
    this.ensureDir()
    writePrivate(this.file('target.json'), JSON.stringify(t, null, 2))
    // The rest-server reads its users from .htpasswd in the data folder (and notices changes).
    if (t.config && existsSync(t.config.dataDir)) {
      writePrivate(join(t.config.dataDir, '.htpasswd'), t.clients.filter((c) => !c.disabled).map((c) => `${c.name}:${c.hash}`).join('\n') + (t.clients.some((c) => !c.disabled) ? '\n' : ''))
    }
  }

  private client(t: TargetFile, name: string): StoredClient {
    const c = t.clients.find((x) => x.name === name)
    if (!c) throw new HttpError(404, msg(m.backup_error_clientUnknown, { name }))
    return c
  }

  async targetState(refresh = false): Promise<TargetState> {
    const t = this.target()
    const config = t.config
    if (refresh && config) {
      const sizes: Record<string, number> = {}
      for (const c of t.clients) {
        const r = await this.exec(['du', '-sb', '--', join(config.dataDir, c.name)], { timeoutMs: 600_000 })
        const n = Number(r.stdout.split(/\s/)[0])
        if (r.code === 0 && Number.isFinite(n)) sizes[c.name] = n
      }
      t.sizes = sizes
      writePrivate(this.file('target.json'), JSON.stringify(t, null, 2))
    }
    const clients = t.clients.map(({ hash: _h, ...c }) => ({ ...c, ...(config ? clientRepoStatus(join(config.dataDir, c.name)) : {}), ...(t.sizes?.[c.name] !== undefined ? { size: t.sizes[c.name] } : {}) }))
    let disk: TargetState['disk']
    if (config)
      try {
        const st = await statfs(existsSync(config.dataDir) ? config.dataDir : dirname(config.dataDir))
        disk = { free: st.bavail * st.bsize, size: st.blocks * st.bsize }
      } catch {
        // not there
      }
    return { ...(config ? { config } : {}), clients, ...(disk ? { disk } : {}) }
  }

  async saveTarget(config: TargetConfig): Promise<string> {
    if (!existsSync(dirname(config.dataDir))) throw new HttpError(422, msg(m.backup_error_parentMissing, { path: dirname(config.dataDir) }))
    const plan = this.plan()
    if (plan?.repo.kind === 'local' && (config.dataDir === plan.repo.location || config.dataDir.startsWith(plan.repo.location + '/'))) throw new HttpError(422, msg(m.backup_error_targetInRepo))
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    const t = this.target()
    this.writeTarget({ ...t, config })
    return targetQuadlet(config)
  }

  async clearTarget() {
    const t = this.target()
    // Clients and their repositories stay: setting the target up again brings them back.
    this.writeTarget({ ...t, config: undefined })
  }

  async addClient(name: string, warnDays: number | undefined) {
    if (!CLIENT_NAME.test(name)) throw new HttpError(400, msg(m.backup_error_clientName))
    const t = this.target()
    if (!t.config) throw new HttpError(409, msg(m.backup_error_noTarget))
    if (t.clients.some((c) => c.name === name)) throw new HttpError(409, msg(m.backup_error_clientExists, { name }))
    const password = accessPassword()
    t.clients.push({ name, created: Date.now(), ...(warnDays ? { warnDays } : {}), hash: await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 }) })
    this.writeTarget(t)
    return { password }
  }

  async updateClient(name: string, change: { warnDays?: number | null; disabled?: boolean }) {
    const t = this.target()
    const c = this.client(t, name)
    if (change.warnDays !== undefined) {
      if (change.warnDays === null) delete c.warnDays
      else c.warnDays = change.warnDays
    }
    if (change.disabled !== undefined) {
      if (change.disabled) c.disabled = true
      else delete c.disabled
    }
    this.writeTarget(t)
    return this.targetState()
  }

  async renewClient(name: string) {
    const t = this.target()
    const c = this.client(t, name)
    const password = accessPassword()
    c.hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })
    this.writeTarget(t)
    return { password }
  }

  async removeClient(name: string, deleteData: boolean) {
    const t = this.target()
    this.client(t, name)
    t.clients = t.clients.filter((c) => c.name !== name)
    if (t.sizes) delete t.sizes[name]
    this.writeTarget(t)
    if (deleteData && t.config && CLIENT_NAME.test(name)) rmSync(join(t.config.dataDir, name), { recursive: true, force: true })
    return this.targetState()
  }

  private linkStore = new LinkStore()

  async setClientPlan(name: string, plan: ClientPlan) {
    const t = this.target()
    const c = this.client(t, name)
    c.plan = plan
    c.version = (c.version ?? 0) + 1
    this.writeTarget(t)
    return this.targetState()
  }

  async clientLink(name: string, quadeckUrl: string) {
    const t = this.target()
    this.client(t, name)
    if (!t.config) throw new HttpError(409, msg(m.backup_error_noTarget))
    return this.linkStore.create(name, quadeckUrl)
  }

  async redeemClientLink(token: string) {
    const link = this.linkStore.take(token)
    if (!link) return undefined
    const t = this.target()
    const c = t.clients.find((x) => x.name === link.name)
    if (!c || !t.config) return undefined
    // A fresh access password for every script: the one it carries is the only valid one.
    const access = accessPassword()
    c.hash = await Bun.password.hash(access, { algorithm: 'bcrypt', cost: 10 })
    delete c.disabled
    c.version ??= 0
    c.applied = { version: c.version, at: Date.now() }
    this.writeTarget(t)
    return clientScript({ name: c.name, repo: clientRepo(t.config, c.name), user: c.name, access, appendOnly: t.config.appendOnly, plan: c.plan ?? defaultClientPlan(), version: c.version, quadeckUrl: link.url })
  }

  // ---------- runs (`quadeck backup run|check`, restore jobs) ----------

  /** Stops units, runs `restic backup`, starts them again, applies the retention. Returns the run record. */
  async runBackup(): Promise<BackupRun> {
    const plan = this.plan()
    const startedAt = Date.now()
    const fail = (message: string): BackupRun => {
      const r: BackupRun = { kind: 'backup', startedAt, endedAt: Date.now(), status: 'failed', errors: [], message }
      this.addRun(r)
      this.log(message)
      return r
    }
    if (!plan) return fail(msg(m.backup_error_notConfigured))
    if (!this.installed()) return fail(msg(m.backup_error_notInstalled))
    const paths: string[] = []
    for (const p of plan.paths) {
      const real = await this.resolvePath(p)
      if (real && existsSync(real)) paths.push(real)
      else this.log(msg(m.backup_log_skipped, { path: p }))
    }
    if (!paths.length) return fail(msg(m.backup_error_noPathsFound))
    writePrivate(this.file('excludes'), excludeFile(plan))

    // Only what was running is started again afterwards.
    const stopped: string[] = []
    for (const unit of plan.stop) {
      const active = (await this.systemctl('is-active', unit)).stdout.trim()
      if (active !== 'active' && active !== 'activating') continue
      this.log(`systemctl stop ${unit}`)
      const s = await this.systemctl('stop', unit)
      if (s.code === 0) stopped.push(unit)
      else this.log(s.stderr.trim())
    }
    let result: ExecResult
    try {
      this.log(`restic backup ${paths.join(' ')}`)
      result = await this.restic(plan, ['backup', ...backupArgs(plan, this.file('excludes'), paths)], 24 * 3600_000)
    } finally {
      for (const unit of stopped) {
        this.log(`systemctl start ${unit}`)
        const s = await this.systemctl('start', unit)
        if (s.code !== 0) this.log(s.stderr.trim())
      }
    }
    const rec = backupRunFrom(result.code, result.stdout, result.stderr, startedAt, Date.now())
    for (const e of rec.errors) this.log(e)
    if (rec.status !== 'failed') {
      this.log(msg(m.backup_log_done, { files: rec.files ?? 0, snapshot: rec.snapshot?.slice(0, 8) ?? '' }))
      const f = await this.restic(plan, ['forget', ...forgetArgs(plan)], 6 * 3600_000)
      this.log(f.stdout.trim())
      if (f.code !== 0) {
        this.log(f.stderr.trim())
        rec.status = 'warning'
        rec.errors.push(msg(m.backup_log_forgetFailed, { message: f.stderr.trim().split('\n').pop() ?? '' }))
      }
    } else this.log(rec.message ?? '')
    rec.endedAt = Date.now()
    this.addRun(rec)
    await this.refreshSnapshots(plan)
    return rec
  }

  /** `restic check`, reading a part of the data monthly/weekly. */
  async runCheck(): Promise<BackupRun> {
    const plan = this.plan()
    const startedAt = Date.now()
    if (!plan || !this.installed()) {
      const r: BackupRun = { kind: 'check', startedAt, endedAt: Date.now(), status: 'failed', errors: [], message: msg(plan ? m.backup_error_notInstalled : m.backup_error_notConfigured) }
      this.addRun(r)
      return r
    }
    const r = await this.restic(plan, ['check', '--read-data-subset=5%'], 24 * 3600_000)
    this.log(r.stdout.trim())
    const rec: BackupRun = { kind: 'check', startedAt, endedAt: Date.now(), status: r.code === 0 ? 'ok' : 'failed', errors: [], ...(r.code !== 0 ? { message: r.stderr.trim().split('\n').filter(Boolean).pop() ?? `restic ${r.code}` } : {}) }
    if (r.code !== 0) this.log(r.stderr.trim())
    this.addRun(rec)
    return rec
  }

  /** Restores paths of a snapshot into a folder or in place; returns restic's exit code. */
  async restore(spec: RestoreSpec): Promise<number> {
    const plan = this.requirePlan()
    if (!SNAPSHOT_ID.test(spec.snapshot) || !spec.paths.length || spec.paths.some((p) => absPathProblem(p)) || (spec.target !== undefined && absPathProblem(spec.target))) throw new HttpError(400, msg(m.backup_error_path, { path: spec.target ?? '' }))
    const stopped: string[] = []
    if (spec.target === undefined)
      for (const unit of spec.stop) {
        const active = (await this.systemctl('is-active', unit)).stdout.trim()
        if (active !== 'active' && active !== 'activating') continue
        this.log(`systemctl stop ${unit}`)
        if ((await this.systemctl('stop', unit)).code === 0) stopped.push(unit)
      }
    try {
      if (spec.target) mkdirSync(spec.target, { recursive: true, mode: 0o750 })
      const args = ['restore', spec.snapshot, '--target', spec.target ?? '/', ...spec.paths.flatMap((p) => ['--include', p])]
      this.log(`restic ${args.join(' ')}`)
      const r = await this.restic(plan, args, 24 * 3600_000)
      for (const l of `${r.stdout}\n${r.stderr}`.split('\n').filter(Boolean)) this.log(l)
      return r.code
    } finally {
      for (const unit of stopped) {
        this.log(`systemctl start ${unit}`)
        await this.systemctl('start', unit)
      }
    }
  }
}

/** Every Quadlet file with its content, for the suggestions. */
export function quadletContents(admin: Pick<PodmanAdmin, 'quadlets' | 'readQuadlet'>) {
  return async () => Promise.all((await admin.quadlets()).map(async (f) => ({ name: f.name, content: await admin.readQuadlet(f.name).catch(() => '') })))
}

/** Is a path a directory? (for the restore target check in the web app) */
export function isDir(p: string) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ---------- demo ----------

const DAY = 86_400_000

export class FixtureBackup implements BackupBackend {
  private plan: BackupPlan | undefined
  private runs: BackupRun[] = []
  private snapshots: BackupSnapshot[] = []
  private secrets = new Set<string>()
  private running: 'backup' | 'check' | undefined
  private targetConfig: TargetConfig | undefined = { dataDir: '/srv/backups', port: 8000, appendOnly: false, url: 'http://nas-01.local:8000' }
  private clients: BackupClient[]

  constructor(
    private quadlets: () => Promise<{ name: string; content: string }[]> = async () => [],
    now = Date.now(),
  ) {
    const at = (daysAgo: number) => {
      const d = new Date(now - daysAgo * DAY)
      d.setHours(2, 0, 0, 0)
      return d.getTime()
    }
    this.plan = {
      repo: { kind: 'local', location: '/mnt/backup/restic' },
      paths: ['/srv/immich/upload', '/srv/jellyfin/config', 'volume:caddy-data', '/etc/caddy', '/etc'],
      exclude: { presets: ['caches', 'temp', 'nobackup'], dirs: ['/srv/immich/upload/thumbs', '/srv/immich/upload/encoded-video'], patterns: ['**/.DS_Store'] },
      stop: ['immich.service', 'immich-ml.service'],
      schedule: { every: 'daily', time: '02:00' },
      keep: { daily: 7, weekly: 4, monthly: 6 },
      check: 'monthly',
      passwordSaved: true,
    }
    const added = [1.8, 0.7, 0.4, 0.3, 1.1, 0.6, 6.4, 0.5, 0.3, 0.2, 1.1, 0.4, 0.7, 0.9]
    let total = 371e9
    this.runs = added.map((gb, i) => {
      const startedAt = at(i)
      const warn = i === 3
      const r: BackupRun = {
        kind: 'backup',
        startedAt,
        endedAt: startedAt + (300 + ((i * 37) % 120)) * 1000,
        status: warn ? 'warning' : 'ok',
        snapshot: (0x4f1c9a2e + i * 0x1111).toString(16).padStart(8, '0') + 'c0ffee'.repeat(9).slice(0, 56),
        filesNew: Math.round(gb * 70),
        filesChanged: 12 + i,
        files: 212_408 - i * 60,
        bytes: total,
        added: gb * 1e9,
        errors: warn ? ['/srv/jellyfin/config/log/log_20260930.log: permission denied', '/srv/immich/upload/library/tmp/.lock: file vanished'] : [],
      }
      total -= gb * 1e9
      return r
    })
    const ago = (h: number) => now - h * 3600_000
    this.clients = [
      { name: 'laptop', created: ago(24 * 90), warnDays: 3, lastAt: ago(6), snapshots: 32, size: 84e9, plan: { ...defaultClientPlan(), folders: ['~/Dokumente', '~/Bilder', '~/Projekte'] }, version: 4, applied: { version: 4, at: ago(24 * 2) } },
      { name: 'pc-wohnzimmer', created: ago(24 * 200), warnDays: 3, lastAt: ago(24 * 9 + 2), snapshots: 41, size: 121e9, plan: { ...defaultClientPlan(), schedule: { every: 'daily', time: '20:00' } }, version: 2, applied: { version: 2, at: ago(24 * 21) } },
      { name: 'workstation', created: ago(24 * 30), lastAt: ago(1), snapshots: 18, size: 9e9, plan: { ...defaultClientPlan(), folders: ['~/Projekte', '~/.config'], schedule: { every: '6h', time: '00:00' } }, version: 3, applied: { version: 2, at: ago(24 * 5) } },
    ]
    this.runs.splice(9, 0, { kind: 'check', startedAt: at(9) + 3 * 3600_000, endedAt: at(9) + 3 * 3600_000 + 840_000, status: 'ok', errors: [] })
    const keepDays = [0, 1, 2, 3, 4, 5, 6, 13, 20, 27, 33, 64, 94, 125, 155]
    this.snapshots = keepDays.map((d, i) => {
      const run = this.runs.filter((r) => r.kind === 'backup')[d]
      const time = at(d)
      const id = run?.snapshot ?? (0x31fa8d0c + d * 0x2345).toString(16).padStart(8, '0') + 'ab'.repeat(28)
      return { id, short: id.slice(0, 8), time, paths: this.plan!.paths.map((p) => (p.startsWith('volume:') ? `/var/lib/containers/storage/volumes/${p.slice(7)}/_data` : p)), tags: ['quadeck'], files: run?.files ?? 204_000 - i * 400, bytes: run?.bytes ?? 351e9 - i * 4e9, added: run?.added ?? 0.9e9 }
    })
  }

  async backupState(): Promise<BackupState> {
    return {
      installed: true,
      version: '0.18.1',
      ...(this.plan ? { plan: structuredClone(this.plan) } : {}),
      secretsSet: [...this.secrets],
      ...(this.running ? { running: this.running } : {}),
      next: this.plan ? new Date(new Date().setHours(26, 0, 0, 0)).getTime() : undefined,
      nextCheck: this.plan && this.plan.check !== 'never' ? Date.now() + 21 * DAY : undefined,
      runs: this.runs.slice(0, 30),
      snapshots: this.plan ? this.snapshots : [],
      snapshotsAt: Date.now(),
      repoSize: this.plan ? 412e9 : undefined,
      target: this.plan?.repo.kind === 'local' ? { free: 1.6e12, size: 1.8e12 } : undefined,
    }
  }

  async backupSuggest() {
    return suggestBackup(await this.quadlets())
  }

  async backupSizes(paths: string[], excludes: string[]): Promise<BackupSizes> {
    const size = (p: string) => {
      if (p.includes('immich/upload/thumbs')) return 21e9
      if (p.includes('encoded-video')) return 9.4e9
      if (p.includes('immich/upload')) return 286e9
      if (p.includes('jellyfin/cache')) return 18e9
      if (p.includes('media')) return 3.2e12
      if (p.includes('jellyfin')) return 2.1e9
      if (p.startsWith('volume:')) return 52e6
      if (p === '/etc') return 14e6
      return 1.2e6
    }
    return { paths: paths.map((path) => ({ path, bytes: size(path) })), excludes: excludes.map((path) => ({ path, bytes: size(path) })) }
  }

  async backupLs(snapshot: string, dir: string): Promise<LsEntry[]> {
    if (!SNAPSHOT_ID.test(snapshot)) throw new HttpError(400, msg(m.backup_error_path, { path: dir }))
    const t = (s: string) => Date.parse(s)
    const tree: Record<string, LsEntry[]> = {
      '/': [{ name: 'etc', path: '/etc', type: 'dir', now: 'same' }, { name: 'srv', path: '/srv', type: 'dir', now: 'same' }],
      '/srv': [{ name: 'immich', path: '/srv/immich', type: 'dir', now: 'same' }, { name: 'jellyfin', path: '/srv/jellyfin', type: 'dir', now: 'same' }],
      '/srv/immich': [{ name: 'upload', path: '/srv/immich/upload', type: 'dir', now: 'same' }],
      '/srv/immich/upload': [{ name: 'library', path: '/srv/immich/upload/library', type: 'dir', now: 'same' }, { name: 'profile', path: '/srv/immich/upload/profile', type: 'dir', now: 'same' }],
      '/srv/immich/upload/library': [
        { name: '2022', path: '/srv/immich/upload/library/2022', type: 'dir', mtime: t('2022-12-31T18:00:00Z'), now: 'same' },
        { name: '2023-urlaub', path: '/srv/immich/upload/library/2023-urlaub', type: 'dir', mtime: t('2023-08-14T10:00:00Z'), now: 'missing' },
        { name: '2024', path: '/srv/immich/upload/library/2024', type: 'dir', mtime: t('2024-12-30T10:00:00Z'), now: 'same' },
        { name: '2025', path: '/srv/immich/upload/library/2025', type: 'dir', mtime: t('2026-10-02T10:00:00Z'), now: 'same' },
        { name: 'IMG_4410.HEIC', path: '/srv/immich/upload/library/IMG_4410.HEIC', type: 'file', size: 3_100_000, mtime: t('2026-10-01T09:12:00Z'), now: 'same' },
        { name: 'notes.md', path: '/srv/immich/upload/library/notes.md', type: 'file', size: 4_096, mtime: t('2026-09-28T19:40:00Z'), now: 'changed' },
      ],
      '/srv/jellyfin': [{ name: 'config', path: '/srv/jellyfin/config', type: 'dir', now: 'same' }],
      '/srv/jellyfin/config': [
        { name: 'data', path: '/srv/jellyfin/config/data', type: 'dir', now: 'same' },
        { name: 'system.xml', path: '/srv/jellyfin/config/system.xml', type: 'file', size: 8_412, mtime: t('2026-09-30T08:00:00Z'), now: 'same' },
      ],
      '/etc': [
        { name: 'caddy', path: '/etc/caddy', type: 'dir', now: 'same' },
        { name: 'containers', path: '/etc/containers', type: 'dir', now: 'same' },
        { name: 'fstab', path: '/etc/fstab', type: 'file', size: 1_204, mtime: t('2026-08-11T12:00:00Z'), now: 'same' },
        { name: 'hostname', path: '/etc/hostname', type: 'file', size: 14, mtime: t('2025-03-02T12:00:00Z'), now: 'same' },
      ],
    }
    return tree[dir] ?? []
  }

  async saveBackupPlan(plan: BackupPlan, secrets: Record<string, string>) {
    for (const k of REPO_SECRETS[plan.repo.kind]) if (secrets[k]) this.secrets.add(k)
    const missing = REPO_SECRETS[plan.repo.kind].filter((k) => !this.secrets.has(k))
    if (missing.length) throw new HttpError(400, msg(m.backup_error_secretMissing, { keys: missing.join(', ') }))
    this.plan = plan
    return this.backupState()
  }

  async disableBackup() {
    this.plan = undefined
    return this.backupState()
  }

  async backupPassword() {
    if (!this.plan) throw new HttpError(409, msg(m.backup_error_notConfigured))
    return 'demo-Kx7v2QpR9mLw4ZtN8bYc3HdJ6sFg1Ae5'
  }

  async startBackup(kind: 'backup' | 'check') {
    if (!this.plan) throw new HttpError(409, msg(m.backup_error_notConfigured))
    this.running = kind
    setTimeout(() => {
      this.running = undefined
      const now = Date.now()
      const id = randomBytes(32).toString('hex')
      this.runs.unshift(kind === 'backup' ? { kind, startedAt: now - 4000, endedAt: now, status: 'ok', snapshot: id, filesNew: 3, filesChanged: 2, files: 212_411, bytes: 371.2e9, added: 12e6, errors: [] } : { kind, startedAt: now - 4000, endedAt: now, status: 'ok', errors: [] })
      if (kind === 'backup') this.snapshots.unshift({ id, short: id.slice(0, 8), time: now, paths: this.snapshots[0]?.paths ?? [], tags: ['quadeck'], files: 212_411, bytes: 371.2e9, added: 12e6 })
    }, 1500)
  }

  async backupDump(_snapshot: string, path: string) {
    return new Response(`Demo: content of ${path} from the backup\n`, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${basename(path)}"` } })
  }

  async targetState(): Promise<TargetState> {
    return { ...(this.targetConfig ? { config: { ...this.targetConfig } } : {}), clients: structuredClone(this.clients), ...(this.targetConfig ? { disk: { free: 2.9e12, size: 4e12 } } : {}) }
  }
  async saveTarget(config: TargetConfig) {
    this.targetConfig = config
    return targetQuadlet(config)
  }
  async clearTarget() {
    this.targetConfig = undefined
  }
  async addClient(name: string, warnDays: number | undefined) {
    if (!CLIENT_NAME.test(name)) throw new HttpError(400, msg(m.backup_error_clientName))
    if (!this.targetConfig) throw new HttpError(409, msg(m.backup_error_noTarget))
    if (this.clients.some((c) => c.name === name)) throw new HttpError(409, msg(m.backup_error_clientExists, { name }))
    this.clients.push({ name, created: Date.now(), ...(warnDays ? { warnDays } : {}), snapshots: 0 })
    return { password: accessPassword() }
  }
  async updateClient(name: string, change: { warnDays?: number | null; disabled?: boolean }) {
    const c = this.clients.find((x) => x.name === name)
    if (!c) throw new HttpError(404, msg(m.backup_error_clientUnknown, { name }))
    if (change.warnDays !== undefined) {
      if (change.warnDays === null) delete c.warnDays
      else c.warnDays = change.warnDays
    }
    if (change.disabled !== undefined) {
      if (change.disabled) c.disabled = true
      else delete c.disabled
    }
    return this.targetState()
  }
  async renewClient(name: string) {
    if (!this.clients.some((x) => x.name === name)) throw new HttpError(404, msg(m.backup_error_clientUnknown, { name }))
    return { password: accessPassword() }
  }
  async removeClient(name: string) {
    this.clients = this.clients.filter((c) => c.name !== name)
    return this.targetState()
  }
  private links = new LinkStore()
  async setClientPlan(name: string, plan: ClientPlan) {
    const c = this.clients.find((x) => x.name === name)
    if (!c) throw new HttpError(404, msg(m.backup_error_clientUnknown, { name }))
    c.plan = plan
    c.version = (c.version ?? 0) + 1
    return this.targetState()
  }
  async clientLink(name: string, quadeckUrl: string) {
    if (!this.clients.some((x) => x.name === name)) throw new HttpError(404, msg(m.backup_error_clientUnknown, { name }))
    return this.links.create(name, quadeckUrl)
  }
  async redeemClientLink(token: string) {
    const link = this.links.take(token)
    const c = link && this.clients.find((x) => x.name === link.name)
    if (!link || !c || !this.targetConfig) return undefined
    c.version ??= 0
    c.applied = { version: c.version, at: Date.now() }
    return clientScript({ name: c.name, repo: clientRepo(this.targetConfig, c.name), user: c.name, access: accessPassword(), appendOnly: this.targetConfig.appendOnly, plan: c.plan ?? defaultClientPlan(), version: c.version, quadeckUrl: link.url })
  }
}
