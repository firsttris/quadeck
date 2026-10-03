// File explorer on the host. Everything is confined to "roots" (data
// areas): /mnt, /srv, /media, /home, /data and mounted data filesystems –
// never the system. Symlinks are resolved before the check, so a link
// cannot lead out. Copy/move/delete run as jobs (`quadeck job`).

import { chmodSync, chownSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { contentHash } from '~/shared/caddy'
import { HttpError } from '../auth'
import { msg } from '~/shared/i18n'
import type { FsOps } from './transfer'
import { baseName, isSensitivePath, joinPath, looksLikeText, MAX_ENTRIES, parentOf, TEXT_MAX, validateName, validatePath, type DirListing, type FileEntry, type FileRoot, type TextFile } from '~/shared/files'

export interface FilesAdmin {
  fileRoots(): Promise<FileRoot[]>
  listDir(path: string): Promise<DirListing>
}

export interface FilesBackend extends FilesAdmin {
  /** A file for the text editor. Keys and secrets (isSensitivePath) only with `allowSensitive` (unlocked). */
  readTextFile(path: string, allowSensitive: boolean): Promise<TextFile>
  makeDir(path: string): Promise<void>
  renamePath(path: string, newName: string): Promise<void>
  /** Saves an edited text file: same owner, mode and line endings; refused when it changed since `expected`. */
  writeTextFile(path: string, content: string, expected: string): Promise<TextFile>
}

/** Checks shared by the real machine and the demo, before a text file is shown. */
function assertReadable(path: string, real: string, allowSensitive: boolean) {
  if (!allowSensitive && (isSensitivePath(path) || isSensitivePath(real))) throw new HttpError(423, msg('files_error_sensitive'))
}

/** Raw bytes → what the editor gets. */
export function textFileFrom(path: string, raw: Uint8Array | undefined, info: { size: number; mtime: number; owner: string; mode: string }): TextFile {
  const base = { path, content: '', crlf: false, hash: '', ...info }
  if (info.size > TEXT_MAX || !raw) return { ...base, refused: 'tooLarge' }
  if (!looksLikeText(raw.subarray(0, 8192))) return { ...base, refused: 'binary' }
  const text = new TextDecoder().decode(raw)
  const crlf = text.includes('\r\n')
  return { ...base, content: crlf ? text.replace(/\r\n/g, '\n') : text, crlf, hash: contentHash(text) }
}

/** The text to write: line endings as the file had them. */
export function textToWrite(current: TextFile, content: string, expected: string): string {
  if (current.refused) throw new HttpError(409, current.refused === 'binary' ? msg('files_error_notText') : msg('files_error_tooLarge'))
  if (expected !== current.hash) throw new HttpError(409, msg('files_error_changedMeanwhile'))
  if (new TextEncoder().encode(content).length > TEXT_MAX) throw new HttpError(413, msg('files_error_tooLarge'))
  return current.crlf ? content.replace(/\r?\n/g, '\r\n') : content
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
    throw new HttpError(404, msg('files_error_notFound', { path }))
  }
  const root = roots.find((r) => real === r || real.startsWith(r + '/'))
  if (!root) throw new HttpError(403, msg('files_error_outsideRoots', { path }))
  if (real === root && !opts.allowRoot) throw new HttpError(403, msg('files_error_rootReadonly', { root }))
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
    if (!statSync(real).isDirectory()) throw new HttpError(400, msg('files_error_notFolder', { path }))
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
            target = msg('files_label_targetMissing')
          }
        }
        entries.push(entryFrom(name, st, users, groups, target))
      } catch {
        // vanished
      }
    }
    return { path: real, root, entries, truncated: names.length > MAX_ENTRIES }
  }

  private readFile(real: string): TextFile {
    const st = statSync(real)
    if (!st.isFile()) throw new HttpError(400, msg('files_error_notAFile', { path: real }))
    let raw: Uint8Array | undefined
    if (st.size <= TEXT_MAX) raw = readFileSync(real)
    else {
      // Only the start, to say what it is.
      const fd = openSync(real, 'r')
      try {
        raw = new Uint8Array(8192)
        readSync(fd, raw, 0, 8192, 0)
      } finally {
        closeSync(fd)
      }
    }
    const users = idNames('/etc/passwd')
    return textFileFrom(real, st.size > TEXT_MAX ? undefined : raw, { size: st.size, mtime: st.mtimeMs, owner: users.get(st.uid) ?? String(st.uid), mode: (st.mode & 0o7777).toString(8).padStart(3, '0') })
  }

  async readTextFile(path: string, allowSensitive: boolean) {
    const { real } = resolveInRoots(path, this.rootsFn())
    assertReadable(path, real, allowSensitive)
    return this.readFile(real)
  }

  async writeTextFile(path: string, content: string, expected: string) {
    const { real } = resolveInRoots(path, this.rootsFn())
    const data = textToWrite(this.readFile(real), content, expected)
    const st = statSync(real)
    // Next to the file, then renamed over it: never half written. Owner and mode stay.
    const tmp = joinPath(parentOf(real), `.${baseName(real)}.quadeck-tmp`)
    try {
      writeFileSync(tmp, data, { mode: 0o600 })
      chownSync(tmp, st.uid, st.gid)
      chmodSync(tmp, st.mode & 0o7777)
      renameSync(tmp, real)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
    return this.readFile(real)
  }

  async makeDir(path: string) {
    const bad = validateName(baseName(path))
    if (bad) throw new HttpError(400, bad)
    const { real } = resolveInRoots(path, this.rootsFn(), { parentOnly: true })
    if (existsSync(real)) throw new HttpError(409, msg('files_error_exists', { name: baseName(path) }))
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
    if (existsSync(dest)) throw new HttpError(409, msg('files_error_renameExists', { newName }))
    try {
      lstatSync(real)
    } catch {
      throw new HttpError(404, msg('files_error_notFound', { path }))
    }
    renameSync(real, dest)
  }
}

