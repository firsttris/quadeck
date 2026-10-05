// Unpacking and packing archives in the data areas. The archive is listed and checked before
// anything is written (shared/archives.ts), again in the job itself, and the tools run as the
// owner of the target folder (setpriv), so a crafted archive can at most write where that
// owner may.

import { chownSync, lstatSync, mkdirSync, statfsSync, statSync } from 'node:fs'
import { HttpError } from '../auth'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { archiveFormat, checkEntries, extractBlocked, normEntry, packName, parseTarList, parseZipInfo, type ArchiveEntry, type ArchiveFormat, type ArchivePreview, type PackFormat } from '~/shared/archives'
import { baseName, joinPath, parentOf, validateName } from '~/shared/files'
import type { JobSpec } from '~/shared/packages'
import { resolveInRoots } from './backend'

export type ExtractJob = Extract<JobSpec, { kind: 'fs-extract' }>
export type PackJob = Extract<JobSpec, { kind: 'fs-pack' }>

/** File system access for the checks: the real machine, or the demo tree. */
export interface ArchiveHost {
  /** Real path of a file inside the roots. */
  file(path: string): string
  /** Real path of a folder inside the roots, or of a new one whose parent is a folder there. */
  dir(path: string): { real: string; exists: boolean }
  exists(path: string): boolean
  isLink(path: string): boolean
  free(path: string): number | undefined
  /** The archive's entries, or 'zip' when unzip is missing. */
  list(real: string, format: ArchiveFormat): Promise<ArchiveEntry[] | 'zip'>
}

const SAMPLE = 30
const MAX_PREFIXES = 5000

export async function previewExtract(archive: string, toDir: string, host: ArchiveHost): Promise<ArchivePreview> {
  const format = archiveFormat(archive)
  if (!format) throw new HttpError(400, msg(m.files_archive_notArchive, { name: baseName(archive) }))
  const real = host.file(archive)
  const target = host.dir(toDir)
  const base = { archive, format, toDir: target.real, create: !target.exists, free: host.free(target.exists ? target.real : parentOf(target.real)) }
  const listed = await host.list(real, format)
  if (listed === 'zip') return { ...base, files: 0, dirs: 0, size: 0, problems: [], conflicts: [], sample: [], missing: 'zip' }
  const check = checkEntries(listed)
  const conflicts = target.exists ? check.tops.filter((t) => host.exists(joinPath(target.real, t))) : []
  // Unpacking into an existing path that is a symlink would follow it out of the target.
  let linkInTarget: string | undefined
  if (target.exists) {
    const prefixes = new Set<string>()
    for (const e of listed) {
      // the folders on the way, and the entry itself unless it is a link (tar replaces a link with a link)
      const parts = normEntry(e.path).split('/')
      const upTo = e.type === 'link' ? parts.length - 1 : parts.length
      for (let i = 1; i <= upTo && prefixes.size < MAX_PREFIXES; i++) prefixes.add(parts.slice(0, i).join('/'))
    }
    for (const p of prefixes) {
      if (!p || p.split('/').includes('..')) continue
      const full = joinPath(target.real, p)
      if (host.isLink(full)) {
        linkInTarget = full
        break
      }
    }
  }
  return { ...base, files: check.files, dirs: check.dirs, size: check.size, problems: check.problems.slice(0, 20), conflicts: conflicts.slice(0, 50), ...(linkInTarget ? { linkInTarget } : {}), sample: listed.map((e) => normEntry(e.path)).filter(Boolean).slice(0, SAMPLE) }
}

/** Why the preview can't be unpacked (for the job and API errors). */
export function blockedReason(p: ArchivePreview): string {
  if (p.missing) return msg(m.files_archive_needsUnzip)
  if (p.problems.length) return msg(m.files_archive_unsafe, { paths: p.problems.slice(0, 3).map((x) => x.path).join(', ') })
  if (p.linkInTarget) return msg(m.files_archive_linkInTarget, { path: p.linkInTarget })
  if (p.free !== undefined && p.size > p.free) return msg(m.files_archive_noSpace)
  return msg(m.files_archive_conflicts, { names: p.conflicts.slice(0, 5).join(', ') })
}

export async function assertExtractable(spec: ExtractJob, host: ArchiveHost): Promise<ArchivePreview> {
  const p = await previewExtract(spec.archive, spec.toDir, host)
  if (extractBlocked(p, spec.overwrite)) throw new HttpError(409, blockedReason(p))
  return p
}

/** Checks a pack job; returns the folder, the file names in it and the new archive's path. */
export function preparePack(spec: PackJob, host: ArchiveHost): { dir: string; names: string[]; out: string } {
  const bad = validateName(spec.name)
  if (bad) throw new HttpError(400, bad)
  const dirs = new Set(spec.paths.map(parentOf))
  if (dirs.size !== 1) throw new HttpError(400, msg(m.files_archive_sameFolder))
  const dir = host.dir([...dirs][0]!)
  if (!dir.exists) throw new HttpError(404, msg(m.files_error_notFound, { path: [...dirs][0]! }))
  const names = spec.paths.map((p) => {
    if (!host.exists(p)) throw new HttpError(404, msg(m.files_error_transferNotFound, { path: p }))
    return baseName(p)
  })
  const out = joinPath(dir.real, packName(spec.name, spec.format))
  if (host.exists(out)) throw new HttpError(409, msg(m.files_error_exists, { name: baseName(out) }))
  return { dir: dir.real, names, out }
}

