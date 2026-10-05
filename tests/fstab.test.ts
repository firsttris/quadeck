import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureFstabHost, FstabManager, SystemFstabHost, parseBlockDevices, pathsInUse, usedUnder, verifyDiagnostics } from '~/server/fstab/backend'
import {
  applyChange,
  checkFile,
  checkInput,
  defaultOptions,
  escapeField,
  formatEntry,
  isBootCritical,
  mountUnit,
  newlyCritical,
  parseFstab,
  protectedLinesChanged,
  specFor,
  specMatches,
  suggestTarget,
  systemReason,
  targetProblem,
  unescapeField,
  type BlockDevice,
  type EntryInput,
} from '~/shared/fstab'

const SAMPLE = readFileSync('fixtures/demo/fstab', 'utf8')
const backup: BlockDevice = { path: '/dev/sde1', name: 'sde1', disk: 'sde', fstype: 'ext4', uuid: 'd3e4f5a6-b7c8-4d9e-8f01-2a3b4c5d6e7f', label: 'Backup', size: 4e12, mountpoints: [] }
const newEntry = (over: Partial<EntryInput> = {}): EntryInput => ({ spec: specFor(backup), file: '/mnt/backup', vfstype: 'ext4', options: defaultOptions('ext4'), freq: 0, passno: 2, note: 'Backup (WD40EFRX)', ...over })

describe('parse and write', () => {
  it('parses entries, keeps escapes and reports broken lines', () => {
    const { entries, diagnostics } = parseFstab(SAMPLE)
    expect(entries.map((e) => e.file)).toEqual(['/', '/boot', '/boot/efi', '/home', '/mnt/disk1', '/mnt/disk2', '/mnt/disk3', '/mnt/parity1', '/mnt/storage', '/mnt/archiv'])
    expect(entries[0]).toMatchObject({ line: 8, vfstype: 'btrfs', options: ['subvol=root', 'compress=zstd:1'] })
    expect(diagnostics).toEqual([])
    expect(parseFstab('LABEL=a\\040b /mnt/my\\040disk ext4 defaults 0 2\n').entries[0]).toMatchObject({ spec: 'LABEL=a b', file: '/mnt/my disk' })
    expect(parseFstab('/dev/sda1 /mnt/a b ext4 defaults 0 2 x\n').diagnostics[0]).toMatchObject({ line: 1, severity: 'error' })
    expect(parseFstab('/dev/sda1\n').diagnostics[0]?.severity).toBe('error')
    expect(parseFstab('/dev/sda1 /mnt/a ext4 defaults x 2\n').diagnostics[0]?.message).toMatch(/Zahl/)
  })

  it('escapes and unescapes fields', () => {
    expect(escapeField('/mnt/my disk\\x')).toBe('/mnt/my\\040disk\\134x')
    expect(unescapeField(escapeField('/a b\tc'))).toBe('/a b\tc')
    expect(formatEntry(newEntry({ file: '/mnt/my disk' }))).toBe('UUID=d3e4f5a6-b7c8-4d9e-8f01-2a3b4c5d6e7f\t/mnt/my\\040disk\text4\tnofail,x-systemd.device-timeout=10s,noatime\t0\t2')
  })

  it('adds with a note, updates and removes in place; comments stay', () => {
    const added = applyChange(SAMPLE, { kind: 'add', entry: newEntry() })
    expect(added.startsWith(SAMPLE)).toBe(true)
    expect(added.endsWith('\n\n# quadeck: Backup (WD40EFRX)\n' + formatEntry(newEntry()) + '\n')).toBe(true)
    const e = parseFstab(added).entries.find((x) => x.file === '/mnt/backup')!
    const updated = applyChange(added, { kind: 'update', line: e.line, original: e.raw, entry: newEntry({ options: ['nofail'] }) })
    expect(updated).toContain('/mnt/backup\text4\tnofail\t0\t2')
    expect(updated).toContain('# quadeck: Backup (WD40EFRX)')
    const removed = applyChange(updated, { kind: 'remove', line: e.line, original: parseFstab(updated).entries.find((x) => x.file === '/mnt/backup')!.raw })
    expect(removed).toBe(SAMPLE)
    expect(() => applyChange(SAMPLE, { kind: 'remove', line: 8, original: 'anders' })).toThrow(/inzwischen geändert/)
  })
})

