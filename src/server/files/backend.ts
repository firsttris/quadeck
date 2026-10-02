// File explorer on the host. Everything is confined to "roots" (data
// areas): /mnt, /srv, /media, /home, /data and mounted data filesystems –
// never the system. Symlinks are resolved before the check, so a link
// cannot lead out. Copy/move/delete run as jobs (`quadeck job`).

import { chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync, statSync, type Stats } from 'node:fs'
import { HttpError } from '../auth'
import { tr } from '~/shared/i18n'
import type { FsOps } from './transfer'
import { baseName, joinPath, MAX_ENTRIES, parentOf, validateName, validatePath, type DirListing, type FileEntry, type FileRoot } from '~/shared/files'

export interface FilesAdmin {
  fileRoots(): Promise<FileRoot[]>
  listDir(path: string): Promise<DirListing>
}

export interface FilesBackend extends FilesAdmin {
  makeDir(path: string): Promise<void>
  renamePath(path: string, newName: string): Promise<void>
}

const DEFAULT_ROOTS = ['/mnt', '/srv', '/media', '/home', '/data']
const VIRTUAL_FS = /^(proc|sysfs|tmpfs|devtmpfs|devpts|cgroup2?|securityfs|pstore|bpf|debugfs|tracefs|configfs|fusectl|mqueue|hugetlbfs|autofs|overlay|nsfs|ramfs|efivarfs|binfmt_misc|rpc_pipefs|nfsd|fuse\.portal|squashfs)$/
const SYSTEM = /^\/(boot|efi|etc|root|proc|sys|dev|run|var|usr|bin|sbin|lib|lib64|opt|snap)(\/|$)/

/** QUADECK_FILE_ROOTS (comma separated) or the default data areas plus data mounts outside them. */
export function fileRootPaths(env = process.env.QUADECK_FILE_ROOTS, mounts = '/proc/self/mounts'): string[] {
  const configured = env
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const candidates = configured?.length ? configured : [...DEFAULT_ROOTS]
  if (!configured?.length) {
    let text = ''
    try {
      text = readFileSync(mounts, 'utf8')
    } catch {
      // no /proc
    }
    for (const line of text.split('\n')) {
      const [dev, mp, fs] = line.split(' ')
      if (!dev || !mp || !fs || VIRTUAL_FS.test(fs) || !dev.startsWith('/dev/')) continue
      const path = mp.replace(/\\040/g, ' ')
      if (path === '/' || SYSTEM.test(path) || candidates.some((c) => path === c || path.startsWith(c + '/'))) continue
      candidates.push(path)
    }
  }
  const out: string[] = []
  for (const c of candidates) {
    try {
      const real = realpathSync(c)
      if (real === '/' || SYSTEM.test(real) || !statSync(real).isDirectory()) continue
      if (!out.includes(real)) out.push(real)
    } catch {
      // missing
    }
  }
  return out
}

/**
 * Resolves a path (symlinks included) and checks it lies inside a root.
 * `parentOnly`: the last part may not exist yet (new names) – then the
 * parent is resolved instead.
 */
export function resolveInRoots(path: string, roots: string[], opts: { parentOnly?: boolean; allowRoot?: boolean } = {}): { real: string; root: string } {
  const bad = validatePath(path)
  if (bad) throw new HttpError(400, bad)
  let real: string
  try {
    real = opts.parentOnly ? joinPath(realpathSync(parentOf(path)), baseName(path)) : realpathSync(path)
  } catch {
    throw new HttpError(404, tr(`${path} existiert nicht`, `${path} does not exist`))
  }
  const root = roots.find((r) => real === r || real.startsWith(r + '/'))
  if (!root) throw new HttpError(403, tr(`${path} liegt außerhalb der freigegebenen Bereiche`, `${path} is outside the shared areas`))
  if (real === root && !opts.allowRoot) throw new HttpError(403, tr(`${root} selbst kann nicht verändert werden`, `${root} itself cannot be changed`))
  return { real, root }
}

function idNames(file: string): Map<number, string> {
  const m = new Map<number, string>()
  try {
    for (const l of readFileSync(file, 'utf8').split('\n')) {
      const f = l.split(':')
      if (f.length > 2) m.set(Number(f[2]), f[0]!)
    }
  } catch {
    // none
  }
  return m
}

export function entryFrom(name: string, st: Stats, users: Map<number, string>, groups: Map<number, string>, target?: string): FileEntry {
  return {
    name,
    type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.isFile() ? st.size : 0,
    mtime: st.mtimeMs,
    mode: (st.mode & 0o7777).toString(8).padStart(3, '0'),
    owner: users.get(st.uid) ?? String(st.uid),
    group: groups.get(st.gid) ?? String(st.gid),
    target,
  }
}

