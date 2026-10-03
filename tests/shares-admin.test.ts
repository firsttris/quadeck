import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sharesSummary } from '~/server/collectors/shares'
import { parseShareChange, SystemShares } from '~/server/shares/backend'
import { parseExportsFile, parseNfsdClientInfo, parseSmbstatusShares, renderExport, setExport, setSmbShare, smbShares } from '~/server/shares/config'
import { validateNfs, validateSharePath, validateSmb, type SmbShareSpec } from '~/shared/shares'

const CONF = `[global]
   workgroup = WORKGROUP
   server string = nas-01

# Filme und Serien
[Medien]
   path = /mnt/storage/media
   comment = Filme
   writeable = no
   guest ok = yes
   create mask = 0664
   ; Vorschaubilder ausblenden
   veto files = /.thumbs/

[Fotos]
   path = /mnt/storage/photos
   writable = yes
   valid users = @family

[printers]
   path = /var/spool/samba
   printable = yes
`

const spec = (p: Partial<SmbShareSpec> = {}): SmbShareSpec => ({ name: 'Medien', path: '/mnt/storage/media', comment: 'Filme', readOnly: true, guestOk: true, validUsers: '', browseable: true, ...p })

describe('smb.conf', () => {
  it('reads shares with synonyms and extra keys', () => {
    expect(smbShares(CONF)).toEqual([
      { name: 'Medien', path: '/mnt/storage/media', comment: 'Filme', readOnly: true, guestOk: true, validUsers: '', browseable: true, extraKeys: ['create mask', 'veto files'] },
      { name: 'Fotos', path: '/mnt/storage/photos', comment: '', readOnly: false, guestOk: false, validUsers: '@family', browseable: true, extraKeys: [] },
    ])
  })

  it('changes one section, keeps other keys/comments, drops contradicting synonyms', () => {
    const out = setSmbShare(CONF, 'Medien', spec({ readOnly: false, guestOk: false, validUsers: 'tristan, @family' }))
    expect(out).toContain('[global]\n   workgroup = WORKGROUP')
    expect(out).toContain('# Filme und Serien\n[Medien]\n   path = /mnt/storage/media\n   comment = Filme\n   read only = no\n   guest ok = no\n   valid users = tristan @family\n   browseable = yes\n   create mask = 0664\n   ; Vorschaubilder ausblenden\n   veto files = /.thumbs/\n')
    expect(out).not.toContain('writeable')
    expect(out.split('[Fotos]')[1]).toBe(CONF.split('[Fotos]')[1])
    expect(smbShares(out)[0]).toMatchObject({ readOnly: false, validUsers: 'tristan @family', extraKeys: ['create mask', 'veto files'] })
  })

  it('renames, creates and deletes sections', () => {
    const renamed = setSmbShare(CONF, 'Medien', spec({ name: 'Filme' }))
    expect(renamed).toContain('[Filme]')
    expect(renamed).not.toContain('[Medien]')
    expect(() => setSmbShare(CONF, 'Medien', spec({ name: 'fotos' }))).toThrow('gibt es schon')
    expect(() => setSmbShare(CONF, undefined, spec({ name: 'Fotos' }))).toThrow('gibt es schon')
    const created = setSmbShare(CONF, undefined, spec({ name: 'Backup', path: '/mnt/backup', comment: '', guestOk: false, browseable: false }))
    expect(created.endsWith('[Backup]\n   path = /mnt/backup\n   read only = yes\n   guest ok = no\n   browseable = no\n')).toBe(true)
    const deleted = setSmbShare(CONF, 'Medien', null)
    expect(deleted).not.toContain('Medien')
    expect(deleted).not.toContain('Filme und Serien') // its comment goes with it
    expect(deleted).toContain('server string = nas-01\n\n[Fotos]')
    expect(() => setSmbShare(CONF, 'Gibtsnicht', null)).toThrow('nicht gefunden')
  })
})

