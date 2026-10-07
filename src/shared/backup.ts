// Server backups with restic: the plan, its checks and everything derived from
// it (exclude file, restic arguments, systemd units), suggestions from the
// Quadlets, and restic's JSON output. No I/O here.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'
import { quadletMounts, quadletType, quadletUnit, quadletValues } from './quadlets'

export type RepoKind = 'local' | 'sftp' | 's3' | 'b2' | 'rest'
export const REPO_KINDS: RepoKind[] = ['local', 'sftp', 's3', 'b2', 'rest']

/** Credentials per target, written to a root-only env file, never into the plan. */
export const REPO_SECRETS: Record<RepoKind, string[]> = {
  local: [],
  sftp: [],
  s3: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  b2: ['B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY'],
  rest: ['RESTIC_REST_USERNAME', 'RESTIC_REST_PASSWORD'],
}

export type ExcludePreset = 'caches' | 'temp' | 'logs' | 'nobackup'
export const EXCLUDE_PRESETS: ExcludePreset[] = ['caches', 'temp', 'logs', 'nobackup']
export const DEFAULT_PRESETS: ExcludePreset[] = ['caches', 'temp', 'nobackup']

/** Patterns of the presets that are plain exclude lines (caches and .nobackup are flags). */
export const PRESET_PATTERNS: Record<ExcludePreset, string[]> = {
  caches: [],
  temp: ['*.tmp', '*.part', '*.swp', '.~lock.*'],
  logs: ['*.log'],
  nobackup: [],
}

export type BackupEvery = 'daily' | '6h' | 'weekly'
export type CheckEvery = 'monthly' | 'weekly' | 'never'

export interface BackupPlan {
  repo: { kind: RepoKind; location: string }
  /** Host paths, or `volume:<name>` for a podman volume (resolved at run time). */
  paths: string[]
  exclude: {
    presets: ExcludePreset[]
    /** Concrete directories (e.g. a Jellyfin cache), offered from the Quadlets. */
    dirs: string[]
    /** restic patterns, one per line. */
    patterns: string[]
    maxSizeGB?: number
  }
  /** Units stopped while the backup runs (databases), started again afterwards. */
  stop: string[]
  schedule: { every: BackupEvery; time: string }
  keep: { daily: number; weekly: number; monthly: number }
  check: CheckEvery
  /** The user confirmed they keep the repository password somewhere else. */
  passwordSaved: boolean
}

export interface BackupRun {
  kind: 'backup' | 'check'
  startedAt: number
  endedAt: number
  /** warning: done, but some files could not be read. */
  status: 'ok' | 'warning' | 'failed'
  snapshot?: string
  filesNew?: number
  filesChanged?: number
  files?: number
  bytes?: number
  added?: number
  /** Unreadable files and the like, at most 20. */
  errors: string[]
  message?: string
}

export interface BackupSnapshot {
  id: string
  short: string
  time: number
  paths: string[]
  tags: string[]
  /** From our own run record (restic < 0.17 has no summary in the snapshot). */
  files?: number
  bytes?: number
  added?: number
}

export interface BackupState {
  installed: boolean
  version?: string
  plan?: BackupPlan
  /** Names of the credentials that are set (values never leave the helper). */
  secretsSet: string[]
  running?: 'backup' | 'check'
  next?: number
  nextCheck?: number
  runs: BackupRun[]
  snapshots: BackupSnapshot[]
  snapshotsAt?: number
  repoSize?: number
  /** Local target: the file system it lives on. */
  target?: { free: number; size: number }
  /** Reading the repository failed (offline target, wrong password …). */
  repoError?: string
}

export interface LsEntry {
  name: string
  path: string
  type: 'dir' | 'file' | 'symlink' | 'other'
  size?: number
  mtime?: number
  /** Compared with the server today. */
  now?: 'same' | 'changed' | 'missing'
}

export interface BackupSuggestion {
  paths: { path: string; from: string; checked: boolean; readOnly?: boolean }[]
  /** Directories an app can rebuild by itself (transcodes, thumbnails). */
  excludes: { path: string; label: string; from: string }[]
  stop: { unit: string; from: string; database: boolean }[]
}