describe('rules', () => {
  it('protects system entries and root subvolumes', () => {
    const { entries } = parseFstab(SAMPLE)
    const root = ['UUID=8c1f3e2a-5d4b-4c6e-9f1a-2b3c4d5e6f70']
    expect(entries.filter((e) => systemReason(e, root)).map((e) => e.file)).toEqual(['/', '/boot', '/boot/efi', '/home'])
    expect(systemReason({ spec: 'UUID=x', file: 'none', vfstype: 'swap' })).toBe('Auslagerungsspeicher')
    expect(systemReason({ spec: root[0]!, file: '/.snapshots', vfstype: 'btrfs' }, root)).toMatch(/Subvolume/)
    expect(protectedLinesChanged(SAMPLE, SAMPLE.replace('subvol=home', 'subvol=home2'), root)).toMatch(/Systemeintrag/)
    expect(protectedLinesChanged(SAMPLE, SAMPLE + 'UUID=y none swap defaults 0 0\n', root)).toMatch(/Neuer Systemeintrag/)
    expect(protectedLinesChanged(SAMPLE, SAMPLE.replace('/mnt/disk3  xfs  defaults', '/mnt/disk3  xfs  defaults,nofail'), root)).toBeUndefined()
  })

  it('refuses system directories as mount points', () => {
    for (const t of ['/', '/etc', '/usr/local', '/boot/x', '/var', '/home', '/proc/x', 'mnt/x', '/mnt/../etc', '/mnt/x/']) expect(targetProblem(t), t).toBeDefined()
    for (const t of ['/mnt/backup', '/srv/media', '/data', '/home/tristan/usb', '/var/lib/data']) expect(targetProblem(t), t).toBeUndefined()
  })

  it('knows what stops the boot', () => {
    const e = (options: string[], vfstype = 'ext4') => ({ file: '/mnt/x', vfstype, options })
    expect(isBootCritical(e(['defaults']))).toBe(true)
    expect(isBootCritical(e(['nofail']))).toBe(false)
    expect(isBootCritical(e(['noauto']))).toBe(false)
    expect(isBootCritical(e(['x-systemd.automount']))).toBe(false)
    expect(isBootCritical(e(['defaults'], 'nfs'))).toBe(false)
    expect(isBootCritical(e(['_netdev']))).toBe(false)
    expect(newlyCritical(SAMPLE, SAMPLE.replace('/mnt/disk2  xfs  defaults,nofail', '/mnt/disk2  xfs  defaults'))).toEqual(['/mnt/disk2'])
    expect(newlyCritical(SAMPLE, SAMPLE)).toEqual([]) // disk3 was critical already
  })

  it('checks form values: options, values, fsck order', () => {
    expect(checkInput(newEntry())).toEqual([])
    expect(checkInput(newEntry({ options: ['nofail', 'noatim'] }))[0]).toMatchObject({ severity: 'warning', message: expect.stringMatching(/noatim/) })
    expect(checkInput(newEntry({ options: ['nofail', 'nofail'] })).some((d) => d.severity === 'error')).toBe(true)
    expect(checkInput(newEntry({ options: ['ro', 'rw'] })).some((d) => d.severity === 'error')).toBe(true)
    expect(checkInput(newEntry({ options: ['uid'], vfstype: 'exfat' })).some((d) => /braucht einen Wert/.test(d.message))).toBe(true)
    expect(checkInput(newEntry({ options: ['x-systemd.device-timeout=lang'] })).some((d) => /Dauer/.test(d.message))).toBe(true)
    expect(checkInput(newEntry({ options: ['a b'] })).some((d) => /unerlaubte Zeichen/.test(d.message))).toBe(true)
    expect(checkInput(newEntry({ vfstype: 'xfs', passno: 2 })).some((d) => /fsck/.test(d.message))).toBe(true)
    expect(checkInput(newEntry({ spec: 'rm -rf /' })).some((d) => d.severity === 'error')).toBe(true)
    expect(checkInput(newEntry({ options: ['compress=zstd'] }))[0]?.message).toMatch(/kennt Quadeck für ext4 nicht/)
  })

  it('finds duplicate mount points in the whole file', () => {
    expect(checkFile(SAMPLE)).toEqual([])
    expect(checkFile(SAMPLE + 'UUID=x /mnt/disk1 xfs defaults 0 0\n')[0]).toMatchObject({ line: 20, severity: 'error' })
  })

  it('names devices, suggests targets and unit names like systemd-escape', () => {
    expect(specFor(backup)).toBe('UUID=d3e4f5a6-b7c8-4d9e-8f01-2a3b4c5d6e7f')
    expect(specFor(backup, 'label')).toBe('LABEL=Backup')
    expect(specMatches('UUID=D3E4F5A6-B7C8-4D9E-8F01-2A3B4C5D6E7F', backup)).toBe(true)
    expect(specMatches('LABEL=Backup', backup)).toBe(true)
    expect(specMatches('/dev/sde1', backup)).toBe(true)
    expect(specMatches('LABEL=backup', backup)).toBe(false)
    expect(suggestTarget(backup, ['/mnt/backup'])).toBe('/mnt/backup-2')
    expect(mountUnit('/mnt/disk1')).toBe('mnt-disk1.mount')
    expect(mountUnit('/mnt/bad space')).toBe('mnt-bad\\x20space.mount')
    expect(mountUnit('/mnt/a-b', 'automount')).toBe('mnt-a\\x2db.automount')
    expect(mountUnit('/srv/.hidden')).toBe('srv-.hidden.mount')
  })
})