describe('exports', () => {
  const EXP = '# NFS exports\n/mnt/storage/downloads  192.168.1.0/24(rw,sync,no_subtree_check)\n"/mnt/with space" 10.0.0.1(ro) \\\n  10.0.0.2(rw)\n'
  it('parses, replaces, appends and removes lines', () => {
    expect(parseExportsFile(EXP)).toEqual([
      { path: '/mnt/storage/downloads', clients: [{ host: '192.168.1.0/24', options: ['rw', 'sync', 'no_subtree_check'] }], line: 1 },
      { path: '/mnt/with space', clients: [{ host: '10.0.0.1', options: ['ro'] }, { host: '10.0.0.2', options: ['rw'] }], line: 2 },
    ])
    const changed = setExport(EXP, '/mnt/with space', { path: '/mnt/with space', clients: [{ host: '*', options: ['ro', 'sync'] }] })
    expect(changed).toBe('# NFS exports\n/mnt/storage/downloads  192.168.1.0/24(rw,sync,no_subtree_check)\n"/mnt/with space" *(ro,sync)\n')
    expect(setExport(EXP, '/mnt/storage/downloads', null)).toBe('# NFS exports\n"/mnt/with space" 10.0.0.1(ro) \\\n  10.0.0.2(rw)\n')
    expect(setExport('', undefined, { path: '/srv/x', clients: [{ host: 'pc', options: [] }] })).toBe('# Managed by Quadeck – manual changes here are fine too\n/srv/x pc\n')
    expect(() => setExport(EXP, undefined, { path: '/mnt/storage/downloads', clients: [] })).toThrow('schon exportiert')
    expect(renderExport({ path: '/a', clients: [{ host: 'h', options: ['rw'] }] })).toBe('/a h(rw)')
  })
})

describe('validation', () => {
  it('refuses dangerous paths and malformed input', () => {
    for (const p of ['/', 'relative', '/etc', '/etc/samba', '/root/x', '/proc/1', '/var/lib/quadeck', '/mnt/../etc', '/mnt/a\nb', '/mnt/"x"']) expect(validateSharePath(p), p).toBeDefined()
    expect(validateSharePath('/mnt/storage/media/')).toBeUndefined()
    expect(validateSmb(spec())).toEqual([])
    expect(validateSmb(spec({ name: 'global' }))).toHaveLength(1)
    expect(validateSmb(spec({ name: 'A]\n[global' }))).toHaveLength(1)
    expect(validateSmb(spec({ validUsers: 'ok @grp\nbad' }))).toHaveLength(1)
    expect(validateSmb(spec({ comment: 'x\npath = /etc' }))).toHaveLength(1)
    expect(validateNfs({ path: '/mnt/x', clients: [{ host: '192.168.1.0/24', options: ['rw', 'sync', 'fsid=0', 'anonuid=1000'] }] })).toEqual([])
    // Hand-written exports with less common options stay editable.
    expect(validateNfs({ path: '/mnt/x', clients: [{ host: '*.lan', options: ['ro', 'wdelay', 'insecure_locks', 'no_acl', 'mountpoint=/mnt/x', 'refer=/a@srv1+srv2', 'xprtsec=tls:mtls', 'anonuid=-2', 'fsid=1a2b3c4d-1111-2222-3333-444455556666'] }] })).toEqual([])
    expect(validateNfs({ path: '/mnt/x', clients: [{ host: 'h', options: ['mountpoint=/x,rw'] }] })).toHaveLength(1)
    expect(validateNfs({ path: '/mnt/x', clients: [{ host: 'h', options: ['rw', 'ro'] }] })).toHaveLength(1)
    expect(validateNfs({ path: '/mnt/x', clients: [{ host: 'h(rw) *', options: [] }] })).toHaveLength(1)
    expect(validateNfs({ path: '/mnt/x', clients: [{ host: 'h', options: ['rw),*(rw'] }] })).toHaveLength(1)
    expect(validateNfs({ path: '/mnt/x', clients: [] })).toHaveLength(1)
    expect(() => parseShareChange({ kind: 'smb', spec: { ...spec(), path: '/etc' } })).toThrow('/etc')
    expect(() => parseShareChange({ kind: 'ftp' })).toThrow()
    expect(parseShareChange({ kind: 'nfs', original: { file: '/etc/exports', path: '/mnt/a' }, spec: null })).toEqual({ kind: 'nfs', original: { file: '/etc/exports', path: '/mnt/a' }, spec: null })
  })
})