/** One folder in the folder browser of the backup setup (names only, never file contents). */
export interface FolderListing {
  /** The folder shown: the one asked for, or its closest existing parent (`missing`). */
  path: string
  /** Sub-folders by name, sorted; hidden ones last. */
  dirs: string[]
  /** The asked-for folder does not exist (yet); restic creates the last part of a target itself. */
  missing?: boolean
  /** The file system the folder is on. */
  disk?: { mount: string; size: number; free: number }
  /** Of the paths compared with: those on the same file system as this folder. */
  sameDisk: string[]
}

export interface BackupSizes {
  paths: { path: string; bytes?: number }[]
  excludes: { path: string; bytes?: number }[]
}

const CTRL = /[\x00-\x1f\x7f]/ // eslint-disable-line no-control-regex
export const VOLUME_PATH = /^volume:[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/
export const SNAPSHOT_ID = /^([0-9a-f]{8,64}|latest)$/
export const STOP_UNIT = /^[A-Za-z0-9:_.\\@-]{1,200}\.service$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const SECRET_VALUE = /^[^\x00-\x1f\x7f]{0,500}$/ // eslint-disable-line no-control-regex

/** An absolute, normalized path without control characters; `/` itself is not allowed. */
export function absPathProblem(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 1024 || CTRL.test(p)) return msg(m.backup_error_path, { path: String(p) })
  if (p === '/' || p.endsWith('/') || p.split('/').some((s, i) => i > 0 && (s === '' || s === '.' || s === '..'))) return msg(m.backup_error_path, { path: p })
  return undefined
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + '/')

function repoProblem(kind: RepoKind, location: string): string | undefined {
  if (!location || location.length > 500 || CTRL.test(location) || /\s/.test(location)) return msg(m.backup_error_repo)
  switch (kind) {
    case 'local':
      return absPathProblem(location)
    case 'sftp':
      // User and host start with a letter or digit: ssh must never see them as an option (-oProxyCommand …).
      return /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*:.+$/.test(location) ? undefined : msg(m.backup_error_repo)
    case 's3':
      return /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?\/[A-Za-z0-9._-]+(\/.*)?$/.test(location) ? undefined : msg(m.backup_error_repo)
    case 'b2':
      return /^[A-Za-z0-9][A-Za-z0-9-]*:.*$/.test(location) ? undefined : msg(m.backup_error_repo)
    case 'rest':
      return /^https?:\/\/[^@/\s]+(\/.*)?$/.test(location) ? undefined : msg(m.backup_error_repo)
  }
}

