import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureConfigFs, SystemConfigFs, applyConfigAction, configFileInfo } from '~/server/packages/configfiles'
import { findConfigFiles } from '~/server/packages/maintenance'
import { describeConfigFile, parseConfigPath } from '~/shared/configfiles'

describe('rules', () => {
  it('knows the suffixes of all package managers', () => {
    expect(parseConfigPath('/etc/pacman.conf.pacnew')).toEqual({ live: '/etc/pacman.conf', kind: 'new' })
    expect(parseConfigPath('/etc/pam.d/kde.pacsave')).toEqual({ live: '/etc/pam.d/kde', kind: 'save' })
    expect(parseConfigPath('/etc/x.conf.pacsave.1')).toEqual({ live: '/etc/x.conf', kind: 'save' })
    expect(parseConfigPath('/etc/ssh/sshd_config.dpkg-dist')).toEqual({ live: '/etc/ssh/sshd_config', kind: 'new' })
    expect(parseConfigPath('/etc/dnf/dnf.conf.rpmnew')).toEqual({ live: '/etc/dnf/dnf.conf', kind: 'new' })
    expect(parseConfigPath('/etc/passwd')).toBeUndefined()
  })

  it('protects account files and explains the tricky ones', () => {
    expect(describeConfigFile('/etc/passwd.pacnew', 'new', '/etc/passwd').noReplace).toMatch(/kennt deine Benutzer nicht/)
    expect(describeConfigFile('/etc/shells.pacnew', 'new', '/etc/shells').noReplace).toMatch(/zsh, fish/)
    expect(describeConfigFile('/etc/ssh/sshd_config.pacnew', 'new', '/etc/ssh/sshd_config')).toMatchObject({ check: 'sshd -t', after: 'sshd-reload' })
    expect(describeConfigFile('/etc/mkinitcpio.conf.pacnew', 'new', '/etc/mkinitcpio.conf')).toMatchObject({ after: 'mkinitcpio', note: expect.stringMatching(/HOOKS/) })
    expect(describeConfigFile('/etc/pam.d/kde.pacsave', 'save', '/etc/pam.d/kde').note).toMatch(/^Gesicherte Fassung/)
  })
})

describe('replace risks', () => {
  it('keeps the initramfs hooks and the Samba shares', async () => {
    const { replaceRisk } = await import('~/shared/configfiles')
    const live = 'MODULES=(i915 btrfs)\nHOOKS=(base systemd sd-encrypt filesystems)\n'
    expect(replaceRisk('/etc/mkinitcpio.conf', live, 'MODULES=()\n# comment\nHOOKS=(base systemd filesystems)\n')).toMatch(/MODULES, HOOKS weichen/)
    expect(replaceRisk('/etc/mkinitcpio.conf', live, '# new comments\nMODULES=(i915  btrfs)\nHOOKS=(base systemd sd-encrypt filesystems)\n')).toBeUndefined()
    expect(replaceRisk('/etc/samba/smb.conf', '[global]\n[Filme]\n path=/x\n[homes]\n', '[global]\n')).toMatch(/Freigaben \(Filme\)/)
    expect(replaceRisk('/etc/samba/smb.conf', '[global]\n[homes]\n', '[global]\n')).toBeUndefined()
  })
})

