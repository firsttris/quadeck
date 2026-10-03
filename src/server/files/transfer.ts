// Checks for copy/move/delete jobs – in the helper before the job starts
// (immediate error) and again in the job itself, where root acts.

import { existsSync, lstatSync, statSync } from 'node:fs'
import { HttpError } from '../auth'
import { msg } from '~/shared/i18n'
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
        throw new HttpError(404, msg('files_doesNotExist3', { p }))
      }
      return real
    },
    dir: (p) => {
      const { real } = resolveInRoots(p, roots, { allowRoot: true })
      if (!statSync(real).isDirectory()) throw new HttpError(400, msg('files_notFolder2', { p }))
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
    if (toDir === s || toDir.startsWith(s + '/')) throw new HttpError(400, spec.kind === 'fs-copy' ? msg('files_cannotCopiedIntoItself', { value: baseName(s) }) : msg('files_cannotMovedIntoItself', { value: baseName(s) }))
    if (spec.kind === 'fs-move' && parentOf(s) === toDir) throw new HttpError(400, msg('files_alreadyFolder', { value: baseName(s) }))
    if (ops.exists(joinPath(toDir, baseName(s)))) conflicts.push(baseName(s))
  }
  if (conflicts.length && !spec.overwrite) throw new HttpError(409, msg('files_alreadyExistsTarget') + `${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` +${conflicts.length - 5}` : ''}`)
  return { sources, toDir }
}

/** argv for the job (verbose, so the output shows progress per file). */
export function fsJobSteps(spec: FsJob, prepared: { sources: string[]; toDir?: string }): string[][] {
  switch (spec.kind) {
    case 'fs-copy':
      // -a keeps owner, rights and times; reflink makes copies on btrfs/xfs instant.
      return [['cp', '-a', '-v', '--reflink=auto', '--', ...prepared.sources, prepared.toDir!]]
    case 'fs-move':
      return [['mv', '-v', ...(spec.overwrite ? [] : ['-n']), '--', ...prepared.sources, prepared.toDir!]]
    case 'fs-delete':
      // Never across a mount point inside the tree.
      return [['rm', '-r', '-f', '-v', '--one-file-system', '--', ...prepared.sources]]
  }
}