export class SystemFiles implements FilesBackend {
  constructor(private rootsFn: () => string[] = () => fileRootPaths()) {}

  async fileRoots(): Promise<FileRoot[]> {
    return this.rootsFn().map((path) => {
      let free: number | undefined
      let size: number | undefined
      try {
        const s = statfsSync(path)
        free = s.bavail * s.bsize
        size = s.blocks * s.bsize
      } catch {
        // unknown
      }
      return { path, label: path, free, size }
    })
  }

  async listDir(path: string): Promise<DirListing> {
    const { real, root } = resolveInRoots(path, this.rootsFn(), { allowRoot: true })
    if (!statSync(real).isDirectory()) throw new HttpError(400, tr(`${path} ist kein Ordner`, `${path} is not a folder`))
    const users = idNames('/etc/passwd')
    const groups = idNames('/etc/group')
    const names = readdirSync(real)
    const entries: FileEntry[] = []
    for (const name of names.slice(0, MAX_ENTRIES)) {
      try {
        const p = joinPath(real, name)
        const st = lstatSync(p)
        let target: string | undefined
        if (st.isSymbolicLink()) {
          try {
            target = realpathSync(p)
          } catch {
            target = tr('(Ziel fehlt)', '(target missing)')
          }
        }
        entries.push(entryFrom(name, st, users, groups, target))
      } catch {
        // vanished
      }
    }
    return { path: real, root, entries, truncated: names.length > MAX_ENTRIES }
  }

  async makeDir(path: string) {
    const bad = validateName(baseName(path))
    if (bad) throw new HttpError(400, bad)
    const { real } = resolveInRoots(path, this.rootsFn(), { parentOnly: true })
    if (existsSync(real)) throw new HttpError(409, tr(`${baseName(path)} gibt es schon`, `${baseName(path)} already exists`))
    mkdirSync(real, { mode: 0o775 })
    // Same owner as the folder it lives in (not root).
    const parent = statSync(parentOf(real))
    chownSync(real, parent.uid, parent.gid)
  }

  async renamePath(path: string, newName: string) {
    const bad = validateName(newName)
    if (bad) throw new HttpError(400, bad)
    // The entry itself, not its symlink target, is renamed.
    const { real } = resolveInRoots(path, this.rootsFn(), { parentOnly: true })
    const dest = joinPath(parentOf(real), newName)
    if (existsSync(dest)) throw new HttpError(409, tr(`${newName} gibt es schon`, `${newName} already exists`))
    try {
      lstatSync(real)
    } catch {
      throw new HttpError(404, tr(`${path} existiert nicht`, `${path} does not exist`))
    }
    renameSync(real, dest)
  }
}

// ---------- fixtures ----------

interface Node {
  type: 'dir' | 'file'
  size: number
  mtime: number
  owner: string
  children?: Map<string, Node>
}

/** Demo tree in memory; copy/move/delete are applied by the fixture job runner. */
export class FixtureFiles implements FilesBackend {
  private tree = new Map<string, Node>()

  constructor() {
    const now = Date.now()
    const dir = (owner = 'tristan', children: Record<string, Node> = {}): Node => ({ type: 'dir', size: 0, mtime: now - 86_400_000 * 3, owner, children: new Map(Object.entries(children)) })
    const file = (size: number, days = 10): Node => ({ type: 'file', size, mtime: now - 86_400_000 * days, owner: 'tristan' })
    this.tree.set(
      '/mnt/disk1',
      dir('root', {
        Filme: dir('tristan', { 'Der Pate (1972).mkv': file(8_400_000_000, 400), 'Inception (2010).mkv': file(6_100_000_000, 200), 'Arrival (2016).mkv': file(5_300_000_000, 30) }),
        Serien: dir('tristan', { 'The Expanse': dir('tristan', { 'Staffel 1': dir('tristan', { 'S01E01.mkv': file(1_400_000_000), 'S01E02.mkv': file(1_350_000_000) }) }) }),
        Downloads: dir('tristan', { 'ubuntu-24.04.iso': file(6_200_000_000, 2), 'alt.zip': file(120_000_000, 90) }),
      }),
    )
    this.tree.set('/mnt/disk2', dir('root', { Fotos: dir('tristan', { '2024': dir('tristan', { 'IMG_0001.jpg': file(4_200_000, 300), 'IMG_0002.jpg': file(3_900_000, 300) }) }), Backup: dir('root') }))
    this.tree.set('/srv', dir('root', { jellyfin: dir('root', { config: dir('root') }) }))
  }