describe('host helpers', () => {
  it('reads lsblk with nested partitions and skips what cannot be mounted', () => {
    const json = JSON.stringify({
      blockdevices: [
        { name: 'sda', path: '/dev/sda', type: 'disk', size: 100, model: 'WDC X', children: [{ name: 'sda1', path: '/dev/sda1', type: 'part', size: 90, fstype: 'xfs', uuid: 'u1', mountpoints: ['/mnt/a'] }] },
        { name: 'sdb', path: '/dev/sdb', type: 'disk', size: 100, fstype: 'linux_raid_member', children: [{ name: 'md0', path: '/dev/md0', type: 'raid1', size: 99, fstype: 'ext4', uuid: 'u2', mountpoints: [null] }] },
        { name: 'sdc', path: '/dev/sdc', type: 'disk', size: 100, children: [{ name: 'sdc1', path: '/dev/sdc1', type: 'part', size: 50, fstype: 'swap', uuid: 'u3', mountpoints: ['[SWAP]'] }] },
        { name: 'loop0', path: '/dev/loop0', type: 'loop', size: 10, fstype: 'squashfs' },
      ],
    })
    expect(parseBlockDevices(json)).toEqual([
      { path: '/dev/sda1', name: 'sda1', disk: 'sda', fstype: 'xfs', uuid: 'u1', partuuid: undefined, label: undefined, partlabel: undefined, size: 90, model: 'WDC X', mountpoints: ['/mnt/a'] },
      { path: '/dev/md0', name: 'md0', disk: 'sdb', fstype: 'ext4', uuid: 'u2', partuuid: undefined, label: undefined, partlabel: undefined, size: 99, model: undefined, mountpoints: [] },
    ])
  })

  it('finds shares, exports and container volumes under a mount point', () => {
    const all = pathsInUse({
      smb: '[global]\n  workgroup = X\n[Filme]\n  path = /mnt/disk1/Filme\n',
      exports: ['/mnt/disk2/backup 192.168.1.0/24(rw)\n# /mnt/archiv *(ro)\n'],
      quadlets: [{ name: 'jellyfin.container', text: '[Container]\nVolume=/mnt/disk1/Filme:/media:ro\nVolume=jf-config:/config\n' }],
    })
    expect(usedUnder(all, '/mnt/disk1')).toEqual(['SMB-Freigabe [Filme]', 'jellyfin.container'])
    expect(usedUnder(all, '/mnt/disk2')).toEqual(['NFS-Export'])
    expect(usedUnder(all, '/mnt/archiv')).toEqual([])
    expect(usedUnder(all, '/mnt/disk')).toEqual([])
  })

  it('maps findmnt --verify output to the changed entries', () => {
    const out = `0 parse errors, 3 errors, 1 warning\n/mnt/backup\n   [E] unreachable on boot required target: No such file or directory\n   [E] unknown filesystem type 'ext5'\n/mnt/disk1\n   [E] something else\n`
    const changed = parseFstab('UUID=x /mnt/backup ext5 defaults 0 0\n').entries
    expect(verifyDiagnostics(out, changed, '/mnt/backup')).toEqual([{ line: 1, severity: 'error', message: "findmnt: unknown filesystem type 'ext5'" }])
    expect(verifyDiagnostics('1 parse error, 0 errors\n', [], undefined)[0]?.severity).toBe('error')
  })
})

