import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoMountsInside, fsJobSteps, gnuCoreutils, mountsInside } from '~/server/files/transfer'
import { TransactionalUpdate, rootReadOnly, snapshotPending } from '~/server/packages/providers'
import { checkExpectations, formatReport, osIds, parsePodmanVersion, quadletSupport, type DoctorReport } from '~/server/doctor'
import { FEATURES, installCommand } from '~/shared/packages'

const MOUNTS = ['/dev/sda2 / btrfs ro,relatime,subvolid=268,subvol=/@/.snapshots/5/snapshot 0 0', '/dev/sdb1 /mnt/disk2 ext4 rw,relatime 0 0', '/dev/sdc1 /mnt/disk2/Fotos/USB\\040Stick vfat rw 0 0', 'proc /proc proc rw 0 0'].join('\n')

describe('file jobs with BusyBox', () => {
  it('tells BusyBox/Toybox cp from GNU (and compatible) cp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quadeck-cu-'))
    writeFileSync(join(dir, 'busybox'), '')
    symlinkSync(join(dir, 'busybox'), join(dir, 'cp'))
    writeFileSync(join(dir, 'gnu-cp'), '')
    expect(gnuCoreutils(() => join(dir, 'cp'))).toBe(false)
    expect(gnuCoreutils(() => join(dir, 'gnu-cp'))).toBe(true)
    expect(gnuCoreutils(() => null)).toBe(true)
  })

  it('leaves out the GNU-only flags', () => {
    const copy = { kind: 'fs-copy' as const, paths: ['/a'], toDir: '/b', overwrite: false }
    expect(fsJobSteps(copy, { sources: ['/a'], toDir: '/b' })).toEqual([['cp', '-a', '-v', '--reflink=auto', '--', '/a', '/b']])
    expect(fsJobSteps(copy, { sources: ['/a'], toDir: '/b' }, false)).toEqual([['cp', '-a', '-v', '--', '/a', '/b']])
    expect(fsJobSteps({ kind: 'fs-delete', paths: ['/x'] }, { sources: ['/x'] }, false)).toEqual([['rm', '-r', '-f', '-v', '--', '/x']])
  })

  it('without --one-file-system, refuses to delete a tree with a mount inside', () => {
    expect(mountsInside(['/mnt/disk2/Fotos'], MOUNTS)).toEqual(['/mnt/disk2/Fotos/USB Stick'])
    expect(mountsInside(['/mnt/disk2/Fot'], MOUNTS)).toEqual([]) // a prefix of a name is not "inside"
    expect(mountsInside(['/mnt/disk2/Fotos/USB Stick'], MOUNTS)).toEqual([]) // the mount point itself is fine
    expect(() => assertNoMountsInside(['/mnt/disk2'], MOUNTS)).toThrow(/USB Stick/)
    expect(() => assertNoMountsInside(['/mnt/disk2/Filme'], MOUNTS)).not.toThrow()
  })
})

describe('transactional-update (openSUSE MicroOS)', () => {
  it('detects a read-only root', () => {
    expect(rootReadOnly(MOUNTS)).toBe(true)
    expect(rootReadOnly('/dev/sda2 / ext4 rw,relatime 0 0')).toBe(false)
    expect(rootReadOnly('overlay /usr overlay ro 0 0')).toBe(false)
  })

  it('sees a snapshot waiting for the next boot', () => {
    expect(snapshotPending('ID 271 gen 4410 top level 266 path @/.snapshots/6/snapshot', MOUNTS)).toBe(true)
    expect(snapshotPending('ID 268 gen 4410 top level 266 path @/.snapshots/5/snapshot', MOUNTS)).toBe(false)
    expect(snapshotPending('', MOUNTS)).toBe(false)
    expect(snapshotPending('ID 271 gen 1', '/dev/sda2 / ext4 rw 0 0')).toBe(false)
  })

  it('runs every change through transactional-update, stacking on a pending snapshot', () => {
    const t = new TransactionalUpdate()
    expect(t.id).toBe('transactional-update')
    const tu = ['transactional-update', '--non-interactive', '--continue']
    expect(t.installSteps(['samba'])).toEqual([{ argv: [...tu, 'pkg', 'install', '--', 'samba'] }])
    expect(t.removeSteps(['nano'])).toEqual([{ argv: [...tu, 'pkg', 'remove', '-u', '--', 'nano'] }])
    expect(t.upgradeSteps()[0]!.argv.slice(0, 3)).toEqual(tu)
    expect(['dup', 'up']).toContain(t.upgradeSteps()[0]!.argv[3])
  })

  it('installs features with the openSUSE package names and says to reboot', () => {
    for (const f of Object.values(FEATURES)) expect(f.packages['transactional-update']).toEqual(f.packages.zypper)
    expect(installCommand('transactional-update', 'nfs')).toBe('sudo transactional-update pkg install nfs-kernel-server && sudo systemctl reboot')
  })
})

describe('quadeck doctor', () => {
  const base: DoctorReport = { os: 'Debian GNU/Linux 12 (bookworm)', osIds: ['debian'], arch: 'x64', libc: 'glibc', packageManager: 'apt', init: 'systemd', podman: '4.3.1', quadlets: false, coreutils: 'gnu', bootLoader: 'other', root: true }

  it('knows which Podman has Quadlets', () => {
    expect(parsePodmanVersion('podman version 4.3.1')).toEqual([4, 3, 1])
    expect(parsePodmanVersion('podman version 5.2')).toEqual([5, 2, 0])
    expect(parsePodmanVersion('nope')).toBeUndefined()
    expect(quadletSupport([4, 3, 1])).toBe(false)
    expect(quadletSupport([4, 4, 0])).toBe(true)
    expect(quadletSupport([5, 0, 0])).toBe(true)
    expect(quadletSupport([3, 9, 9])).toBe(false)
  })

  it('reads ID and ID_LIKE', () => {
    expect(osIds('NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n')).toEqual(['opensuse-tumbleweed', 'opensuse', 'suse'])
    expect(osIds('ID=arch\n')).toEqual(['arch'])
    expect(osIds('')).toEqual([])
  })

  it('explains what is missing', () => {
    const text = formatReport(base)
    expect(text).toMatch(/Podman:\s+4\.3\.1 {2}– Quadlets need Podman 4\.4 or newer/)
    expect(text).toMatch(/Boot loader:\s+other {2}– boot entries need systemd-boot/)
    expect(formatReport({ ...base, init: 'other', packageManager: null, podman: null })).toMatch(/Package manager: none {2}– package pages hidden[\s\S]*Init:\s+other[\s\S]*not installed {2}– container pages hidden/)
  })

  it('checks --expect for CI', () => {
    expect(checkExpectations(base, ['packageManager=apt', 'osIds=debian', 'libc=glibc', 'quadlets=false'])).toEqual([])
    expect(checkExpectations(base, ['packageManager=dnf'])).toEqual(['packageManager: expected dnf, found apt'])
    expect(checkExpectations(base, ['osIds=fedora'])).toEqual(['osIds: expected fedora, found debian'])
    expect(checkExpectations(base, ['nope=1', 'libc'])).toEqual(['unknown expectation: nope=1', 'unknown expectation: libc'])
  })
})

describe('install.sh', () => {
  it('is valid POSIX sh', async () => {
    const r = Bun.spawnSync(['sh', '-n', 'install.sh'])
    expect(r.exitCode).toBe(0)
  })
})