describe('demo', () => {
  const setup = () => {
    const files: Record<string, string> = {
      '/etc/passwd': 'root:x:0:0::/root:/bin/bash\ntristan:x:1000:1000::/home/tristan:/bin/bash\n',
      '/etc/passwd.pacnew': 'root:x:0:0::/root:/usr/bin/bash\n',
      '/etc/ssh/sshd_config': 'Port 22\nUsePAM yes\n',
      '/etc/ssh/sshd_config.pacnew': '#Port 22\nUsePAM yes\n',
      '/etc/mirrorlist': 'Server = a\n',
      '/etc/mirrorlist.pacnew': '#Server = b\n',
      '/etc/pam.d/kde.pacsave': 'auth include x\n',
    }
    const ref = { configFiles: ['/etc/mirrorlist.pacnew', '/etc/pam.d/kde.pacsave', '/etc/passwd.pacnew', '/etc/ssh/sshd_config.pacnew'] }
    return { fs: new FixtureConfigFs(files, ref), files, ref }
  }

  it('shows both versions; refuses paths outside the list', async () => {
    const { fs } = setup()
    expect(await configFileInfo(fs, '/etc/ssh/sshd_config.pacnew')).toMatchObject({ live: '/etc/ssh/sshd_config', kind: 'new', liveExists: true, liveContent: 'Port 22\nUsePAM yes\n', content: '#Port 22\nUsePAM yes\n', check: 'sshd -t' })
    await expect(configFileInfo(fs, '/etc/shadow')).rejects.toThrow(/nicht \(mehr\) in der Liste/)
  })

  it('keep, replace with backup, merge with check; never replace passwd', async () => {
    const { fs, files, ref } = setup()
    await expect(applyConfigAction(fs, '/etc/passwd.pacnew', 'replace')).rejects.toThrow(/kennt deine Benutzer nicht/)
    await expect(applyConfigAction(fs, '/etc/passwd.pacnew', 'merge', 'x')).rejects.toThrow(/kennt deine Benutzer nicht/)
    expect(await applyConfigAction(fs, '/etc/passwd.pacnew', 'keep')).toEqual({ done: '/etc/passwd bleibt, /etc/passwd.pacnew gelöscht' })
    expect(files['/etc/passwd']).toMatch(/tristan/)

    await applyConfigAction(fs, '/etc/mirrorlist.pacnew', 'replace')
    expect(files['/etc/mirrorlist']).toBe('#Server = b\n')
    expect(files['/etc/mirrorlist.quadeck-bak']).toBe('Server = a\n')

    await expect(applyConfigAction(fs, '/etc/ssh/sshd_config.pacnew', 'merge', 'Port zwanzig\nUsePAM yes\n')).rejects.toThrow(/sshd -t lehnt die Datei ab – nichts geändert/)
    expect(files['/etc/ssh/sshd_config']).toBe('Port 22\nUsePAM yes\n')
    expect(await applyConfigAction(fs, '/etc/ssh/sshd_config.pacnew', 'merge', 'Port 2222\nUsePAM yes')).toMatchObject({ done: '/etc/ssh/sshd_config gespeichert', after: 'sshd-reload' })
    expect(files['/etc/ssh/sshd_config']).toBe('Port 2222\nUsePAM yes\n')

    await expect(applyConfigAction(fs, '/etc/pam.d/kde.pacsave', 'replace')).rejects.toThrow(/nur gelöscht/)
    await applyConfigAction(fs, '/etc/pam.d/kde.pacsave', 'keep')
    expect(ref.configFiles).toEqual([])
  })
})

describe('on disk', () => {
  it('writes atomically, keeps the mode and leaves a backup', async () => {
    const etc = mkdtempSync(join(tmpdir(), 'qd-conf-'))
    mkdirSync(join(etc, 'pacman.d'))
    writeFileSync(join(etc, 'pacman.d', 'mirrorlist'), 'Server = a\n')
    chmodSync(join(etc, 'pacman.d', 'mirrorlist'), 0o640)
    writeFileSync(join(etc, 'pacman.d', 'mirrorlist.pacnew'), '#Server = b\n')
    writeFileSync(join(etc, 'locale.gen.pacnew'), 'de_DE.UTF-8 UTF-8\n')
    const list = () => findConfigFiles(etc, /\.(pacnew|pacsave)$/)
    expect(list()).toEqual([join(etc, 'locale.gen.pacnew'), join(etc, 'pacman.d', 'mirrorlist.pacnew')])
    const fs = new SystemConfigFs(list)
    const info = await configFileInfo(fs, join(etc, 'locale.gen.pacnew'))
    expect(info).toMatchObject({ liveExists: false, liveContent: undefined, content: 'de_DE.UTF-8 UTF-8\n' })
    await applyConfigAction(fs, join(etc, 'pacman.d', 'mirrorlist.pacnew'), 'replace')
    expect(readFileSync(join(etc, 'pacman.d', 'mirrorlist'), 'utf8')).toBe('#Server = b\n')
    expect(readFileSync(join(etc, 'pacman.d', 'mirrorlist.quadeck-bak'), 'utf8')).toBe('Server = a\n')
    expect(statSync(join(etc, 'pacman.d', 'mirrorlist')).mode & 0o777).toBe(0o640)
    expect(existsSync(join(etc, 'pacman.d', 'mirrorlist.pacnew'))).toBe(false)
    expect(list()).toEqual([join(etc, 'locale.gen.pacnew')])
  })
})
