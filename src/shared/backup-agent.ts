// What a backup client's `quadeck-backup` and Quadeck say to each other over
// /api/backup/agent/<name> (Bearer token of the client): the folders it scanned,
// its settings as plain lines (data, never a script), and the result of a run.
// Line formats, because the client is POSIX sh. No I/O here.

import type { BackupRun, ClientAction, FolderListing } from './backup'
import { backupRunFrom, CLIENT_ACTIONS, sizeArg } from './backup'
import { type ClientPlan, type ClientPreset, clientCalendar, clientExcludes, folderProblem } from './backup-client'

/**
 * settings: the plan as lines for the client (and it counts as applied) · plan: the plan as JSON ·
 * poll: the plan's version and the actions waiting for the client (handed out once) ·
 * inventory: the scan (answered with what Quadeck made of it) · report: a run · propose: a new plan
 * from the client (the retention stays Quadeck's) · preview: a draft as settings lines, not saved.
 */
export type AgentKind = 'settings' | 'plan' | 'poll' | 'inventory' | 'report' | 'propose' | 'preview'
export const AGENT_KINDS: AgentKind[] = ['settings', 'plan', 'poll', 'inventory', 'report', 'propose', 'preview']
/** The kinds the client asks with GET; the others carry a body. */
export const AGENT_READS: AgentKind[] = ['settings', 'plan', 'poll']
export type AgentReply = { text: string } | { json: unknown }

export const AGENT_TOKEN = /^[A-Za-z0-9_-]{32}$/
export const AGENT_BODY_MAX = 2 * 1024 * 1024
export const INVENTORY_MAX = 20_000

/** What a folder is, from the scan: a preset that would leave it out, or a git project. */
export type FolderMark = Exclude<ClientPreset, 'temp'> | 'git'

export interface InventoryDir {
  /** `~/…` inside the home, else absolute. */
  path: string
  bytes?: number
  marks?: FolderMark[]
}

export interface ClientInventory {
  at: number
  home: string
  dirs: InventoryDir[]
}

/** Marker files and folders `find` reports: the folder they mark and how. */
const MARKERS: Record<string, { mark: FolderMark; self: boolean }> = {
  'CACHEDIR.TAG': { mark: 'caches', self: false },
  '.nobackup': { mark: 'nobackup', self: false },
  '.git': { mark: 'git', self: false },
  node_modules: { mark: 'dev', self: true },
  '.venv': { mark: 'dev', self: true },
  __pycache__: { mark: 'dev', self: true },
  '.gradle': { mark: 'dev', self: true },
  '.tox': { mark: 'dev', self: true },
}

/** Well-known folders of the home and what they are (the client presets leave them out). */
const KNOWN: Record<string, FolderMark> = {
  '~/.cache': 'caches',
  '~/.local/share/Trash': 'trash',
  '~/.local/share/Steam': 'games',
  '~/.steam': 'games',
  '~/Downloads': 'downloads',
  '~/.local/share/libvirt': 'vms',
  '~/.local/share/gnome-boxes': 'vms',
  '~/VirtualBox VMs': 'vms',
}

const CTRL = /[\x00-\x1f\x7f]/
const parentOf = (p: string) => (p.lastIndexOf('/') <= 0 ? (p.startsWith('~') ? '~' : '/') : p.slice(0, p.lastIndexOf('/')))

/**
 * The scan from `quadeck-backup scan`: `home <abs>`, `d <KiB> <abs path>` per folder (du), and
 * `m <abs path>` per marker (find), tab-separated. Paths come back as `~/…` inside the home.
 */