/** The plan from the web app, checked. Everything that ends up in a unit or a restic argument passes here. */
export function parseBackupPlan(v: unknown): { plan?: BackupPlan; error?: string } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const repo = (o.repo && typeof o.repo === 'object' ? o.repo : {}) as Record<string, unknown>
  const kind = repo.kind as RepoKind
  if (!REPO_KINDS.includes(kind)) return { error: msg(m.backup_error_repo) }
  const location = typeof repo.location === 'string' ? repo.location.trim() : ''
  const rp = repoProblem(kind, location)
  if (rp) return { error: rp }

  const paths = Array.isArray(o.paths) ? [...new Set(o.paths as unknown[])] : []
  if (!paths.length) return { error: msg(m.backup_error_noPaths) }
  if (paths.length > 50) return { error: msg(m.backup_error_tooMany) }
  for (const p of paths) {
    if (typeof p === 'string' && VOLUME_PATH.test(p)) continue
    const pr = absPathProblem(p)
    if (pr) return { error: pr }
  }
  if (kind === 'local') {
    const clash = (paths as string[]).find((p) => p.startsWith('/') && (inside(location, p) || inside(p, location)))
    if (clash) return { error: msg(m.backup_error_repoInside, { path: clash }) }
  }

  const ex = (o.exclude && typeof o.exclude === 'object' ? o.exclude : {}) as Record<string, unknown>
  const presets = (Array.isArray(ex.presets) ? ex.presets : []).filter((x): x is ExcludePreset => EXCLUDE_PRESETS.includes(x as ExcludePreset))
  const dirs = Array.isArray(ex.dirs) ? [...new Set(ex.dirs as unknown[])] : []
  if (dirs.length > 50) return { error: msg(m.backup_error_tooMany) }
  for (const d of dirs) {
    const pr = absPathProblem(d)
    if (pr) return { error: pr }
  }
  const patterns = (Array.isArray(ex.patterns) ? ex.patterns : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
  if (patterns.length > 200 || patterns.some((x) => x.length > 300 || CTRL.test(x))) return { error: msg(m.backup_error_pattern) }
  let maxSizeGB: number | undefined
  if (ex.maxSizeGB !== undefined && ex.maxSizeGB !== null) {
    maxSizeGB = Number(ex.maxSizeGB)
    if (!Number.isFinite(maxSizeGB) || maxSizeGB <= 0 || maxSizeGB > 100_000) return { error: msg(m.backup_error_maxSize) }
  }

  const stop = Array.isArray(o.stop) ? [...new Set(o.stop as unknown[])] : []
  if (stop.length > 30 || !stop.every((u) => typeof u === 'string' && STOP_UNIT.test(u) && !u.startsWith('-'))) return { error: msg(m.backup_error_unit) }

  const sched = (o.schedule && typeof o.schedule === 'object' ? o.schedule : {}) as Record<string, unknown>
  const every = sched.every as BackupEvery
  if (!['daily', '6h', 'weekly'].includes(every) || typeof sched.time !== 'string' || !TIME.test(sched.time)) return { error: msg(m.backup_error_schedule) }

  const k = (o.keep && typeof o.keep === 'object' ? o.keep : {}) as Record<string, unknown>
  const num = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 1000 ? (x as number) : NaN)
  const keep = { daily: num(k.daily), weekly: num(k.weekly), monthly: num(k.monthly) }
  if (Object.values(keep).some(Number.isNaN) || keep.daily + keep.weekly + keep.monthly === 0) return { error: msg(m.backup_error_keep) }

  const check = (['monthly', 'weekly', 'never'].includes(o.check as string) ? o.check : 'monthly') as CheckEvery
  return {
    plan: {
      repo: { kind, location },
      paths: paths as string[],
      exclude: { presets, dirs: dirs as string[], patterns, ...(maxSizeGB ? { maxSizeGB } : {}) },
      stop: stop as string[],
      schedule: { every, time: sched.time },
      keep,
      check,
      passwordSaved: o.passwordSaved === true,
    },
  }
}

/** Credentials from the web app: only the names the target needs; an empty value keeps the stored one. */
export function parseSecrets(kind: RepoKind, v: unknown): { secrets?: Record<string, string>; error?: string } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of REPO_SECRETS[kind]) {
    const val = o[key]
    if (val === undefined || val === '') continue
    if (typeof val !== 'string' || !SECRET_VALUE.test(val)) return { error: msg(m.backup_error_secret, { key }) }
    out[key] = val
  }
  return { secrets: out }
}

export function repoString(r: BackupPlan['repo']): string {
  return r.kind === 'local' ? r.location : `${r.kind}:${r.location}`
}

/** Lines of the exclude file restic reads with --exclude-file. */
export function excludeFile(plan: BackupPlan): string {
  const lines = ['# Written by Quadeck – changes are overwritten', ...plan.exclude.presets.flatMap((p) => PRESET_PATTERNS[p]), ...plan.exclude.dirs, ...plan.exclude.patterns]
  return lines.join('\n') + '\n'
}

