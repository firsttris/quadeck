import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureUnitEditor, SystemUnitEditor, UnitHistory, verifyDiagnostics, verifyUnitFile } from '~/server/systemd/editor'
import { assertUnit, lintUnit, originOf, writablePath } from '~/shared/unit-files'

const hasAnalyze = !!Bun.which('systemd-analyze')

describe('rules', () => {
  it('allows only the unit file and drop-ins in /etc/systemd/system', () => {
    expect(writablePath('foo.service', '/etc/systemd/system/foo.service')).toBe('fragment')
    expect(writablePath('foo.service', '/etc/systemd/system/foo.service.d/override.conf')).toBe('dropin')
    expect(writablePath('foo.service', '/usr/lib/systemd/system/foo.service')).toBeUndefined()
    expect(writablePath('foo.service', '/etc/systemd/system/bar.service')).toBeUndefined()
    expect(writablePath('foo.service', '/etc/systemd/system/foo.service.d/../../passwd.conf')).toBeUndefined()
    expect(writablePath('foo.service', '/etc/systemd/system/foo.service.d/x.txt')).toBeUndefined()
    expect(originOf('/run/systemd/generator/caddy.service')).toBe('generated')
    expect(originOf('/usr/lib/systemd/system/sshd.service')).toBe('vendor')
    expect(() => assertUnit('../x.service')).toThrow()
    expect(() => assertUnit('x.conf')).toThrow()
    expect(() => assertUnit('getty@tty1.service')).not.toThrow()
  })

  it('lints structure and additive list keys in overrides', () => {
    expect(lintUnit('Foo=1\n[Service]\nExecStart=/bin/true\n', 'fragment')[0]).toMatchObject({ line: 1, severity: 'error' })
    expect(lintUnit('[Service]\nso nicht\n', 'fragment')[0]).toMatchObject({ line: 2, severity: 'error' })
    expect(lintUnit('# nur Kommentar\n', 'fragment')[0]?.severity).toBe('error')
    expect(lintUnit('[Service]\nExecStart=/bin/x\n', 'dropin')[0]).toMatchObject({ line: 2, severity: 'warning' })
    expect(lintUnit('[Service]\nExecStart=\nExecStart=/bin/x\n', 'dropin')).toEqual([])
  })
})

describe('verify', () => {
  it('maps systemd-analyze output', () => {
    const tmp = '/tmp/quadeck-verify-abc'
    const out = [
      `${tmp}/foo.service.d/override.conf:3: Failed to parse service restart specifier, ignoring: sometimes`,
      `${tmp}/foo.service:5: Unknown key name 'FooBar' in section 'Service', ignoring.`,
      `/etc/systemd/system/foo.service.d/zz.conf:2: Nice priority out of range, ignoring: 99`,
      `/etc/systemd/system/other.service:1: unrelated`,
      'Binding to IPv6 address not available since kernel does not support IPv6.',
      'foo.service: Command /nonexist is not executable: No such file or directory',
      'Unit foo.service has a bad unit file setting.',
    ].join('\n')
    expect(verifyDiagnostics(out, 'foo.service', tmp, `${tmp}/foo.service.d/override.conf`)).toEqual([
      { line: 3, severity: 'error', message: 'Failed to parse service restart specifier, ignoring: sometimes' },
      { line: undefined, severity: 'warning', message: "Hauptdatei, Zeile 5: Unknown key name 'FooBar' in section 'Service', ignoring." },
      { line: undefined, severity: 'error', message: '/etc/systemd/system/foo.service.d/zz.conf:2: Nice priority out of range, ignoring: 99' },
      { line: undefined, severity: 'warning', message: 'Command /nonexist is not executable: No such file or directory' },
    ])
  })

  it.skipIf(!hasAnalyze)('checks fragments and overrides with systemd-analyze verify', async () => {
    const good = await verifyUnitFile('qd-test.service', '/etc/systemd/system/qd-test.service', 'fragment', '[Service]\nExecStart=/bin/true\nRestart=on-failure\n', undefined)
    expect(good).toMatchObject({ ok: true, diagnostics: [] })
    const bad = await verifyUnitFile('qd-test.service', '/etc/systemd/system/qd-test.service', 'fragment', '[Service]\nExecStart=/bin/true\nRestart=sometimes\nFooBar=1\n', undefined)
    expect(bad.ok).toBe(false)
    expect(bad.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ line: 3, severity: 'error' }), expect.objectContaining({ line: 4, severity: 'warning', message: expect.stringContaining('FooBar') })]))
    const drop = await verifyUnitFile('qd-test.service', '/etc/systemd/system/qd-test.service.d/override.conf', 'dropin', '[Service]\nMemoryMax=1Q\n', '[Service]\nExecStart=/bin/true\n')
    expect(drop.diagnostics[0]).toMatchObject({ line: 2, severity: 'error' })
    const twice = await verifyUnitFile('qd-test.service', '/etc/systemd/system/qd-test.service.d/override.conf', 'dropin', '[Service]\nExecStart=/bin/false\n', '[Service]\nExecStart=/bin/true\n')
    expect(twice.ok).toBe(false) // two ExecStart= on a simple service
    expect((await verifyUnitFile('a@.service', '/etc/systemd/system/a@.service', 'fragment', '[Service]\nExecStart=/bin/true\n', undefined)).skipped).toBeTruthy()
  })
})