// ---------- fixtures ----------

interface Node {
  type: 'dir' | 'file'
  /** Demo text files. */
  content?: string
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
    const text = (content: string, days = 5): Node => ({ type: 'file', size: new TextEncoder().encode(content).length, mtime: now - 86_400_000 * days, owner: 'tristan', content })
    this.tree.set(
      '/srv',
      dir('root', {
        jellyfin: dir('root', { config: dir('root') }),
        scripts: dir('tristan', {
          'backup.sh': text('#!/bin/sh\n# Nightly backup of the photos to the second disk\nset -eu\nrsync -a --delete /mnt/disk2/Fotos/ /mnt/disk1/Backup/Fotos/\necho "backup done: $(date)"\n'),
          'jellyfin-hwaccel.patch': text('--- a/encoding.xml\n+++ b/encoding.xml\n@@ -3,1 +3,1 @@\n-  <HardwareAccelerationType>none</HardwareAccelerationType>\n+  <HardwareAccelerationType>qsv</HardwareAccelerationType>\n'),
          'NOTES.txt': text('Router: 192.168.1.1\nNAS disks: 2× 12 TB, 2× 14 TB (parity)\nTODO: replace sdb (reallocated sectors)\n', 20),
          firmware: { type: 'file', size: 4096, mtime: now - 86_400_000 * 40, owner: 'root', content: '\u0000\u0001binary' },
          '.env': text('RESTIC_PASSWORD=demo-secret\n', 30),
        }),
      }),
    )
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
    if (!root) throw new HttpError(403, msg('files_error_outsideRoots', { path }))
    return root
  }

  async fileRoots() {
    return [...this.tree.keys()].map((path) => ({ path, label: path, free: 3_200_000_000_000, size: 12_000_000_000_000 }))
  }

  async listDir(path: string): Promise<DirListing> {
    const root = this.rootOf(path)
    const n = this.node(path)
    if (!n) throw new HttpError(404, msg('files_error_notFound', { path }))
    if (n.type !== 'dir') throw new HttpError(400, msg('files_error_notFolder', { path }))
    const entries = [...n.children!].map(([name, c]) => ({ name, type: c.type, size: c.size, mtime: c.mtime, mode: c.type === 'dir' ? '775' : '664', owner: c.owner, group: c.owner === 'root' ? 'root' : 'users' }))
    return { path, root, entries, truncated: false }
  }

  private fixtureText(path: string): TextFile {
    this.rootOf(path)
    const n = this.node(path)
    if (!n) throw new HttpError(404, msg('files_error_notFound', { path }))
    if (n.type !== 'file') throw new HttpError(400, msg('files_error_notAFile', { path }))
    // Demo files without content (videos, archives) are binary.
    const raw = n.content !== undefined ? new TextEncoder().encode(n.content) : new Uint8Array([0, 1, 2])
    return textFileFrom(path, n.content !== undefined || n.size <= TEXT_MAX ? raw : undefined, { size: n.size, mtime: n.mtime, owner: n.owner, mode: '664' })
  }

  async readTextFile(path: string, allowSensitive: boolean) {
    this.rootOf(path)
    assertReadable(path, path, allowSensitive)
    return this.fixtureText(path)
  }

  async writeTextFile(path: string, content: string, expected: string) {
    const data = textToWrite(this.fixtureText(path), content, expected)
    const n = this.node(path)!
    n.content = data
    n.size = new TextEncoder().encode(data).length
    n.mtime = Date.now()
    return this.fixtureText(path)
  }

  async makeDir(path: string) {
    const bad = validateName(baseName(path))
    if (bad) throw new HttpError(400, bad)
    const root = this.rootOf(path)
    if (path === root) throw new HttpError(403, msg('files_error_rootItself'))
    const parent = this.node(parentOf(path))
    if (!parent?.children) throw new HttpError(404, msg('files_error_parentNotFound', { path: parentOf(path) }))
    if (parent.children.has(baseName(path))) throw new HttpError(409, msg('files_error_exists', { name: baseName(path) }))
    parent.children.set(baseName(path), { type: 'dir', size: 0, mtime: Date.now(), owner: parent.owner, children: new Map() })
  }

  async renamePath(path: string, newName: string) {
    const bad = validateName(newName)
    if (bad) throw new HttpError(400, bad)
    const root = this.rootOf(path)
    if (path === root) throw new HttpError(403, msg('files_error_rootReadonly', { root }))
    const parent = this.node(parentOf(path))!
    const n = parent?.children?.get(baseName(path))
    if (!n) throw new HttpError(404, msg('files_error_notFound', { path }))
    if (parent.children!.has(newName)) throw new HttpError(409, msg('files_error_renameExists', { newName }))
    parent.children!.delete(baseName(path))
    parent.children!.set(newName, n)
  }

  /** Applies a copy/move/delete job; returns the lines a real run would print. */
  apply(kind: 'copy' | 'move' | 'delete', paths: string[], toDir?: string): string[] {
    const lines: string[] = []
    for (const p of paths) {
      const parent = this.node(parentOf(p))
      const n = parent?.children?.get(baseName(p))
      if (!n || !parent?.children) throw new Error(msg('files_error_transferNotFound', { path: p }))
      if (kind === 'delete') {
        parent.children.delete(baseName(p))
        lines.push(`removed '${p}'`)
        continue
      }
      const dest = this.node(toDir!)
      if (!dest?.children) throw new Error(msg('files_error_targetNotFound', { toDir: toDir ?? '' }))
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
        if (p === root) throw new HttpError(403, msg('files_error_rootReadonly', { root }))
        if (!this.node(p)) throw new HttpError(404, msg('files_error_transferNotFound', { path: p }))
        return p
      },
      dir: (p) => {
        this.rootOf(p)
        if (this.node(p)?.type !== 'dir') throw new HttpError(400, msg('files_error_transferNotFolder', { path: p }))
        return p
      },
      exists: (p) => this.exists(p),
    }
  }
}
