// The folder browser of the backup setup: folder names of the whole file system (root reads them,
// the web app only gets names), the disk a folder is on, and which other paths share that disk.

import { readdirSync, statfsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { absPathProblem, type FolderListing } from '~/shared/backup'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { HttpError } from '../auth'

/** What the browser needs from a file system (the real one, or the demo tree). */
export interface DirFs {
  /** Device id of an existing folder, undefined when there is none. */
  dev(path: string): number | undefined
  /** Names of the sub-folders (symlinks to folders count). */
  dirs(path: string): string[]
  disk(path: string): { size: number; free: number } | undefined
}

/** Kernel views and devices: never a backup source or target, only noise in the list. */
const HIDDEN_AT_ROOT = new Set(['proc', 'sys', 'dev', 'run', 'lost+found'])
const MAX_DIRS = 2000
const MAX_COMPARE = 200

const parent = (p: string) => (p === '/' ? '/' : dirname(p))

/** The closest existing folder at or above `path`. */
function existing(fs: DirFs, path: string): { path: string; dev: number } {
  let p = path
  for (;;) {
    const dev = fs.dev(p)
    if (dev !== undefined) return { path: p, dev }
    if (p === '/') throw new HttpError(404, msg(m.backup_error_path, { path }))
    p = parent(p)
  }
}

export function listDirs(fs: DirFs, path: string, compare: string[] = []): FolderListing {
  if (path !== '/' && absPathProblem(path)) throw new HttpError(400, msg(m.backup_error_path, { path }))
  const here = existing(fs, path)
  const names = fs.dirs(here.path).filter((n) => !(here.path === '/' && HIDDEN_AT_ROOT.has(n)))
  const hidden = (n: string) => n.startsWith('.')
  const dirs = names.sort((a, b) => Number(hidden(a)) - Number(hidden(b)) || a.localeCompare(b, 'en', { numeric: true })).slice(0, MAX_DIRS)
  // The mount point: the highest folder above that is still on the same device.
  let mount = here.path
  while (mount !== '/' && fs.dev(parent(mount)) === here.dev) mount = parent(mount)
  const size = fs.disk(here.path)
  const sameDisk = compare.slice(0, MAX_COMPARE).filter((c) => {
    if (c === path || (c !== '/' && absPathProblem(c))) return false
    try {
      return existing(fs, c).dev === here.dev
    } catch {
      return false
    }
  })
  return { path: here.path, dirs, ...(here.path !== path ? { missing: true } : {}), ...(size ? { disk: { mount, ...size } } : {}), sameDisk }
}

/** The real file system (in the root helper). */
export const systemDirFs: DirFs = {
  dev(path) {
    try {
      const s = statSync(path)
      return s.isDirectory() ? s.dev : undefined
    } catch {
      return undefined
    }
  },
  dirs(path) {
    try {
      return readdirSync(path, { withFileTypes: true }).flatMap((e) => {
        if (e.isDirectory()) return [e.name]
        if (!e.isSymbolicLink()) return []
        try {
          return statSync(join(path, e.name)).isDirectory() ? [e.name] : []
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  },
  disk(path) {
    try {
      const s = statfsSync(path)
      return { size: s.blocks * s.bsize, free: s.bavail * s.bsize }
    } catch {
      return undefined
    }
  },
}

/** A folder tree from a list of paths, with a device per mount point (demo and tests). */
export function treeDirFs(paths: string[], mounts: Record<string, { size: number; free: number }>): DirFs {
  const all = new Set<string>(['/'])
  for (const p of paths) for (let x = p; x !== '/'; x = parent(x)) all.add(x)
  for (const mp of Object.keys(mounts)) for (let x = mp; x !== '/'; x = parent(x)) all.add(x)
  const ids = Object.keys(mounts)
  const mountOf = (p: string) => ids.filter((mp) => mp === '/' || p === mp || p.startsWith(mp + '/')).sort((a, b) => b.length - a.length)[0] ?? '/'
  return {
    dev: (p) => (all.has(p) ? ids.indexOf(mountOf(p)) + 1 : undefined),
    dirs: (p) => [...all].filter((x) => x !== '/' && parent(x) === p).map((x) => x.slice(p === '/' ? 1 : p.length + 1)),
    disk: (p) => (all.has(p) ? mounts[mountOf(p)] : undefined),
  }
}

/** listDirs with `volume:<name>` paths compared by their folder on the host. */
export async function dirsWithVolumes(fs: DirFs, path: string, compare: string[], resolve: (p: string) => Promise<string | undefined>): Promise<FolderListing> {
  const resolved = await Promise.all(compare.slice(0, MAX_COMPARE).map(async (c) => [c, await resolve(c).catch(() => undefined)] as const))
  const listing = listDirs(fs, path, resolved.flatMap(([, r]) => (r ? [r] : [])))
  const same = new Set(listing.sameDisk)
  return { ...listing, sameDisk: resolved.filter(([, r]) => r !== undefined && same.has(r)).map(([c]) => c) }
}
