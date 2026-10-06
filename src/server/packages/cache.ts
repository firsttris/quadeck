// The package cache: where each package manager keeps downloaded packages (and yay/paru their
// builds), how much space that takes and how it is cleaned up with the manager's own tools.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { CacheEntry, ManagerId } from '~/shared/packages'
import type { Step } from './providers'
import { aurHelper, aurUser, passwdEntry } from './aur'

export interface CachePlan extends Omit<CacheEntry, 'size' | 'files' | 'truncated'> {
  /** Clean-up commands, run by the job as root (the AUR cache: as its owner). */
  steps: Step[]
}

/** CacheDir from pacman.conf (the first one), else the default. */
export function pacmanCacheDir(conf: string): string {
  const mm = /^\s*CacheDir\s*=\s*(\S+)/m.exec(conf)
  return mm ? mm[1]!.replace(/\/+$/, '') || '/' : '/var/cache/pacman/pkg'
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** What can be cleaned for this package manager (and the AUR helper's build cache). */
export function cachePlans(manager: ManagerId | null, aur: { helper?: 'yay' | 'paru'; user?: string; home?: string } = {}, has = (b: string) => !!Bun.which(b)): CachePlan[] {
  const plans: CachePlan[] = []
  switch (manager) {
    case 'pacman': {
      const dir = pacmanCacheDir(read('/etc/pacman.conf'))
      plans.push(
        has('paccache')
          ? // the last two versions of every installed package stay (to go back with pacman -U), uninstalled ones go
            { id: 'packages', path: dir, keep: 'two', steps: [{ argv: ['paccache', '-r', '-k2', '-c', dir] }, { argv: ['paccache', '-r', '-u', '-k0', '-c', dir] }] }
          : { id: 'packages', path: dir, keep: 'installed', steps: [{ argv: ['pacman', '-Sc', '--noconfirm'] }] },
      )
      break
    }
    case 'apt':
      plans.push({ id: 'packages', path: '/var/cache/apt/archives', keep: 'none', steps: [{ argv: ['apt-get', 'clean'] }] })
      break
    case 'dnf': {
      const dir = existsSync('/var/cache/libdnf5') ? '/var/cache/libdnf5' : '/var/cache/dnf'
      plans.push({ id: 'packages', path: dir, keep: 'none', steps: [{ argv: [has('dnf5') && !has('dnf') ? 'dnf5' : 'dnf', 'clean', 'packages'] }] })
      break
    }
    case 'zypper':
      plans.push({ id: 'packages', path: '/var/cache/zypp/packages', keep: 'none', steps: [{ argv: ['zypper', '--non-interactive', 'clean'] }] })
      break
    case 'apk': {
      // only when a local cache is set up (/etc/apk/cache is a link to it)
      let dir: string | undefined
      try {
        dir = realpathSync('/etc/apk/cache')
      } catch {
        dir = undefined
      }
      if (dir) plans.push({ id: 'packages', path: dir, keep: 'installed', steps: [{ argv: ['apk', 'cache', 'clean'] }] })
      break
    }
    // transactional-update, rpm-ostree: no package cache of this kind
  }
  if (manager === 'pacman' && aur.helper && aur.user && aur.home) {
    // yay keeps one folder per package (sources and build), paru the same under clone/; files next
    // to them (yay's vcs.json, paru's devel.toml) track -git packages and stay
    const path = aur.helper === 'yay' ? join(aur.home, '.cache/yay') : join(aur.home, '.cache/paru/clone')
    plans.push({ id: 'aur', path, owner: aur.user, keep: 'files', helper: aur.helper, steps: [{ argv: ['find', path, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-exec', 'rm', '-rf', '--one-file-system', '--', '{}', '+'] }] })
  }
  return plans
}

/** Space a folder takes on disk (allocated blocks), without following links or leaving the file system. */
export function dirUsage(dir: string, limit = 300_000): { size: number; files: number; truncated?: boolean } {
  let size = 0
  let files = 0
  let root: ReturnType<typeof lstatSync>
  try {
    root = lstatSync(dir)
  } catch {
    return { size: 0, files: 0 }
  }
  if (!root.isDirectory()) return { size: 0, files: 0 }
  const stack = [dir]
  let seen = 0
  while (stack.length) {
    const d = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      continue
    }
    for (const n of names) {
      if (++seen > limit) return { size, files, truncated: true }
      const p = join(d, n)
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.dev !== root.dev) continue
      if (st.isDirectory()) stack.push(p)
      else {
        files++
        size += st.blocks * 512
      }
    }
  }
  return { size, files }
}

/** The plans for this machine: its package manager and, on Arch, the AUR helper's cache. */
export function systemCachePlans(manager: ManagerId | null): CachePlan[] {
  const helper = manager === 'pacman' ? aurHelper() : undefined
  const user = helper ? aurUser() : undefined
  let home: string | undefined
  try {
    home = user ? passwdEntry(user).home : undefined
  } catch {
    home = undefined
  }
  return cachePlans(manager, { helper, user, home })
}