/** `restic backup` arguments after the command (paths already resolved). */
export function backupArgs(plan: BackupPlan, excludeFilePath: string, paths: string[]): string[] {
  return [
    '--json',
    '--tag',
    'quadeck',
    '--exclude-file',
    excludeFilePath,
    ...(plan.exclude.presets.includes('caches') ? ['--exclude-caches'] : []),
    ...(plan.exclude.presets.includes('nobackup') ? ['--exclude-if-present', '.nobackup'] : []),
    ...(plan.exclude.maxSizeGB ? ['--exclude-larger-than', `${plan.exclude.maxSizeGB}G`] : []),
    '--',
    ...paths,
  ]
}

export function forgetArgs(plan: BackupPlan): string[] {
  const k = plan.keep
  return ['--tag', 'quadeck', '--prune', ...(k.daily ? ['--keep-daily', String(k.daily)] : []), ...(k.weekly ? ['--keep-weekly', String(k.weekly)] : []), ...(k.monthly ? ['--keep-monthly', String(k.monthly)] : [])]
}

/** Roughly how many snapshots the retention keeps and how far back the oldest goes, in days. */
export function retentionEstimate(keep: BackupPlan['keep']): { count: number; days: number } {
  const days = Math.max(keep.daily, keep.weekly * 7, keep.monthly * 30)
  const weekly = Math.max(0, keep.weekly - Math.floor(keep.daily / 7))
  const monthly = Math.max(0, keep.monthly - Math.floor(Math.max(keep.daily, keep.weekly * 7) / 30))
  return { count: keep.daily + weekly + monthly, days }
}

export function onCalendar(s: BackupPlan['schedule']): string {
  const [h, m] = s.time.split(':').map(Number) as [number, number]
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  if (s.every === '6h') return `*-*-* ${h % 6}/6:${mm}:00`
  if (s.every === 'weekly') return `Sun *-*-* ${hh}:${mm}:00`
  return `*-*-* ${hh}:${mm}:00`
}

/** The check runs at the backup time plus three hours, on the first of the month or on Sundays. */
export function checkCalendar(plan: BackupPlan): string | undefined {
  if (plan.check === 'never') return undefined
  const [h, m] = plan.schedule.time.split(':').map(Number) as [number, number]
  const t = `${String((h + 3) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
  return plan.check === 'weekly' ? `Sun *-*-* ${t}` : `*-*-01 ${t}`
}

export const BACKUP_UNIT = 'quadeck-backup.service'
export const BACKUP_TIMER = 'quadeck-backup.timer'
export const CHECK_UNIT = 'quadeck-backup-check.service'
export const CHECK_TIMER = 'quadeck-backup-check.timer'

const quoteArg = (a: string) => (/^[A-Za-z0-9_./=:@%+-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`)

/** Unit files for /etc/systemd/system: the backup and, unless off, the check, each with a timer. */
export function backupUnits(plan: BackupPlan, self: string[], dir?: string): Record<string, string | null> {
  const exec = (cmd: string) => [...self, 'backup', cmd].map(quoteArg).join(' ')
  const service = (what: string, cmd: string) =>
    `# Written by Quadeck (Backups page) – changes are overwritten\n[Unit]\nDescription=Quadeck: ${what}\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=oneshot\n${dir ? `Environment=${quoteArg(`QUADECK_BACKUP_DIR=${dir}`)}\n` : ''}ExecStart=${exec(cmd)}\nNice=10\nIOSchedulingClass=idle\n`
  const timer = (what: string, cal: string) => `# Written by Quadeck (Backups page) – changes are overwritten\n[Unit]\nDescription=Quadeck: ${what}\n\n[Timer]\nOnCalendar=${cal}\nPersistent=true\nRandomizedDelaySec=5min\n\n[Install]\nWantedBy=timers.target\n`
  const check = checkCalendar(plan)
  return {
    [BACKUP_UNIT]: service('backup (restic)', 'run'),
    [BACKUP_TIMER]: timer('backup schedule', onCalendar(plan.schedule)),
    [CHECK_UNIT]: check ? service('check the backup repository (restic)', 'check') : null,
    [CHECK_TIMER]: check ? timer('backup check schedule', check) : null,
  }
}

// ---------- suggestions from the Quadlets ----------

