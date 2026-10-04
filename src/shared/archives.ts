// Archives in the file explorer: which files are archives, reading `tar -tv` / `unzip -Z -T`
// listings, and the checks before anything is unpacked (no "../" or absolute paths, no links
// that point outside the target, no device files, no setuid bits). No I/O here.

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'tar.zst'
export const PACK_FORMATS = ['zip', 'tar.gz'] as const
export type PackFormat = (typeof PACK_FORMATS)[number]

const EXTENSIONS: [RegExp, ArchiveFormat][] = [
  [/\.zip$/i, 'zip'],
  [/\.(tar\.gz|tgz)$/i, 'tar.gz'],
  [/\.(tar\.bz2|tbz2?)$/i, 'tar.bz2'],
  [/\.(tar\.xz|txz)$/i, 'tar.xz'],
  [/\.(tar\.zst|tzst)$/i, 'tar.zst'],
  [/\.tar$/i, 'tar'],
]

export const archiveFormat = (name: string): ArchiveFormat | null => EXTENSIONS.find(([re]) => re.test(name))?.[1] ?? null

/** "fotos-2019.tar.gz" → "fotos-2019" (the folder it unpacks into by default). */
export function archiveStem(name: string): string {
  const hit = EXTENSIONS.find(([re]) => re.test(name))
  const stem = hit ? name.replace(hit[0], '') : name
  return stem || name
}

/** The file name for a new archive: the extension is added when missing. */
export const packName = (name: string, format: PackFormat) => (archiveFormat(name) === format ? name : `${name.replace(/\.$/, '')}.${format}`)

export interface ArchiveEntry {
  path: string
  type: 'file' | 'dir' | 'link' | 'hardlink' | 'other'
  size: number
  /** Symlink or hard link target. */
  target?: string
  /** setuid, setgid or sticky bit. */
  special?: boolean
}

/** GNU tar's escape quoting (\\, \n, \t, octal \ooo) back to the name. */
function unescape(s: string): string {
  return s.replace(/\\(\\|[0-7]{3}|[abfnrtv])/g, (_, c: string) => {
    if (c === '\\') return '\\'
    if (/^[0-7]{3}$/.test(c)) return String.fromCharCode(parseInt(c, 8))
    return ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' } as Record<string, string>)[c]!
  })
}

const typeOf = (c: string): ArchiveEntry['type'] => (c === '-' ? 'file' : c === 'd' ? 'dir' : c === 'l' ? 'link' : c === 'h' ? 'hardlink' : 'other')

/** `tar -tvf` from GNU tar or BusyBox: "drwxr-xr-x user/group 0 2024-01-01 12:00[:00] name[ -> target| link to target]". */
const TAR_LINE = /^([-dlhcbps])(\S{9})\S*\s+\S+\s+(\d+|\d+,\s*\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s(.*)$/
export function parseTarList(out: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  for (const line of out.split('\n')) {
    const mm = TAR_LINE.exec(line)
    if (!mm) continue
    const type = typeOf(mm[1]!)
    let name = mm[4]!
    let target: string | undefined
    const sep = type === 'link' ? ' -> ' : type === 'hardlink' ? ' link to ' : undefined
    if (sep && name.includes(sep)) [name, target] = [name.slice(0, name.indexOf(sep)), unescape(name.slice(name.indexOf(sep) + sep.length))]
    entries.push({ path: unescape(name), type, size: type === 'file' ? Number(mm[3]) : 0, ...(target !== undefined ? { target } : {}), ...(/[sStT]/.test(mm[2]!) ? { special: true } : {}) })
  }
  return entries
}

/** `unzip -Z -T`: "-rw-r--r--  3.0 unx  1234 tx defN 20240101.120000 name". Link targets come separately. */
const ZIP_LINE = /^([-dl?])(\S*)\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\d{8}\.\d{6}\s(.*)$/
export function parseZipInfo(out: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  for (const line of out.split('\n')) {
    const mm = ZIP_LINE.exec(line)
    if (!mm) continue
    const name = mm[4]!
    const type: ArchiveEntry['type'] = mm[1] === 'l' ? 'link' : mm[1] === 'd' || name.endsWith('/') ? 'dir' : mm[1] === '-' ? 'file' : 'other'
    entries.push({ path: name, type, size: type === 'file' ? Number(mm[3]) : 0, ...(/[sStT]/.test(mm[2]!.slice(0, 9)) ? { special: true } : {}) })
  }
  return entries
}

/** "./a/b/" → "a/b" (how tar and zip write the same path). */
export const normEntry = (p: string) => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '')

export type ProblemReason = 'absolute' | 'parent' | 'linkOutside' | 'special' | 'device'
export interface ArchiveProblem {
  path: string
  reason: ProblemReason
  target?: string
}

export interface ArchiveCheck {
  files: number
  dirs: number
  /** Unpacked size in bytes. */
  size: number
  problems: ArchiveProblem[]
  /** Top-level names (what appears in the target folder). */
  tops: string[]
}

/** Resolves `target` relative to the folder of `entry`; undefined when it leaves the archive root. */
function inside(entry: string, target: string): string | undefined {
  const parts = entry.split('/').slice(0, -1)
  for (const p of target.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(p)
  }
  return parts.join('/')
}

export function checkEntries(entries: ArchiveEntry[]): ArchiveCheck {
  const problems: ArchiveProblem[] = []
  const tops = new Set<string>()
  let files = 0
  let dirs = 0
  let size = 0
  for (const e of entries) {
    const raw = e.path
    const path = normEntry(raw)
    if (raw.startsWith('/')) problems.push({ path: raw, reason: 'absolute' })
    else if (path.split('/').includes('..')) problems.push({ path: raw, reason: 'parent' })
    else if (e.type === 'other') problems.push({ path: raw, reason: 'device' })
    else if (e.special) problems.push({ path: raw, reason: 'special' })
    else if (e.type === 'link' && (e.target === undefined || e.target.startsWith('/') || inside(path, e.target) === undefined)) problems.push({ path: raw, reason: 'linkOutside', target: e.target })
    else if (e.type === 'hardlink' && (e.target === undefined || e.target.startsWith('/') || normEntry(e.target).split('/').includes('..'))) problems.push({ path: raw, reason: 'linkOutside', target: e.target })
    if (!path) continue
    tops.add(path.split('/')[0]!)
    if (e.type === 'dir') dirs++
    else files++
    size += e.size
  }
  return { files, dirs, size, problems, tops: [...tops].sort() }
}

/** What the extract dialog shows. */
export interface ArchivePreview {
  archive: string
  format: ArchiveFormat
  toDir: string
  /** The target folder does not exist yet: it is created. */
  create: boolean
  files: number
  dirs: number
  size: number
  free?: number
  problems: ArchiveProblem[]
  /** Top-level names that exist in the target already. */
  conflicts: string[]
  /** A path in the target that is a symlink (refused: unpacking would follow it). */
  linkInTarget?: string
  /** The first paths in the archive. */
  sample: string[]
  /** A tool that is missing (offer to install it). */
  missing?: 'zip'
}

/** Can it be unpacked as shown (overwrite: replace existing entries)? */
export const extractBlocked = (p: ArchivePreview, overwrite: boolean) => !!p.missing || p.problems.length > 0 || !!p.linkInTarget || (p.free !== undefined && p.size > p.free) || (p.conflicts.length > 0 && !overwrite)
