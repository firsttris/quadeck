// Why a package job failed: known messages of pacman, yay/paru/makepkg and apt in the job's
// output, turned into a plain hint and the next step. Jobs run with LC_ALL=C.UTF-8, so the
// messages are the English ones. No I/O here.

import type { JobSpec } from './packages'

/** Commands the terminal may type for the user (never run on its own: Enter stays with the user). */
export const TERMINAL_COMMANDS = {
  'pacman-syu': { argv: 'pacman -Syu', root: true },
  'dpkg-configure': { argv: 'dpkg --configure -a', root: true },
} as const
export type TerminalCommand = keyof typeof TERMINAL_COMMANDS
export const isTerminalCommand = (v: unknown): v is TerminalCommand => typeof v === 'string' && Object.hasOwn(TERMINAL_COMMANDS, v)

export type DiagnosisKind = 'conflict' | 'fileExists' | 'signature' | 'aurSignature' | 'dbLock' | 'dpkgBusy' | 'dpkgInterrupted' | 'download' | 'diskFull' | 'aurBuild' | 'unknown'

export type DiagnosisAction =
  | { type: 'terminal'; command?: TerminalCommand }
  | { type: 'link'; href: string; label: 'archNews' | 'aurPage' }
  | { type: 'job'; spec: JobSpec; label: 'unlockRetry' | 'keyringRetry' }
  | { type: 'retry' }
  | { type: 'disks' }

export interface Diagnosis {
  kind: DiagnosisKind
  /** Indexes of the output lines the hint is about (highlighted). */
  lines: number[]
  /** pacman stopped before it changed anything. */
  unchanged?: boolean
  /** Names and paths for the text: the two packages, the file, the AUR package, the mount … */
  a?: string
  b?: string
  actions: DiagnosisAction[]
}

const PACKAGE_JOBS = new Set<JobSpec['kind']>(['upgrade', 'aur-upgrade', 'install', 'remove', 'kernel-install', 'kernel-remove', 'pacman-unlock', 'keyring-upgrade'])

/** "iptables-nft-1:1.8.11-2" → "iptables-nft" (name-version-release); a bare name stays. */
export function pkgName(token: string): string {
  const parts = token.split('-')
  return parts.length >= 3 && /^\d+(\.\d+)?$/.test(parts.at(-1)!) && /\d/.test(parts.at(-2)!) ? parts.slice(0, -2).join('-') : token
}

const ERR = /^(error|fehler|e:|==> error|failed)/i
/** The last few error lines (for an output nothing below matches). */
export function errorLines(lines: string[], max = 3): number[] {
  const out: number[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) if (ERR.test(lines[i]!.trim())) out.unshift(i)
  return out
}

/** The upgrade to run again after the lock is gone (other pacman jobs: just unlock). */
const retryKind = (spec: JobSpec): 'upgrade' | 'aur-upgrade' | undefined => (spec.kind === 'upgrade' || spec.kind === 'keyring-upgrade' ? 'upgrade' : spec.kind === 'aur-upgrade' ? spec.kind : spec.kind === 'pacman-unlock' ? spec.retry : undefined)