const DATABASE_IMAGE = /postgres|postgis|pgvecto|mariadb|mysql|mongo|influxdb|couchdb/i
const SKIP_SOURCES = /^\/(run|dev|proc|sys|tmp)(\/|$)|^\/var\/run(\/|$)|\.sock$/

/** Directories an app rebuilds by itself: [image pattern, path inside the container, sub-directory, label key]. */
const REBUILDABLE: { image: RegExp; dest: string[]; sub: string[]; label: () => string }[] = [
  { image: /jellyfin/i, dest: ['/cache'], sub: [''], label: () => msg(m.backup_app_jellyfinCache) },
  { image: /immich-server|immich-app\/immich$/i, dest: ['/usr/src/app/upload', '/data'], sub: ['thumbs', 'encoded-video'], label: () => msg(m.backup_app_immichThumbs) },
]

export function suggestBackup(files: { name: string; content: string }[]): BackupSuggestion {
  const paths: BackupSuggestion['paths'] = []
  const excludes: BackupSuggestion['excludes'] = []
  const stop: BackupSuggestion['stop'] = []
  const seen = new Set<string>()
  for (const f of files.filter((x) => quadletType(x.name) === 'container').sort((a, b) => a.name.localeCompare(b.name))) {
    const from = f.name.split('/').pop()!.replace(/\.container$/, '')
    const image = quadletValues(f.content, 'Container', 'Image')[0] ?? ''
    const mounts = quadletMounts(f.content, 'Container', files)
    for (const mnt of mounts) {
      const rebuild = REBUILDABLE.find((r) => r.image.test(image) && r.dest.includes(mnt.dest.replace(/\/$/, '')))
      if (mnt.kind === 'bind') {
        if (!mnt.source.startsWith('/') || SKIP_SOURCES.test(mnt.source) || absPathProblem(mnt.source.replace(/\/$/, ''))) continue
        // System files handed in read-only (/etc/localtime …): part of the system, not of the app.
        if (mnt.readOnly && /^\/(etc|usr)\//.test(mnt.source)) continue
        const source = mnt.source.replace(/\/$/, '')
        if (rebuild) {
          for (const sub of rebuild.sub) excludes.push({ path: sub ? `${source}/${sub}` : source, label: rebuild.label(), from })
          if (rebuild.sub.includes('')) continue // the whole mount is rebuildable
        }
        if (seen.has(source)) continue
        seen.add(source)
        paths.push({ path: source, from, checked: !mnt.readOnly, ...(mnt.readOnly ? { readOnly: true } : {}) })
      } else {
        const path = `volume:${mnt.source}`
        if (!VOLUME_PATH.test(path) || seen.has(path)) continue
        seen.add(path)
        paths.push({ path, from, checked: !rebuild?.sub.includes('') })
      }
    }
    stop.push({ unit: quadletUnit(f.name), from, database: DATABASE_IMAGE.test(image) })
  }
  paths.push({ path: '/etc', from: 'System', checked: true })
  return { paths, excludes, stop }
}

/** The plan the setup dialog starts with. */
export function defaultPlan(s: BackupSuggestion): BackupPlan {
  return {
    repo: { kind: 'local', location: '' },
    paths: s.paths.filter((p) => p.checked).map((p) => p.path),
    exclude: { presets: [...DEFAULT_PRESETS], dirs: s.excludes.map((e) => e.path), patterns: [] },
    stop: s.stop.filter((x) => x.database).map((x) => x.unit),
    schedule: { every: 'daily', time: '02:00' },
    keep: { daily: 7, weekly: 4, monthly: 6 },
    check: 'monthly',
    passwordSaved: false,
  }
}

// ---------- restic output ----------

const jsonLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>]
      } catch {
        return []
      }
    })

/** `restic backup --json`: the summary and the errors. */
export function parseBackupOutput(stdout: string): { summary?: Record<string, number | string>; errors: string[] } {
  let summary: Record<string, number | string> | undefined
  const errors: string[] = []
  for (const o of jsonLines(stdout)) {
    if (o.message_type === 'summary') summary = o as Record<string, number | string>
    else if (o.message_type === 'error' && errors.length < 20) {
      const e = o.error as { message?: string } | undefined
      errors.push([o.item, e?.message].filter(Boolean).join(': ') || String(o.during ?? 'error'))
    }
  }
  return { summary, errors }
}

