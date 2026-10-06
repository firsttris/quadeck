import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diagnoseJob, errorLines, isTerminalCommand, pkgName } from '~/shared/job-diagnosis'
import { parseJobSpec, runningPackageManagers } from '~/server/packages/job'

const up = { kind: 'upgrade' } as const
const aur = { kind: 'aur-upgrade' } as const
const out = (s: string) => s.split('\n')

describe('job diagnosis', () => {
  it('package names without version and release', () => {
    expect(pkgName('iptables-nft-1:1.8.11-2')).toBe('iptables-nft')
    expect(pkgName('lib32-libpaper-2.2.6-1')).toBe('lib32-libpaper')
    expect(pkgName('jack2-1.9.22-1.1')).toBe('jack2')
    expect(pkgName('pipewire-jack')).toBe('pipewire-jack')
  })

  it('a package conflict: both names, nothing changed, terminal with pacman -Syu', () => {
    const lines = out(`$ pacman -Syu --noconfirm --noprogressbar --color never
:: Synchronizing package databases...
:: Starting full system upgrade...
:: Replace iptables with extra/iptables-nft? [Y/n]
:: iptables-nft-1:1.8.11-2 and iptables-1:1.8.11-2 are in conflict. Remove iptables? [y/N]
error: unresolvable package conflicts detected
error: failed to prepare transaction (conflicting dependencies)
:: iptables-nft-1:1.8.11-2 and iptables-1:1.8.11-2 are in conflict`)
    const d = diagnoseJob(up, lines)!
    expect(d).toMatchObject({ kind: 'conflict', a: 'iptables-nft', b: 'iptables', unchanged: true })
    expect(d.lines).toEqual([4, 5, 7])
    expect(d.actions[0]).toEqual({ type: 'terminal', command: 'pacman-syu' })
  })

  it('a file that exists: with and without an owning package', () => {
    const lines = out(`error: failed to commit transaction (conflicting files)
python-foo: /usr/lib/python3.12/site-packages/foo/__init__.py exists in filesystem
python-foo: /usr/lib/python3.12/site-packages/foo/bar.py exists in filesystem
Errors occurred, no packages were upgraded.`)
    const d = diagnoseJob(up, lines)!
    expect(d).toMatchObject({ kind: 'fileExists', a: '/usr/lib/python3.12/site-packages/foo/__init__.py', unchanged: true })
    expect(d.b).toBeUndefined()
    expect(d.lines).toEqual([1, 2])
    expect(diagnoseJob(up, ['libfoo: /usr/lib/libfoo.so.1 exists in filesystem (owned by libfoo-old)'])).toMatchObject({ kind: 'fileExists', a: '/usr/lib/libfoo.so.1', b: 'libfoo-old' })
  })

  it('an old keyring: keyring first, then the system', () => {
    const lines = out(`(12/12) checking keys in keyring
downloading required keys...
error: key "9E4F11C6A072942A" could not be looked up remotely
error: required key missing from keyring
error: failed to commit transaction (unexpected error)`)
    expect(diagnoseJob(up, lines)).toMatchObject({ kind: 'signature', unchanged: true, actions: [{ type: 'job', spec: { kind: 'keyring-upgrade' } }] })
    expect(diagnoseJob(up, ['error: glibc: signature from "Frederik Schwan <freswa@archlinux.org>" is unknown trust'])?.kind).toBe('signature')
  })

  it('the lock of an interrupted run: unlock, then the same update again', () => {
    const lines = out(`error: failed to init transaction (unable to lock database)
error: could not lock database: File exists
  if you're sure a package manager is not already running, you can remove /var/lib/pacman/db.lck`)
    expect(diagnoseJob(up, lines)).toMatchObject({ kind: 'dbLock', unchanged: true, a: '/var/lib/pacman/db.lck', actions: [{ type: 'job', spec: { kind: 'pacman-unlock', retry: 'upgrade' } }] })
    expect(diagnoseJob(aur, lines)?.actions[0]).toMatchObject({ spec: { kind: 'pacman-unlock', retry: 'aur-upgrade' } })
    // installing a feature: unlock only
    expect(diagnoseJob({ kind: 'install', feature: 'zip' }, lines)?.actions[0]).toEqual({ type: 'job', spec: { kind: 'pacman-unlock' }, label: 'unlockRetry' })
  })

  it('apt: lock held by another process, interrupted dpkg', () => {
    expect(diagnoseJob(up, ['E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234 (unattended-upgr)'], 'apt')).toMatchObject({ kind: 'dpkgBusy', a: 'unattended-upgr', actions: [{ type: 'retry' }] })
    expect(diagnoseJob(up, ['E: Could not get lock /var/lib/dpkg/lock-frontend - open (11: Resource temporarily unavailable)'], 'apt')?.kind).toBe('dpkgBusy')
    expect(diagnoseJob(up, ["E: dpkg was interrupted, you must manually run 'dpkg --configure -a' to correct the problem."], 'apt')).toMatchObject({ kind: 'dpkgInterrupted', actions: [{ type: 'terminal', command: 'dpkg-configure' }] })
  })

  it('downloads and a full disk', () => {
    const dl = out(`error: failed retrieving file 'linux-6.10.3.arch1-2-x86_64.pkg.tar.zst' from mirror.example.org : The requested URL returned error: 404
warning: failed to retrieve some files
error: failed to commit transaction (failed to retrieve some files)`)
    expect(diagnoseJob(up, dl)).toMatchObject({ kind: 'download', unchanged: true, lines: [0, 1, 2], actions: [{ type: 'retry' }] })
    expect(diagnoseJob(up, ['error: Partition / too full: 63248 blocks needed, 41020 blocks free', 'error: failed to commit transaction (not enough free disk space)'])).toMatchObject({ kind: 'diskFull', a: '/', unchanged: true, actions: [{ type: 'cache' }, { type: 'disks' }, { type: 'terminal' }] })
    // mid-way (makepkg, dpkg): not "nothing changed"
    const mid = diagnoseJob(aur, ['tar: ./usr/lib/libfoo.so: Cannot write: No space left on device'])!
    expect(mid.kind).toBe('diskFull')
    expect(mid.unchanged).toBe(false)
  })

  it('an AUR package that did not build (yay, paru)', () => {
    const yay = out(`==> Making package: lib32-libpaper 2.2.6-1 (Mon 06 Oct 2025 08:02:28 CEST)
==> Starting build()...
make: *** [Makefile:123: all] Error 2
==> ERROR: A failure occurred in build().
    Aborting...
 -> error making: lib32-libpaper-exit status 4
 -> Failed to install the following packages. Manual intervention is required:
lib32-libpaper - exit status 4`)
    const d = diagnoseJob(aur, yay)!
    expect(d).toMatchObject({ kind: 'aurBuild', a: 'lib32-libpaper' })
    expect(d.unchanged).toBeUndefined()
    expect(d.lines).toEqual([3, 5, 6, 7])
    expect(d.actions[0]).toEqual({ type: 'link', href: 'https://aur.archlinux.org/packages/lib32-libpaper', label: 'aurPage' })
    expect(diagnoseJob(aur, ["error: failed to build 'visual-studio-code-bin-1.92.1-1': failed to run: makepkg"])).toMatchObject({ kind: 'aurBuild', a: 'visual-studio-code-bin' })
    // only makepkg's error: the package from "Making package"
    expect(diagnoseJob(aur, ['==> Making package: foo-git r12.abc-1 (…)', '==> ERROR: A failure occurred in build().'])).toMatchObject({ kind: 'aurBuild', a: 'foo-git' })
  })

  it('a source signature of an AUR package: the missing key', () => {
    const lines = out(`==> Making package: spotify 1:1.2.42-1 (…)
==> Verifying source file signatures with gpg...
    spotify-1.2.42.deb ... FAILED (unknown public key 5384CE82BA52C83A)
==> ERROR: One or more PGP signatures could not be verified!`)
    expect(diagnoseJob(aur, lines)).toMatchObject({ kind: 'aurSignature', a: '5384CE82BA52C83A', b: 'spotify', lines: [3, 2] })
    // a harmless gpg line in a successful-looking build is not a pacman signature problem
    expect(diagnoseJob(aur, ['gpg: error reading key: No public key', 'something else broke'])?.kind).toBe('unknown')
  })

  it('unknown: the last error lines; jobs that are not about packages get nothing', () => {
    const lines = out(`$ pacman -Syu
error: one
warning: two
error: three
error: four
error: five
done`)
    expect(diagnoseJob(up, lines)).toMatchObject({ kind: 'unknown', lines: [3, 4, 5], actions: [{ type: 'terminal' }] })
    expect(errorLines(['ok'])).toEqual([])
    expect(diagnoseJob({ kind: 'fs-delete', paths: ['/mnt/x'] }, lines)).toBeUndefined()
    expect(diagnoseJob({ kind: 'images-update' }, lines)).toBeUndefined()
  })

  it('terminal commands come from a fixed list', () => {
    expect(isTerminalCommand('pacman-syu')).toBe(true)
    expect(isTerminalCommand('rm -rf /')).toBe(false)
    expect(isTerminalCommand('toString')).toBe(false)
  })

  it('job specs: unlock with an allowed retry only, keyring upgrade', () => {
    expect(parseJobSpec({ kind: 'pacman-unlock' })).toEqual({ kind: 'pacman-unlock' })
    expect(parseJobSpec({ kind: 'pacman-unlock', retry: 'aur-upgrade' })).toEqual({ kind: 'pacman-unlock', retry: 'aur-upgrade' })
    expect(() => parseJobSpec({ kind: 'pacman-unlock', retry: 'remove' })).toThrow()
    expect(parseJobSpec({ kind: 'keyring-upgrade', extra: 1 })).toEqual({ kind: 'keyring-upgrade' })
  })

  it('running package managers from /proc', () => {
    const proc = mkdtempSync(join(tmpdir(), 'qd-proc-'))
    const add = (pid: string, comm: string) => (mkdirSync(join(proc, pid)), writeFileSync(join(proc, pid, 'comm'), `${comm}\n`))
    add('1', 'systemd')
    add('200', 'bash')
    expect(runningPackageManagers(proc)).toEqual([])
    add('301', 'yay')
    add('302', 'pacman')
    mkdirSync(join(proc, 'self'))
    mkdirSync(join(proc, '400')) // gone in between: no comm
    expect(runningPackageManagers(proc)).toEqual(['pacman', 'yay'])
  })
})