// ---------- the real machine ----------

const run = async (argv: string[]) => {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

let gnu: boolean | undefined
/** GNU tar (long options, --keep-old-files) or BusyBox tar (-o, -k). */
export function gnuTar(): boolean {
  gnu ??= /GNU tar/.test(Bun.spawnSync(['tar', '--version'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString())
  return gnu
}

async function listSystem(real: string, format: ArchiveFormat): Promise<ArchiveEntry[] | 'zip'> {
  if (format === 'zip') {
    if (!Bun.which('unzip')) return 'zip'
    const r = await run(['unzip', '-Z', '-T', real])
    if (r.code !== 0) throw new HttpError(422, msg(m.files_archive_unreadable, { error: (r.stderr || r.stdout).trim().split('\n')[0] ?? '' }))
    const entries = parseZipInfo(r.stdout)
    // zip keeps a symlink's target as its content
    for (const e of entries.filter((x) => x.type === 'link').slice(0, 1000)) {
      const t = await run(['unzip', '-p', real, e.path])
      if (t.code === 0) e.target = t.stdout
    }
    return entries
  }
  const r = await run(['tar', '-t', '-v', '-f', real])
  if (r.code !== 0) throw new HttpError(422, msg(m.files_archive_unreadable, { error: (r.stderr || r.stdout).trim().split('\n').pop() ?? '' }))
  return parseTarList(r.stdout)
}

export function systemArchiveHost(roots: string[]): ArchiveHost {
  return {
    file: (path) => {
      const { real } = resolveInRoots(path, roots)
      if (!statSync(real).isFile()) throw new HttpError(400, msg(m.files_error_notAFile, { path }))
      return real
    },
    dir: (path) => {
      try {
        const { real } = resolveInRoots(path, roots, { allowRoot: true })
        if (!statSync(real).isDirectory()) throw new HttpError(400, msg(m.files_error_transferNotFolder, { path }))
        return { real, exists: true }
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 404) throw e
      }
      // a new folder: its parent must exist in the roots
      const bad = validateName(baseName(path))
      if (bad) throw new HttpError(400, bad)
      const { real } = resolveInRoots(path, roots, { parentOnly: true })
      return { real, exists: false }
    },
    exists: (path) => {
      try {
        lstatSync(path)
        return true
      } catch {
        return false
      }
    },
    isLink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink()
      } catch {
        return false
      }
    },
    free: (path) => {
      try {
        const s = statfsSync(path)
        return s.bavail * s.bsize
      } catch {
        return undefined
      }
    },
    list: listSystem,
  }
}

/** Runs a tool as the owner of `dir` (not root, when someone else owns it). */
export function asOwnerOf(dir: string, argv: string[]): string[] {
  const st = statSync(dir)
  if (st.uid === 0 || process.getuid?.() !== 0 || !Bun.which('setpriv')) return argv
  return ['setpriv', `--reuid=${st.uid}`, `--regid=${st.gid}`, '--clear-groups', '--', ...argv]
}

/** A missing target folder is created like "New folder": owned by its parent's owner. */
export function makeTarget(p: ArchivePreview) {
  if (!p.create) return
  mkdirSync(p.toDir, { mode: 0o775 })
  const parent = statSync(parentOf(p.toDir))
  chownSync(p.toDir, parent.uid, parent.gid)
}

/**
 * The unpack command. tar reads the archive from stdin (root opens it, so it works when the target's
 * owner can't read the archive itself); unzip needs to seek and opens the file.
 */
export function extractArgv(format: ArchiveFormat, archive: string, toDir: string, overwrite: boolean, gnuTar: boolean): { argv: string[]; stdin?: string } {
  if (format === 'zip') return { argv: ['unzip', overwrite ? '-o' : '-n', archive, '-d', toDir] }
  const compression = { tar: [], 'tar.gz': ['-z'], 'tar.bz2': ['-j'], 'tar.xz': ['-J'], 'tar.zst': gnuTar ? ['--zstd'] : ['-I', 'zstd'] }[format]
  // owners and permission bits from the archive are not taken over
  const keep = gnuTar ? ['--no-same-owner', '--no-same-permissions', ...(overwrite ? [] : ['--keep-old-files'])] : ['-o', ...(overwrite ? [] : ['-k'])]
  return { argv: ['tar', '-x', '-v', ...compression, '-f', '-', '-C', toDir, ...keep], stdin: archive }
}

export function packArgv(format: PackFormat, dir: string, out: string, names: string[]): { argv: string[]; cwd?: string } {
  // zip has no "-C": it runs in the folder ("./" keeps names starting with "-" from looking like options)
  if (format === 'zip') return { argv: ['zip', '-r', '-y', out, ...names.map((n) => `./${n}`)], cwd: dir }
  return { argv: ['tar', '-c', '-v', '-z', '-f', out, '-C', dir, '--', ...names] }
}