/** The run record for `restic backup` with its exit code (3: done, some files unreadable). */
export function backupRunFrom(code: number, stdout: string, stderr: string, startedAt: number, endedAt: number): BackupRun {
  const { summary, errors } = parseBackupOutput(stdout)
  const n = (k: string) => (typeof summary?.[k] === 'number' ? (summary[k] as number) : undefined)
  const ok = code === 0 || (code === 3 && !!summary)
  const lastErr = stderr.trim().split('\n').filter(Boolean).pop()
  return {
    kind: 'backup',
    startedAt,
    endedAt,
    status: !ok ? 'failed' : code === 3 || errors.length ? 'warning' : 'ok',
    ...(summary?.snapshot_id ? { snapshot: String(summary.snapshot_id) } : {}),
    filesNew: n('files_new'),
    filesChanged: n('files_changed'),
    files: n('total_files_processed'),
    bytes: n('total_bytes_processed'),
    added: n('data_added'),
    errors,
    ...(!ok ? { message: lastErr || `restic exited ${code}` } : {}),
  }
}

/** `restic snapshots --json`, newest first, with sizes from our run records. */
export function parseSnapshots(json: string, runs: BackupRun[] = []): BackupSnapshot[] {
  let list: Record<string, unknown>[]
  try {
    list = JSON.parse(json) as Record<string, unknown>[]
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const byId = new Map(runs.filter((r) => r.snapshot).map((r) => [r.snapshot!, r]))
  return list
    .filter((s) => typeof s.id === 'string')
    .map((s) => {
      const id = s.id as string
      const sum = (s.summary ?? {}) as Record<string, number>
      const run = byId.get(id) ?? [...byId.entries()].find(([k]) => id.startsWith(k) || k.startsWith(id))?.[1]
      return {
        id,
        short: (s.short_id as string) ?? id.slice(0, 8),
        time: Date.parse(s.time as string),
        paths: (s.paths as string[]) ?? [],
        tags: (s.tags as string[]) ?? [],
        files: sum.total_files_processed ?? run?.files,
        bytes: sum.total_bytes_processed ?? run?.bytes,
        added: sum.data_added ?? run?.added,
      }
    })
    .sort((a, b) => b.time - a.time)
}

/** `restic ls --json <snapshot> <dir>`: the direct children of dir. */
export function parseLs(stdout: string, dir: string): LsEntry[] {
  const base = dir === '/' ? '' : dir.replace(/\/$/, '')
  return jsonLines(stdout)
    .filter((o) => (o.struct_type === 'node' || o.message_type === 'node' || (o.path && o.name && !o.struct_type)) && typeof o.path === 'string')
    .filter((o) => {
      const p = o.path as string
      return p !== base && p.slice(0, p.lastIndexOf('/')) === base
    })
    .map((o) => ({
      name: o.name as string,
      path: o.path as string,
      type: (['dir', 'file', 'symlink'].includes(o.type as string) ? o.type : 'other') as LsEntry['type'],
      ...(typeof o.size === 'number' ? { size: o.size } : {}),
      ...(typeof o.mtime === 'string' ? { mtime: Date.parse(o.mtime) } : {}),
    }))
    .sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
}

/** Alert for the notifications: the last backup failed, or none succeeded for `days`. */
export function backupAlert(state: Pick<BackupState, 'plan' | 'runs'>, days: number, now = Date.now()): string | undefined {
  if (!state.plan) return undefined
  const backups = state.runs.filter((r) => r.kind === 'backup')
  const last = backups[0]
  if (last?.status === 'failed') return msg(m.backup_alert_failed, { message: last.message ?? '' })
  const ok = backups.find((r) => r.status !== 'failed')
  const since = ok?.endedAt
  if (since === undefined) return backups.length ? msg(m.backup_alert_never) : undefined
  const age = (now - since) / 86_400_000
  return age >= days ? msg(m.backup_alert_old, { days: Math.floor(age) }) : undefined
}

// ---------- backup target for clients (restic rest-server) ----------

export const TARGET_QUADLET = 'quadeck-rest-server.container'
export const TARGET_UNIT = 'quadeck-rest-server.service'
export const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

export interface TargetConfig {
  /** Where the repositories live, one folder per client. */
  dataDir: string
  port: number
  /** Clients may add snapshots but not delete them (ransomware on a client cannot wipe its backups). */
  appendOnly: boolean
  /** How the clients reach it, e.g. http://nas.lan:8000 (shown in the instructions). */
  url: string
}

export interface BackupClient {
  name: string
  created: number
  /** Warn when the client has not backed up for this many days. */
  warnDays?: number
  /** Access removed from .htpasswd; the repository stays. */
  disabled?: boolean
  /** Newest file in the repository's snapshots/ folder: the last backup, readable without the password. */
  lastAt?: number
  snapshots?: number
  size?: number
  /** What the client backs up, carried there by the script. */
  plan?: import('./backup-client').ClientPlan
  /** Raised with every change of the plan. */
  version?: number
  /** The settings version the client last fetched with its script. */
  applied?: { version: number; at: number }
}

export interface TargetState {
  config?: TargetConfig
  clients: BackupClient[]
  /** Free space where the repositories live. */
  disk?: { free: number; size: number }
}

export function parseTargetConfig(v: unknown): { config?: TargetConfig; error?: string } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const dataDir = typeof o.dataDir === 'string' ? o.dataDir.trim().replace(/\/+$/, '') : ''
  const pp = absPathProblem(dataDir)
  if (pp) return { error: pp }
  const port = Number(o.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: msg(m.backup_error_port) }
  const url = typeof o.url === 'string' ? o.url.trim().replace(/\/+$/, '') : ''
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url)) return { error: msg(m.backup_error_url) }
  return { config: { dataDir, port, appendOnly: o.appendOnly === true, url } }
}