  private node(path: string): Node | undefined {
    const root = [...this.tree.keys()].find((r) => path === r || path.startsWith(r + '/'))
    if (!root) return undefined
    let n = this.tree.get(root)!
    for (const part of path.slice(root.length).split('/').filter(Boolean)) {
      const c = n.children?.get(part)
      if (!c) return undefined
      n = c
    }
    return n
  }

  private rootOf(path: string) {
    const bad = validatePath(path)
    if (bad) throw new HttpError(400, bad)
    const root = [...this.tree.keys()].find((r) => path === r || path.startsWith(r + '/'))
    if (!root) throw new HttpError(403, tr(`${path} liegt außerhalb der freigegebenen Bereiche`, `${path} is outside the shared areas`))
    return root
  }

  async fileRoots() {
    return [...this.tree.keys()].map((path) => ({ path, label: path, free: 3_200_000_000_000, size: 12_000_000_000_000 }))
  }

  async listDir(path: string): Promise<DirListing> {
    const root = this.rootOf(path)
    const n = this.node(path)
    if (!n) throw new HttpError(404, tr(`${path} existiert nicht`, `${path} does not exist`))
    if (n.type !== 'dir') throw new HttpError(400, tr(`${path} ist kein Ordner`, `${path} is not a folder`))
    const entries = [...n.children!].map(([name, c]) => ({ name, type: c.type, size: c.size, mtime: c.mtime, mode: c.type === 'dir' ? '775' : '664', owner: c.owner, group: c.owner === 'root' ? 'root' : 'users' }))
    return { path, root, entries, truncated: false }
  }

  async makeDir(path: string) {
    const bad = validateName(baseName(path))
    if (bad) throw new HttpError(400, bad)
    const root = this.rootOf(path)
    if (path === root) throw new HttpError(403, tr('Bereich selbst', 'The area itself'))
    const parent = this.node(parentOf(path))
    if (!parent?.children) throw new HttpError(404, tr(`${parentOf(path)} existiert nicht`, `${parentOf(path)} does not exist`))
    if (parent.children.has(baseName(path))) throw new HttpError(409, tr(`${baseName(path)} gibt es schon`, `${baseName(path)} already exists`))
    parent.children.set(baseName(path), { type: 'dir', size: 0, mtime: Date.now(), owner: parent.owner, children: new Map() })
  }

  async renamePath(path: string, newName: string) {
    const bad = validateName(newName)
    if (bad) throw new HttpError(400, bad)
    const root = this.rootOf(path)
    if (path === root) throw new HttpError(403, tr(`${root} selbst kann nicht verändert werden`, `${root} itself cannot be changed`))
    const parent = this.node(parentOf(path))!
    const n = parent?.children?.get(baseName(path))
    if (!n) throw new HttpError(404, tr(`${path} existiert nicht`, `${path} does not exist`))
    if (parent.children!.has(newName)) throw new HttpError(409, tr(`${newName} gibt es schon`, `${newName} already exists`))
    parent.children!.delete(baseName(path))
    parent.children!.set(newName, n)
  }

  /** Applies a copy/move/delete job; returns the lines a real run would print. */
  apply(kind: 'copy' | 'move' | 'delete', paths: string[], toDir?: string): string[] {
    const lines: string[] = []
    for (const p of paths) {
      const parent = this.node(parentOf(p))
      const n = parent?.children?.get(baseName(p))
      if (!n || !parent?.children) throw new Error(tr(`${p} existiert nicht`, `${p} does not exist`))
      if (kind === 'delete') {
        parent.children.delete(baseName(p))
        lines.push(`removed '${p}'`)
        continue
      }
      const dest = this.node(toDir!)
      if (!dest?.children) throw new Error(tr(`${toDir} existiert nicht`, `${toDir} does not exist`))
      dest.children.set(baseName(p), kind === 'copy' ? structuredClone(n) : n)
      if (kind === 'move') parent.children.delete(baseName(p))
      lines.push(`'${p}' -> '${joinPath(toDir!, baseName(p))}'`)
    }
    return lines
  }

  exists(path: string) {
    return !!this.node(path)
  }

  /** The same checks as on a real system (see transfer.ts). */
  ops(): FsOps {
    return {
      entry: (p) => {
        const root = this.rootOf(p)
        if (p === root) throw new HttpError(403, tr(`${root} selbst kann nicht verändert werden`, `${root} itself cannot be changed`))
        if (!this.node(p)) throw new HttpError(404, tr(`${p} existiert nicht`, `${p} does not exist`))
        return p
      },
      dir: (p) => {
        this.rootOf(p)
        if (this.node(p)?.type !== 'dir') throw new HttpError(400, tr(`${p} ist kein Ordner`, `${p} is not a folder`))
        return p
      },
      exists: (p) => this.exists(p),
    }
  }
}
