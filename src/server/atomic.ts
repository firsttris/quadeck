// Writing system and user files so that a crash or power loss leaves either the old or the new
// content, and so that nothing in the target folder can redirect the write.

import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, mkdirSync, openSync, readlinkSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname } from 'node:path'

export interface AtomicOptions {
  /** File mode, set on the descriptor (independent of the umask). Default 0644. */
  mode?: number
  /** Owner of the new file (keeps a user's file theirs). */
  owner?: { uid: number; gid: number }
  /** Create the folder first with this mode. */
  mkdir?: number
}

/**
 * Temp file next to the target, fsync, rename over it, fsync the folder. Without the fsyncs XFS
 * and btrfs may show an empty file after a power loss right after the rename.
 *
 * The folder is opened once and checked against its real path; the temp file is created with
 * O_EXCL (a planted symlink is removed, never followed), and mode and owner go through its
 * descriptor. Every step runs inside that open folder (/proc/self/fd/N), so swapping the folder
 * or a file in it for a link after the check changes nothing. This matters where root writes
 * into a folder a user owns (file explorer).
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: AtomicOptions = {}) {
  const dir = dirname(path)
  if (opts.mkdir !== undefined) mkdirSync(dir, { recursive: true, mode: opts.mkdir })
  const real = realpathSync(dir)
  const dfd = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (readlinkSync(`/proc/self/fd/${dfd}`) !== real) throw new Error(`${dir} changed while writing`)
    const at = (name: string) => `/proc/self/fd/${dfd}/${name}`
    const name = basename(path)
    const tmp = `${name}.quadeck-tmp`
    rmSync(at(tmp), { force: true })
    const fd = openSync(at(tmp), 'wx', 0o600)
    try {
      writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data)
      if (opts.owner) fchownSync(fd, opts.owner.uid, opts.owner.gid)
      fchmodSync(fd, opts.mode ?? 0o644)
      fsyncSync(fd)
    } catch (e) {
      closeSync(fd)
      rmSync(at(tmp), { force: true })
      throw e
    }
    closeSync(fd)
    try {
      renameSync(at(tmp), at(name))
    } catch (e) {
      rmSync(at(tmp), { force: true })
      throw e
    }
    try {
      fsyncSync(dfd)
    } catch {
      // some file systems (vfat on older kernels) refuse fsync on a folder: the rename is done
    }
  } finally {
    closeSync(dfd)
  }
}