export function parseInventory(text: string, now = Date.now()): { inventory?: ClientInventory; error?: string } {
  const lines = text.split('\n')
  const head = lines.find((l) => l.startsWith('home\t'))
  const home = head?.slice(5)
  if (!home || folderProblem(home) || !home.startsWith('/')) return { error: 'no home folder in the scan' }
  const rel = (abs: string) => (abs === home ? '~' : abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs)
  const dirs = new Map<string, InventoryDir>()
  const entry = (path: string) => {
    let d = dirs.get(path)
    if (!d) {
      if (dirs.size >= INVENTORY_MAX) return undefined
      d = { path }
      dirs.set(path, d)
    }
    return d
  }
  const mark = (d: InventoryDir | undefined, m: FolderMark) => {
    if (d && !d.marks?.includes(m)) d.marks = [...(d.marks ?? []), m]
  }
  for (const line of lines) {
    const [kind, a, b] = line.split('\t')
    if (kind === 'd' && b !== undefined) {
      const path = rel(b.replace(/\/+$/, '') || '/')
      if (path !== '~' && folderProblem(path)) continue
      const kib = Number(a)
      const d = entry(path)
      if (d && Number.isFinite(kib) && kib >= 0) d.bytes = Math.round(kib * 1024)
    } else if (kind === 'm' && a !== undefined && b === undefined) {
      const path = rel(a.replace(/\/+$/, ''))
      const name = path.slice(path.lastIndexOf('/') + 1)
      const how = Object.hasOwn(MARKERS, name) ? MARKERS[name] : undefined
      if (!how || folderProblem(path)) continue
      const target = how.self ? path : parentOf(path)
      if (target !== '~' && folderProblem(target)) continue
      mark(entry(target), how.mark)
    }
  }
  for (const [path, m] of Object.entries(KNOWN)) mark(dirs.get(path), m)
  return { inventory: { at: now, home, dirs: [...dirs.values()].sort((x, y) => x.path.localeCompare(y.path)) } }
}

/** The sub-folders of `path` in the scan, for the folder browser (with sizes and marks). */
export function inventoryListing(inv: ClientInventory, path: string): FolderListing {
  const p = path.replace(/\/+$/, '') || '/'
  const want = p === inv.home ? '~' : p.startsWith(`${inv.home}/`) ? `~${p.slice(inv.home.length)}` : p
  const known = new Set(inv.dirs.map((d) => d.path))
  let shown = want
  while (shown !== '~' && shown !== '/' && !known.has(shown)) shown = parentOf(shown)
  if (shown === '/' && want.startsWith('~')) shown = '~'
  const prefix = shown === '/' ? '/' : `${shown}/`
  const children = inv.dirs.filter((d) => d.path.startsWith(prefix) && !d.path.slice(prefix.length).includes('/') && d.path !== shown)
  const name = (d: InventoryDir) => d.path.slice(prefix.length)
  const hidden = (n: string) => n.startsWith('.')
  children.sort((a, b) => Number(hidden(name(a))) - Number(hidden(name(b))) || name(a).localeCompare(name(b)))
  return {
    path: shown,
    dirs: children.map(name),
    ...(shown !== want ? { missing: true } : {}),
    sameDisk: [],
    sizes: Object.fromEntries(children.filter((d) => d.bytes !== undefined).map((d) => [name(d), d.bytes!])),
    marks: Object.fromEntries(children.filter((d) => d.marks?.length).map((d) => [name(d), d.marks!])),
    scannedAt: inv.at,
  }
}

const within = (path: string, folder: string) => (folder === '~' ? path.startsWith('~') : path === folder || path.startsWith(`${folder}/`))

/**
 * What the scan found inside the plan's folders that a preset would leave out: per preset the
 * outermost marked folders, their size, and whether the preset is on.
 */
export function inventoryHints(inv: ClientInventory, plan: Pick<ClientPlan, 'folders' | 'exclude'>): { preset: ClientPreset; bytes: number; paths: string[]; on: boolean }[] {
  const out = new Map<ClientPreset, { bytes: number; paths: string[] }>()
  const marked = inv.dirs.filter((d) => plan.folders.some((f) => within(d.path, f)))
  for (const d of marked)
    for (const m of d.marks ?? []) {
      if (m === 'git') continue
      // Only the outermost: node_modules inside node_modules counts once.
      if (marked.some((o) => o !== d && o.marks?.includes(m) && within(d.path, o.path))) continue
      const h = out.get(m) ?? { bytes: 0, paths: [] }
      h.bytes += d.bytes ?? 0
      h.paths.push(d.path)
      out.set(m, h)
    }
  return [...out].map(([preset, h]) => ({ preset, bytes: h.bytes, paths: h.paths.sort(), on: plan.exclude.presets.includes(preset) })).sort((a, b) => b.bytes - a.bytes)
}

