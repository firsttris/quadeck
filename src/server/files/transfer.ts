// Checks for copy/move/delete jobs – in the helper before the job starts
// (immediate error) and again in the job itself, where root acts.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { HttpError } from '../auth'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { baseName, joinPath, parentOf } from '~/shared/files'
import type { JobSpec } from '~/shared/packages'
import { resolveInRoots } from './backend'

export type FsJob = Extract<JobSpec, { kind: 'fs-copy' | 'fs-move' | 'fs-delete' }>

export interface FsOps {
  /** Real path of an entry inside the roots (throws otherwise). */
  entry(path: string): string
  /** Real path of a directory inside the roots (the root itself allowed). */
  dir(path: string): string
  exists(path: string): boolean
}

export function systemFsOps(roots: string[]): FsOps {
  return {
    entry: (p) => {
      const { real } = resolveInRoots(p, roots, { parentOnly: true })
      try {
        lstatSync(real)
      } catch {
        throw new HttpError(404, msg(m.files_error_transferNotFound, { path: p }))
      }
      return real
    },
    dir: (p) => {
      const { real } = resolveInRoots(p, roots, { allowRoot: true })
      if (!statSync(real).isDirectory()) throw new HttpError(400, msg(m.files_error_transferNotFolder, { path: p }))
      return real
    },
    exists: (p) => {
      try {
        lstatSync(p)
        return true
      } catch {
        return existsSync(p)
      }
    },
  }
}

/** Resolved sources and target; throws HttpError with a readable reason. */
export function prepareFsJob(spec: FsJob, ops: FsOps): { sources: string[]; toDir?: string } {
  const sources = [...new Set(spec.paths.map((p) => ops.entry(p)))]
  if (spec.kind === 'fs-delete') return { sources }
  const toDir = ops.dir(spec.toDir)
  const conflicts: string[] = []
  for (const s of sources) {
    if (toDir === s || toDir.startsWith(s + '/')) throw new HttpError(400, spec.kind === 'fs-copy' ? msg(m.files_error_copyIntoItself, { name: baseName(s) }) : msg(m.files_error_moveIntoItself, { name: baseName(s) }))
    if (spec.kind === 'fs-move' && parentOf(s) === toDir) throw new HttpError(400, msg(m.files_error_alreadyInFolder, { name: baseName(s) }))
    if (ops.exists(joinPath(toDir, baseName(s)))) conflicts.push(baseName(s))
  }
  if (conflicts.length && !spec.overwrite) throw new HttpError(409, msg(m.files_error_existsInTarget) + `${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` +${conflicts.length - 5}` : ''}`)
  return { sources, toDir }
}

/**
 * GNU coreutils (or a compatible cp/rm such as uutils) rather than BusyBox/Toybox, which know
 * neither --reflink nor --one-file-system (Alpine, OpenWrt-like systems).
 */
export function gnuCoreutils(which: (bin: string) => string | null = Bun.which): boolean {
  const cp = which('cp')
  if (!cp) return true
  try {
    return !/^(busybox|toybox)/.test(baseName(realpathSync(cp)))
  } catch {
    return true
  }
}

/** Mount points strictly inside one of the sources (from /proc/self/mounts; octal escapes like \040 decoded). */
export function mountsInside(sources: string[], mounts: string): string[] {
  const points = mounts
    .split('\n')
    .map((l) => l.split(' ')[1])
    .filter((m): m is string => !!m)
    .map((m) => m.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))))
  return [...new Set(points.filter((m) => sources.some((s) => m.startsWith(s.endsWith('/') ? s : s + '/'))))]
}

/** argv for the job (verbose, so the output shows progress per file). */
export function fsJobSteps(spec: FsJob, prepared: { sources: string[]; toDir?: string }, gnu = true): string[][] {
  switch (spec.kind) {
    case 'fs-copy':
      // -a keeps owner, rights and times; reflink makes copies on btrfs/xfs instant.
      return [['cp', '-a', '-v', ...(gnu ? ['--reflink=auto'] : []), '--', ...prepared.sources, prepared.toDir!]]
    case 'fs-move':
      return [['mv', '-v', ...(spec.overwrite ? [] : ['-n']), '--', ...prepared.sources, prepared.toDir!]]
    case 'fs-delete':
      // Never across a mount point inside the tree (BusyBox rm can't promise that: checked before, see assertNoMountsInside).
      return [['rm', '-r', '-f', '-v', ...(gnu ? ['--one-file-system'] : []), '--', ...prepared.sources]]
  }
}

/** Without --one-file-system, refuse to delete a tree with something mounted inside. */
export function assertNoMountsInside(sources: string[], mounts: string = readMounts()) {
  const inside = mountsInside(sources, mounts)
  if (inside.length) throw new HttpError(409, msg(m.files_error_mountInside, { path: inside[0]! }))
}

function readMounts(): string {
  try {
    return readFileSync('/proc/self/mounts', 'utf8')
  } catch {
    return ''
  }
}