describe('status output', () => {
  it('parses smbstatus -S and nfsd client info', () => {
    const out = `
Service      pid     Machine       Connected at                     Encryption   Signing
---------------------------------------------------------------------------------------------
IPC$         4711    192.168.1.31  Fri Oct  2 12:00:01 2026 CEST    -            -
Medien       4711    192.168.1.31  Fri Oct  2 12:00:01 2026 CEST    -            -
`
    expect(parseSmbstatusShares(out)).toMatchObject([{ share: 'Medien', client: '192.168.1.31' }])
    expect(parseNfsdClientInfo("clientid: 0x1\naddress: '192.168.1.20:839'\nstatus: confirmed\n")).toBe('192.168.1.20')
  })
})

describe('SystemShares on temp files', () => {
  it('previews, applies with backup and keeps the overview in sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-shares-'))
    const data = join(root, 'data')
    mkdirSync(data)
    const smbConf = join(root, 'smb.conf')
    writeFileSync(smbConf, '[global]\n   workgroup = WORKGROUP\n')
    writeFileSync(join(root, 'exports'), `${data} 10.0.0.1(ro)\n`)
    const s = new SystemShares({ smbConf, exports: join(root, 'exports'), exportsDir: join(root, 'exports.d'), reload: false })

    await expect(s.previewShare({ kind: 'smb', spec: spec({ path: join(root, 'missing') }) })).rejects.toMatchObject({ status: 422 })
    const p = await s.previewShare({ kind: 'smb', spec: spec({ name: 'Daten', path: data, guestOk: true, readOnly: false }) })
    expect(p.after).toContain('[Daten]')
    expect(p.warnings[0]).toContain('Gäste dürfen schreiben')
    const st = await s.applyShare({ kind: 'smb', spec: spec({ name: 'Daten', path: data }) })
    expect(st.smb.shares.map((x) => x.name)).toEqual(['Daten'])
    expect(readFileSync(`${smbConf}.quadeck-bak`, 'utf8')).toBe('[global]\n   workgroup = WORKGROUP\n')

    // New exports go to exports.d/quadeck.exports, existing ones stay where they are.
    const st2 = await s.applyShare({ kind: 'nfs', spec: { path: root, clients: [{ host: '192.168.1.0/24', options: ['rw', 'sync'] }] } })
    expect(st2.nfs.exports.map((e) => [e.path, e.managed])).toEqual([
      [data, false],
      [root, true],
    ])
    expect(readFileSync(join(root, 'exports.d', 'quadeck.exports'), 'utf8')).toContain(`${root} 192.168.1.0/24(rw,sync)`)
    const st3 = await s.applyShare({ kind: 'nfs', original: { file: join(root, 'exports'), path: data }, spec: { path: data, clients: [{ host: '10.0.0.1', options: ['rw'] }] } })
    expect(readFileSync(join(root, 'exports'), 'utf8')).toBe(`${data} 10.0.0.1(rw)\n`)
    await expect(s.applyShare({ kind: 'nfs', original: { file: '/etc/passwd', path: '/x' }, spec: null })).rejects.toMatchObject({ status: 400 })
    expect(sharesSummary(st3).map((x) => `${x.type}:${x.name}:${x.access}`)).toEqual(['SMB:Daten:lesen', `NFS:data:10.0.0.1`, `NFS:${root.split('/').pop()}:192.168.1.0/24`])
  })
})
