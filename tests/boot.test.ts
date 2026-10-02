import { describe, expect, it } from 'vitest'
import { FixtureBoot, assertTimeout } from '~/server/boot/backend'
import {
  bootWarnings,
  decodeEfiString,
  describeTimeout,
  loaderConfValue,
  parseBootctlList,
  parseBootctlStatus,
  parseCmdline,
  parseSystemdVersion,
  parseTimeout,
  versionOlder,
  type BootEntry,
  type BootState,
} from '~/shared/boot'

// Shapes as printed by systemd 256/257 (bootctl list --json=short, bootctl status).
const LIST = JSON.stringify([
  {
    type: 'type1',
    source: 'esp',
    id: 'arch.conf',
    path: '/boot/loader/entries/arch.conf',
    root: '/boot',
    title: 'Arch Linux',
    showTitle: 'Arch Linux',
    sortKey: 'arch',
    version: '6.16.8-arch1-1',
    linux: '/vmlinuz-linux',
    initrd: ['/intel-ucode.img', '/initramfs-linux.img'],
    options: 'root=UUID=0a1b rw quiet',
    isReported: true,
    isDefault: true,
    isSelected: true,
  },
  { type: 'type1', id: 'arch-lts.conf', title: 'Arch Linux LTS', version: '6.12.48-1-lts', linux: '/vmlinuz-linux-lts', initrd: '/initramfs-linux-lts.img', isDefault: false, isSelected: false },
  { type: 'type2', id: 'arch-linux.efi', showTitle: 'Arch Linux (UKI)', isDefault: false, isSelected: false },
  { type: 'auto', id: 'auto-reboot-to-firmware-setup', title: 'Reboot Into Firmware Interface', isDefault: false, isSelected: false },
])

const STATUS = `System:
      Firmware: UEFI 2.80 (American Megatrends 5.27)
 Firmware Arch: x64
   Secure Boot: disabled (setup)
  TPM2 Support: yes
  Measured UKI: no
  Boot into FW: supported

Current Boot Loader:
      Product: systemd-boot 256.4-1-arch
     Features: ✓ Boot counting
          ESP: /dev/disk/by-partuuid/1c2d3e4f-0000-4000-8000-000000000001
         File: └─/EFI/systemd/systemd-bootx64.efi

Available Boot Loaders on ESP:
          ESP: /boot (/dev/disk/by-partuuid/1c2d3e4f-0000-4000-8000-000000000001)
         File: ├─/EFI/systemd/systemd-bootx64.efi (systemd-boot 257.9-1-arch)
               └─/EFI/BOOT/BOOTX64.EFI (systemd-boot 257.9-1-arch)
`

describe('bootctl', () => {
  it('reads entries from bootctl list --json', () => {
    const e = parseBootctlList(LIST, 'arch-lts.conf')
    expect(e.map((x) => [x.id, x.type, x.isDefault, x.isSelected, x.isOneshot])).toEqual([
      ['arch.conf', 'type1', true, true, false],
      ['arch-lts.conf', 'type1', false, false, true],
      ['arch-linux.efi', 'type2', false, false, false],
      ['auto-reboot-to-firmware-setup', 'auto', false, false, false],
    ])
    expect(e[0]).toMatchObject({ title: 'Arch Linux', version: '6.16.8-arch1-1', linux: '/vmlinuz-linux', initrd: ['/intel-ucode.img', '/initramfs-linux.img'], options: 'root=UUID=0a1b rw quiet', root: '/boot' })
    expect(e[1]!.initrd).toEqual(['/initramfs-linux-lts.img'])
    expect(e[2]!.title).toBe('Arch Linux (UKI)')
    expect(parseBootctlList('not json')).toEqual([])
  })

  it('reads bootctl status and versions', () => {
    expect(parseBootctlStatus(STATUS)).toEqual({ firmware: 'UEFI 2.80 (American Megatrends 5.27)', secureBoot: 'disabled (setup)', runningVersion: '256.4-1-arch', espVersion: '257.9-1-arch', firmwareSetup: true })
    expect(parseBootctlStatus('System:\n   Secure Boot: enabled (user)\n  Boot into FW: not supported\n').firmwareSetup).toBe(false)
    expect(parseSystemdVersion('systemd 257 (257.9-1-arch)\n+PAM +AUDIT')).toBe('257.9-1-arch')
    expect(versionOlder('256.4-1-arch', '257.9-1-arch')).toBe(true)
    expect(versionOlder('257.9-1-arch', '257.9-1-arch')).toBe(false)
    expect(versionOlder('257.10', '257.9')).toBe(false)
  })

  it('reads the timeout from EFI variables and loader.conf', () => {
    const efi = (s: string) => {
      const b = new Uint8Array(4 + (s.length + 1) * 2)
      for (let i = 0; i < s.length; i++) b[4 + i * 2] = s.charCodeAt(i)
      return b
    }
    expect(decodeEfiString(efi('menu-force'))).toBe('menu-force')
    expect(parseTimeout(decodeEfiString(efi('5')))).toBe(5)
    expect(parseTimeout('menu-hidden')).toBe('menu-hidden')
    expect(parseTimeout('0')).toBe(0)
    expect(parseTimeout(undefined)).toBeUndefined()
    expect(loaderConfValue('# comment\ndefault arch.conf\ntimeout 4\nconsole-mode max\n', 'timeout')).toBe('4')
    expect(describeTimeout(3)).toBe('3 s')
    expect(describeTimeout('menu-hidden')).toBe('Menü ausgeblendet')
    expect(() => assertTimeout('5')).not.toThrow()
    expect(() => assertTimeout('menu-force')).not.toThrow()
    expect(() => assertTimeout('601')).toThrow()
    expect(() => assertTimeout('5; reboot')).toThrow()
  })
})