describe('UnitHistory', () => {
  it('keeps the original, saved versions and deletions, newest first', () => {
    const h = new UnitHistory(mkdtempSync(join(tmpdir(), 'qd-hist-')))
    const p = '/etc/systemd/system/a.service'
    h.saved(p, 'v0', 'v1')
    h.saved(p, 'v1', 'v2')
    h.add(p, 'v2', 'deleted')
    const list = h.list(p)
    expect(list.map((r) => r.message)).toEqual(['Vor dem Löschen', 'Gespeichert', 'Gespeichert', 'Ursprünglicher Stand'])
    expect(h.read(p, list[1]!.id)).toBe('v2')
    expect(h.read(p, list[3]!.id)).toBe('v0')
    expect(() => h.read(p, '../x')).toThrow()
    for (let i = 0; i < 40; i++) h.add(p, `x${i}`, 'saved')
    expect(h.list(p)).toHaveLength(30)
  })
})

describe('SystemUnitEditor (without a running systemd)', () => {
  it('refuses paths outside the unit dir, symlinks and Quadeck itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-units-'))
    const e = new SystemUnitEditor(dir, join(dir, '.hist'))
    await expect(e.validateUnitFile('a.service', '/usr/lib/systemd/system/a.service', '[Service]\nExecStart=/bin/true\n')).rejects.toThrow(/Override/)
    await expect(e.validateUnitFile('quadeck.service', `${dir}/quadeck.service`, '[Service]\n')).rejects.toThrow(/Quadeck selbst/)
    writeFileSync(join(dir, 'real.service'), '[Service]\nExecStart=/bin/true\n')
    symlinkSync(join(dir, 'real.service'), join(dir, 'link.service'))
    await expect(e.validateUnitFile('link.service', `${dir}/link.service`, '[Service]\nExecStart=/bin/true\n')).rejects.toThrow(/Symlink/)
    await expect(e.validateUnitFile('a.service', `${dir}/a.service`, 'x\u0001')).rejects.toThrow(/Steuerzeichen/)
    if (hasAnalyze) expect((await e.validateUnitFile('a.service', `${dir}/a.service`, '[Service]\nExecStart=/bin/true\n')).ok).toBe(true)
  })
})

describe('FixtureUnitEditor', () => {
  it('shows vendor files read-only and edits overrides with history', async () => {
    const e = new FixtureUnitEditor('fixtures/demo')
    const smb = await e.unitDetail('smb.service')
    expect(smb.parts.map((p) => [p.path, p.editable])).toEqual([
      ['/usr/lib/systemd/system/smb.service', false],
      ['/etc/systemd/system/smb.service.d/override.conf', true],
    ])
    expect(smb.overridePath).toBeUndefined()
    await expect(e.writeUnitFile('smb.service', '/usr/lib/systemd/system/smb.service', '[Service]\n', false)).rejects.toThrow(/Override/)
    const path = '/etc/systemd/system/smb.service.d/override.conf'
    await e.writeUnitFile('smb.service', path, '[Unit]\nRequiresMountsFor=/srv/daten /srv/fotos\n', true)
    expect((await e.unitFileHistory('smb.service', path)).map((r) => r.message)).toEqual(['Gespeichert', 'Ursprünglicher Stand'])
    await e.deleteUnitFile('smb.service', path)
    expect((await e.unitDetail('smb.service')).overridePath).toBe(path)

    const caddy = await e.unitDetail('caddy.service')
    expect(caddy).toMatchObject({ quadlet: 'caddy.container', canDelete: false })
    expect(caddy.parts[0]).toMatchObject({ origin: 'generated', editable: false })
    expect((await e.unitDetail('restic-backup.service')).canDelete).toBe(true)
  })

  it('refuses a save over a file that changed since it was loaded', async () => {
    const { contentHash } = await import('~/shared/caddy')
    const e = new FixtureUnitEditor('fixtures/demo')
    const path = '/etc/systemd/system/smb.service.d/override.conf'
    const loaded = (await e.unitDetail('smb.service')).parts.find((p) => p.path === path)!.content
    await e.writeUnitFile('smb.service', path, '[Unit]\nRequiresMountsFor=/srv/a\n', false) // another tab
    await expect(e.writeUnitFile('smb.service', path, '[Unit]\nRequiresMountsFor=/srv/b\n', false, contentHash(loaded))).rejects.toMatchObject({ status: 409 })
    const now = (await e.unitDetail('smb.service')).parts.find((p) => p.path === path)!.content
    await e.writeUnitFile('smb.service', path, '[Unit]\nRequiresMountsFor=/srv/b\n', false, contentHash(now))
    await expect(e.writeUnitFile('smb.service', '/etc/systemd/system/smb.service.d/new.conf', '[Unit]\n', false, contentHash(''))).resolves.toBeTruthy()
  })

  it('creates units and refuses duplicates and bad names', async () => {
    const e = new FixtureUnitEditor('fixtures/demo')
    await e.createUnit('hello.service', '[Unit]\nDescription=Hallo\n[Service]\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n', true)
    expect((await e.unitDetail('hello.service')).description).toBe('Hallo')
    await expect(e.createUnit('hello.service', '[Service]\nExecStart=/bin/true\n', false)).rejects.toThrow(/gibt es schon/)
    await expect(e.createUnit('../x.service', '[Service]\n', false)).rejects.toThrow(/Name/)
    await expect(e.createUnit('quadeck.service', '[Service]\nExecStart=/bin/true\n', false)).rejects.toThrow(/Quadeck/)
    await e.setUnitEnabled('hello.service', false)
    expect((await e.unitDetail('hello.service')).unitFileState).toBe('disabled')
    await e.deleteUnitFile('hello.service', '/etc/systemd/system/hello.service')
    await expect(e.unitDetail('hello.service')).rejects.toThrow(/gibt es nicht/)
  })
})