describe('manager (demo machine)', () => {
  const manager = () => new FstabManager(new FixtureFstabHost('fixtures/demo'))

  it('shows entries with state, protects the system and lists free devices', async () => {
    const s = await manager().fstabState()
    const by = (f: string) => s.entries.find((e) => e.file === f)!
    expect(by('/').system).toBeDefined()
    expect(by('/home').system).toMatch(/System/)
    expect(by('/mnt/disk1')).toMatchObject({ mounted: true, bootCritical: false, missing: false, device: { name: 'sda1' } })
    expect(by('/mnt/storage')).toMatchObject({ mounted: true, missing: false, usedBy: ['SMB-Freigabe [Medien]', 'SMB-Freigabe [Fotos]', 'NFS-Export', 'jellyfin.container'] })
    expect(by('/mnt/disk3').bootCritical).toBe(true)
    expect(by('/mnt/archiv')).toMatchObject({ missing: true, mounted: false })
    expect(s.devices.map((d) => d.name)).toEqual(['sde1', 'sdf1', 'sdg2'])
  })

  it('adds a disk: checks, test mount, write, mount', async () => {
    const m = manager()
    const check = await m.validateFstab({ kind: 'add', entry: newEntry() })
    expect(check).toMatchObject({ ok: true, bootCritical: [], createDir: '/mnt/backup' })
    expect(check.actions.join('\n')).toMatch(/Probemount[\s\S]*anlegen[\s\S]*daemon-reload[\s\S]*mnt-backup\.mount starten/)
    const s = await m.applyFstab({ kind: 'add', entry: newEntry() }, false)
    expect(s.entries.find((e) => e.file === '/mnt/backup')).toMatchObject({ mounted: true, device: { name: 'sde1' } })
    expect(s.devices.map((d) => d.name)).toEqual(['sdf1', 'sdg2'])
    expect(s.history.map((h) => h.message)).toEqual(['Gespeichert', 'Ursprünglicher Stand'])
  })

  it('refuses wrong devices, file systems, missing drivers and taken targets', async () => {
    const m = manager()
    const msg = async (e: Partial<EntryInput>) => (await m.validateFstab({ kind: 'add', entry: newEntry(e) })).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
    expect(await msg({ spec: 'UUID=0000' })).toEqual([expect.stringMatching(/Kein Gerät/)])
    expect(await msg({ vfstype: 'xfs', passno: 0 })).toEqual([expect.stringMatching(/ist ext4, nicht xfs/)])
    expect(await msg({ spec: 'LABEL=Windows', vfstype: 'ntfs-3g', options: ['nofail'], passno: 0 })).toEqual([expect.stringMatching(/Treiber für ntfs-3g fehlt – Paket ntfs-3g/)])
    expect(await msg({ file: '/mnt/disk1' })).toEqual(expect.arrayContaining([expect.stringMatching(/steht schon in Zeile/)]))
    expect(await msg({ file: '/etc' })).toEqual([expect.stringMatching(/Systemverzeichnis/)])
  })

  it('needs a confirmation for an entry that would stop the boot', async () => {
    const m = manager()
    const entry = newEntry({ options: ['noatime'] })
    expect((await m.validateFstab({ kind: 'add', entry })).bootCritical).toEqual(['/mnt/backup'])
    await expect(m.applyFstab({ kind: 'add', entry }, false)).rejects.toThrow(/Start blockieren/)
    await expect(m.applyFstab({ kind: 'add', entry }, true)).resolves.toBeDefined()
  })

  it('a failing test mount leaves the file untouched', async () => {
    const host = new FixtureFstabHost('fixtures/demo')
    const m = new FstabManager(host)
    await expect(m.applyFstab({ kind: 'add', entry: newEntry({ options: ['nofail', 'compress=zstd'] }) }, false)).rejects.toThrow(/Probemount fehlgeschlagen/)
    expect(host.read()).toBe(SAMPLE)
  })

  it('changes options of a mounted entry by remount and removes entries after unmounting', async () => {
    const m = manager()
    const disk3 = (await m.fstabState()).entries.find((e) => e.file === '/mnt/disk3')!
    const entry: EntryInput = { spec: disk3.spec, file: disk3.file, vfstype: 'xfs', options: ['defaults', 'nofail', 'noatime'], freq: 0, passno: 0 }
    const check = await m.validateFstab({ kind: 'update', line: disk3.line, original: disk3.raw, entry })
    expect(check.actions).toContain('/mnt/disk3 mit den neuen Optionen neu einhängen (remount)')
    let s = await m.applyFstab({ kind: 'update', line: disk3.line, original: disk3.raw, entry }, false)
    expect(s.entries.find((e) => e.file === '/mnt/disk3')).toMatchObject({ bootCritical: false, mounted: true })
    const archiv = s.entries.find((e) => e.file === '/mnt/archiv')!
    s = await m.applyFstab({ kind: 'remove', line: archiv.line, original: archiv.raw }, false)
    expect(s.entries.some((e) => e.file === '/mnt/archiv')).toBe(false)
    const root = s.entries.find((e) => e.file === '/')!
    await expect(m.applyFstab({ kind: 'remove', line: root.line, original: root.raw }, false)).rejects.toThrow(/Systempartition/)
    await expect(m.applyFstab({ kind: 'restore', content: SAMPLE.replace('subvol=root', 'subvol=x') }, false)).rejects.toThrow(/Systemeintrag/)
    await expect(m.applyFstab({ kind: 'restore', content: SAMPLE + 'LABEL=Backup /etc ext4 nofail 0 0\n' }, false)).rejects.toThrow(/Systemverzeichnis/)
  })

  it('mounts and unmounts, never system entries', async () => {
    const m = manager()
    let s = await m.mountAction('/mnt/disk2', 'unmount')
    expect(s.entries.find((e) => e.file === '/mnt/disk2')!.mounted).toBe(false)
    s = await m.mountAction('/mnt/disk2', 'mount')
    expect(s.entries.find((e) => e.file === '/mnt/disk2')!.mounted).toBe(true)
    await expect(m.mountAction('/mnt/archiv', 'mount')).rejects.toThrow(/Einhängen fehlgeschlagen/)
    await expect(m.mountAction('/boot', 'unmount')).rejects.toThrow(/Systempartition/)
  })
})