describe('warnings', () => {
  const entry = (o: Partial<BootEntry>): BootEntry => ({ id: 'a.conf', title: 'Arch Linux', type: 'type1', initrd: [], isDefault: false, isSelected: false, isOneshot: false, missing: [], linux: '/vmlinuz-linux', size: 90e6, ...o })
  const state = (o: Partial<BootState>): Omit<BootState, 'warnings'> => ({ loader: 'systemd-boot', entries: [entry({ isDefault: true }), entry({ id: 'lts.conf', linux: '/vmlinuz-linux-lts' })], firmwareSetup: false, cmdline: '', boot: { path: '/boot', size: 1e9, free: 5e8 }, ...o })

  it('is quiet when everything is fine', () => {
    expect(bootWarnings(state({}))).toEqual([])
    expect(bootWarnings(state({ loader: 'grub', entries: [] }))).toEqual([])
  })

  it('warns about a full boot partition before the next kernel update fails', () => {
    expect(bootWarnings(state({ boot: { path: '/boot', size: 3e8, free: 6e7 } }))[0]).toMatchObject({ level: 'critical', text: expect.stringMatching(/nur noch 57 MiB frei – ein Kernel mit initramfs braucht 86 MiB/) })
    expect(bootWarnings(state({ boot: { path: '/boot', size: 1e9, free: 1e8 } }))[0]).toMatchObject({ level: 'warning', text: expect.stringMatching(/zu 90 % voll/) })
  })

  it('warns about missing files, an outdated loader, a single kernel and no default', () => {
    const w = bootWarnings(state({ entries: [entry({ isDefault: true, missing: ['/initramfs-linux.img'] })], espVersion: '256.4', packageVersion: '257.9' }))
    expect(w.map((x) => x.level)).toEqual(['critical', 'warning', 'info'])
    expect(w[0]!.text).toMatch(/fehlende Dateien \(\/initramfs-linux.img\).*Standard-Eintrag/)
    expect(w[1]!.text).toMatch(/bootctl update/)
    expect(w[2]!.text).toMatch(/linux-lts/)
    expect(bootWarnings(state({ entries: [entry({}), entry({ id: 'b', linux: '/vmlinuz-b' })] })).at(-1)!.text).toMatch(/Kein Standard-Eintrag/)
  })
})

describe('kernel command line', () => {
  it('splits and explains the parameters', () => {
    const p = parseCmdline('initrd=\\arch\\initramfs-linux.img root=UUID=0a1b rw rootflags=subvol=@ i915.enable_guc=3 usbcore.autosuspend=-1 quiet foo="a b" -- --init-arg')
    expect(p.map((x) => x.name)).toEqual(['initrd', 'root', 'rw', 'rootflags', 'i915.enable_guc', 'usbcore.autosuspend', 'quiet', 'foo'])
    expect(p[3]).toMatchObject({ value: 'subvol=@' })
    expect(p[4]!.text).toMatch(/QuickSync/)
    expect(p[5]!.text).toMatch(/USB-Platten/)
    expect(p[7]).toEqual({ name: 'foo', value: 'a b', text: undefined })
  })
})

describe('demo machine', () => {
  it('sets default and timeout, reboots once into another entry', async () => {
    const b = new FixtureBoot('fixtures/demo')
    let s = await b.bootState()
    expect(s.warnings.map((w) => w.text)).toEqual([expect.stringMatching(/älter als das installierte systemd/)])
    const lts = s.entries[1]!
    s = await b.setBootDefault(lts.id)
    expect(s.entries.find((e) => e.isDefault)!.id).toBe(lts.id)
    s = await b.setBootTimeout('menu-hidden')
    expect(s).toMatchObject({ timeout: 'menu-hidden', timeoutSource: 'efi' })
    await b.reboot({ entry: s.entries[0]!.id })
    expect((await b.bootState()).entries[0]!.isOneshot).toBe(true)
    expect(b.reboots).toEqual([{ entry: s.entries[0]!.id }])
    expect((await b.cancelOneshot()).oneshot).toBeUndefined()
    expect((await b.updateBootLoader()).warnings).toEqual([])
    await expect(b.setBootDefault('nope.conf')).rejects.toThrow(/gibt es nicht/)
    await expect(b.reboot({ entry: '../x' })).rejects.toThrow(/Ungültiger Eintrag/)
  })
})