/**
 * A client's settings as lines the client reads with `read key value` and checks itself: no
 * line is run as shell code. Ends with `end`, so a cut-off answer is noticed. Without a plan
 * (connected, nothing chosen yet): only the version, `active 0` and no folders.
 */
export function clientSettings(plan: ClientPlan | undefined, version: number, appendOnly: boolean): string {
  if (!plan) return ['quadeck-settings 1', `version ${version}`, 'active 0', `appendonly ${appendOnly ? 1 : 0}`, 'end', ''].join('\n')
  const k = plan.keep
  return [
    'quadeck-settings 1',
    `version ${version}`,
    `active ${plan.active ? 1 : 0}`,
    `calendar ${clientCalendar(plan.schedule)}`,
    `appendonly ${appendOnly ? 1 : 0}`,
    ...plan.exclude.presets.map((p) => `preset ${p}`),
    ...(plan.exclude.maxSizeGB ? [`maxsize ${sizeArg(plan.exclude.maxSizeGB).slice(0, -1)}`] : []), // MiB
    ...(['daily', 'weekly', 'monthly', 'yearly'] as const).filter((r) => k[r]).map((r) => `keep ${r} ${k[r]}`),
    ...plan.folders.map((f) => `folder ${f}`),
    ...clientExcludes(plan)
      .filter((x) => !CTRL.test(x))
      .map((x) => `exclude ${x}`),
    'end',
    '',
  ].join('\n')
}

/**
 * The answer to the client's poll (its agent timer, every 10 minutes): `version=<n>` and
 * `actions=<space-separated list>`, read by `quadeck-backup poll` with a `case` per line.
 */
export function pollText(version: number, actions: ClientAction[]): string {
  return `version=${version}\nactions=${actions.filter((a) => CLIENT_ACTIONS.includes(a)).join(' ')}\n`
}

/** The poll answer as the client reads it: a version that is not a number is none, unknown actions are left out. */
export function parsePoll(text: string): { version?: number; actions: ClientAction[] } {
  let version: number | undefined
  let actions: ClientAction[] = []
  for (const line of text.split('\n')) {
    if (/^version=\d{1,12}$/.test(line)) version = Number(line.slice(8))
    else if (line.startsWith('actions='))
      actions = line
        .slice(8)
        .split(' ')
        .filter((a): a is ClientAction => CLIENT_ACTIONS.includes(a as ClientAction))
  }
  return { ...(version !== undefined ? { version } : {}), actions }
}

/** Adds an action to the client's queue: each once, in the order asked. */
export const queueAction = (actions: ClientAction[] | undefined, a: ClientAction): ClientAction[] => [...(actions ?? []).filter((x) => x !== a), a]

/**
 * A run as the client reports it: `code`, `start`, `end` (seconds), `version`, then restic's
 * `--json` summary and error lines, and `stderr <line>` lines.
 */
export function parseClientReport(text: string, now = Date.now()): { run?: BackupRun; version?: number; error?: string } {
  const head: Record<string, number> = {}
  const json: string[] = []
  const stderr: string[] = []
  for (const line of text.split('\n').slice(0, 2000)) {
    const m = /^(code|start|end|version) (\d{1,12})$/.exec(line)
    if (m) head[m[1]!] = Number(m[2])
    else if (line.startsWith('{')) json.push(line)
    else if (line.startsWith('stderr ')) stderr.push(line.slice(7, 507))
  }
  if (head.code === undefined || !head.start || !head.end) return { error: 'code, start and end are needed' }
  const start = head.start * 1000
  const end = head.end * 1000
  if (end < start || end > now + 86_400_000 || start < now - 30 * 86_400_000) return { error: 'times out of range' }
  const run = backupRunFrom(head.code, json.join('\n'), stderr.slice(-20).join('\n'), start, end)
  // Stored with the client and sent to every browser: only what fits the record.
  if (run.snapshot !== undefined && !/^[0-9a-f]{8,64}$/.test(run.snapshot)) delete run.snapshot
  run.errors = run.errors.slice(0, 20).map((e) => e.slice(0, 500))
  if (run.message) run.message = run.message.slice(0, 500)
  return { run, ...(head.version !== undefined ? { version: head.version } : {}) }
}