const hasGenerator = ['/usr/lib/systemd/system-generators/systemd-fstab-generator', '/lib/systemd/system-generators/systemd-fstab-generator'].some((p) => {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
})

describe.skipIf(!hasGenerator)('systemd fstab generator', () => {
  it('reports the entries that would stop the boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-fstab-'))
    writeFileSync(join(dir, 'fstab'), '')
    const host = new SystemFstabHost(join(dir, 'fstab'), join(dir, 'history'))
    const crit = await host.critical('UUID=a /mnt/a ext4 defaults 0 2\nUUID=b /mnt/b xfs defaults,nofail 0 0\nUUID=c /mnt/my\\040disk ext4 defaults 0 0\nsrv:/x /mnt/nfs nfs defaults 0 0\n')
    expect([...(crit ?? [])].sort()).toEqual(['mnt-a.mount', 'mnt-my\\x20disk.mount'])
  })
})

describe('mount unit names', () => {
  it('escape like systemd-escape --path, also outside the BMP', () => {
    // expected values from `systemd-escape --path --suffix=mount`
    expect(mountUnit('/mnt/😀')).toBe('mnt-\\xf0\\x9f\\x98\\x80.mount')
    expect(mountUnit('/mnt/Füße')).toBe('mnt-F\\xc3\\xbc\\xc3\\x9fe.mount')
    expect(mountUnit('/srv/.hidden')).toBe('srv-.hidden.mount')
    expect(mountUnit('/mnt/x-y')).toBe('mnt-x\\x2dy.mount')
  })
})