/** The Quadlet for the rest-server: one container for all clients, a folder per client. */
export function targetQuadlet(c: TargetConfig): string {
  const options = ['--private-repos', ...(c.appendOnly ? ['--append-only'] : [])].join(' ')
  return `# Backup target for clients, set up on Quadeck's Backups page
[Unit]
Description=restic rest-server (backup target for clients)

[Container]
Image=docker.io/restic/rest-server:latest
ContainerName=quadeck-rest-server
Volume=${c.dataDir}:/data:Z
Environment=OPTIONS="${options}"
PublishPort=${c.port}:8000
AutoUpdate=registry

[Service]
Restart=always

[Install]
WantedBy=multi-user.target default.target
`
}

/** restic's repository address for a client. */
export const clientRepo = (c: TargetConfig, name: string) => `rest:${c.url}/${name}/`

/** Clients that have not backed up for longer than they should. */
export function staleClients(clients: Pick<BackupClient, 'name' | 'warnDays' | 'disabled' | 'lastAt' | 'created'>[], now = Date.now()): { name: string; days: number; never: boolean }[] {
  return clients
    .filter((c) => c.warnDays && !c.disabled)
    .map((c) => ({ name: c.name, days: Math.floor((now - (c.lastAt ?? c.created)) / 86_400_000), never: c.lastAt === undefined, warn: c.warnDays! }))
    .filter((c) => c.days >= c.warn)
    .map(({ name, days, never }) => ({ name, days, never }))
}

/** Days after which a missing client backup is reported: 1–60, null for never. */
export function parseWarnDays(v: unknown): number | null {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isInteger(n) || n < 1 || n > 60 ? null : n
}

export function parseClientChange(v: unknown): { warnDays?: number | null; disabled?: boolean } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { ...('warnDays' in o ? { warnDays: parseWarnDays(o.warnDays) } : {}), ...(typeof o.disabled === 'boolean' ? { disabled: o.disabled } : {}) }
}