export function diagnoseJob(spec: JobSpec, lines: string[], provider?: string): Diagnosis | undefined {
  if (!PACKAGE_JOBS.has(spec.kind)) return undefined
  const find = (re: RegExp, from = 0) => {
    for (let i = from; i < lines.length; i++) {
      const mm = re.exec(lines[i]!)
      if (mm) return { i, mm }
    }
    return undefined
  }
  const pacman = provider === undefined || provider === 'pacman'
  const terminal = (command?: TerminalCommand): DiagnosisAction => ({ type: 'terminal', ...(command ? { command } : {}) })

  // a lock left behind by an interrupted run
  const lock = find(/could not lock database|unable to lock database/)
  if (lock && pacman) {
    const retry = retryKind(spec)
    return { kind: 'dbLock', lines: [lock.i], unchanged: true, a: '/var/lib/pacman/db.lck', actions: [{ type: 'job', spec: { kind: 'pacman-unlock', ...(retry ? { retry } : {}) }, label: 'unlockRetry' }] }
  }
  const dpkgLock = find(/^E: Could not get lock /)
  if (dpkgLock) {
    const holder = /It is held by process \d+ \(([^)]+)\)/.exec(lines[dpkgLock.i]!)?.[1]
    return { kind: 'dpkgBusy', lines: [dpkgLock.i], unchanged: true, ...(holder ? { a: holder } : {}), actions: [{ type: 'retry' }] }
  }
  const interrupted = find(/dpkg was interrupted, you must manually run 'dpkg --configure -a'/)
  if (interrupted) return { kind: 'dpkgInterrupted', lines: [interrupted.i], actions: [terminal('dpkg-configure')] }

  // two packages in conflict: without a question pacman says no
  const conflict = find(/^:: (\S+) and (\S+) are in conflict/)
  if (conflict) {
    const [a, b] = [pkgName(conflict.mm[1]!), pkgName(conflict.mm[2]!)]
    const marked = lines.flatMap((l, i) => (l.includes(' are in conflict') || /unresolvable package conflicts/.test(l) ? [i] : []))
    return { kind: 'conflict', lines: marked, unchanged: true, a, b, actions: [terminal('pacman-syu'), { type: 'link', href: 'https://archlinux.org/news/', label: 'archNews' }] }
  }

  // a file that is already there
  const exists = find(/^(\S+): (\/\S.*?) exists in filesystem(?: \(owned by (\S+)\))?$/)
  if (exists) {
    const all = lines.flatMap((l, i) => (/ exists in filesystem/.test(l) ? [i] : []))
    return { kind: 'fileExists', lines: all, unchanged: true, a: exists.mm[2], b: exists.mm[3], actions: [terminal()] }
  }

  // pacman's package signatures: an old keyring
  const sig = find(/signature from .* is (unknown|marginal) trust|invalid or corrupted package \(PGP signature\)|key ".*" could not be looked up remotely|key ".*" is unknown/)
  if (sig && pacman && spec.kind !== 'aur-upgrade') {
    return { kind: 'signature', lines: [sig.i], unchanged: true, actions: [{ type: 'job', spec: { kind: 'keyring-upgrade' }, label: 'keyringRetry' }] }
  }
  // makepkg: the source signature of an AUR package
  const srcSig = find(/One or more PGP signatures could not be verified/)
  if (srcSig) {
    const key = find(/FAILED \(unknown public key ([0-9A-F]+)\)/)
    return { kind: 'aurSignature', lines: [srcSig.i, ...(key ? [key.i] : [])], a: key?.mm[1], b: lastMaking(lines, srcSig.i), actions: [terminal()] }
  }

  // full disk: pacman checks before it starts, everything else fails on the way
  const full = find(/Partition (\S+) too full|not enough free disk space|No space left on device/)
  if (full) return { kind: 'diskFull', lines: [full.i], unchanged: /too full|not enough free disk space/.test(lines[full.i]!), a: full.mm[1], actions: [{ type: 'disks' }, terminal()] }

  // downloads: mirror down, file gone (database too old)
  const dl = find(/failed retrieving file|failed to retrieve some files|failed to synchronize all databases|Failed to fetch|Temporary failure resolving/)
  if (dl) return { kind: 'download', lines: lines.flatMap((l, i) => (/failed retrieving file|failed to retrieve some files|failed to synchronize|Failed to fetch|Temporary failure resolving/.test(l) ? [i] : [])).slice(0, 6), unchanged: pacman, actions: [{ type: 'retry' }] }

  // an AUR package that did not build
  const built = find(/error making: (\S+?)(?:\s+-\s+|-)exit status|failed to build '([^']+)'|==> ERROR: A failure occurred in (build|package|check|prepare)\(\)|==> ERROR: Could not resolve all dependencies/)
  if (built) {
    const failedList = find(/^(\S+) - exit status \d+$/)
    const name = built.mm[1] ?? (built.mm[2] ? pkgName(built.mm[2]) : undefined) ?? failedList?.mm[1] ?? lastMaking(lines, built.i)
    const marked = lines.flatMap((l, i) => (/error making:|failed to build '|==> ERROR:|Failed to install the following packages| - exit status \d+$/.test(l) ? [i] : []))
    return { kind: 'aurBuild', lines: marked, a: name, actions: [...(name ? [{ type: 'link' as const, href: `https://aur.archlinux.org/packages/${encodeURIComponent(name)}`, label: 'aurPage' as const }] : []), terminal()] }
  }

  return { kind: 'unknown', lines: errorLines(lines), actions: [terminal()] }
}

/** The package makepkg was building when `before` happened ("==> Making package: foo 1.2-1 (…)"). */
function lastMaking(lines: string[], before: number): string | undefined {
  for (let i = before; i >= 0; i--) {
    const mm = /^==> Making package: (\S+)/.exec(lines[i]!)
    if (mm) return mm[1]
  }
  return undefined
}
