import { describe, expect, it } from 'vitest'
import { parseExports, parseSmbConf } from '~/server/collectors/shares'

describe('smb.conf', () => {
  const conf = `
[global]
   workgroup = WORKGROUP
; comment
[homes]
   browseable = no
[Medien]
   path = /mnt/storage/media
   read only = yes
   guest ok = yes
[Fotos]
   path = /mnt/storage/photos
   Writeable = Yes
   valid users = @family, tristan
[Backup]
   path = /mnt/backup
   read only = no
   browseable = no
[Default]
   path = /srv/default
[off]
   path = /srv/off
   available = no
[printers]
   path = /var/spool/samba
   printable = yes
[noPath]
   comment = no path here
`
  const shares = parseSmbConf(conf)

  it('lists real shares and skips global, homes, printers, disabled and pathless sections', () => {
    expect(shares.map((s) => s.name)).toEqual(['Medien', 'Fotos', 'Backup', 'Default'])
  })

  it('derives access from read only / writable (default read only)', () => {
    const by = (n: string) => shares.find((s) => s.name === n)!
    expect(by('Medien')).toEqual({ type: 'SMB', name: 'Medien', path: '/mnt/storage/media', access: 'lesen', note: 'Gast erlaubt' })
    expect(by('Fotos')).toMatchObject({ access: 'lesen/schreiben', note: 'nur @family, tristan' })
    expect(by('Backup')).toMatchObject({ access: 'lesen/schreiben', note: 'versteckt' })
    expect(by('Default').access).toBe('lesen')
  })
})

describe('/etc/exports', () => {
  it('parses clients, options, quotes and continuations', () => {
    const shares = parseExports(`# comment
/mnt/storage/downloads  192.168.1.0/24(rw,sync,no_subtree_check) 10.0.0.5(ro)
"/mnt/with space"  *(ro)
/srv/nfs4 \\
   192.168.1.20(rw,fsid=0)
/srv/bare
`)
    expect(shares).toEqual([
      { type: 'NFS', name: 'downloads', path: '/mnt/storage/downloads', access: '192.168.1.0/24, 10.0.0.5 (ro)' },
      { type: 'NFS', name: 'with space', path: '/mnt/with space', access: '* (ro)' },
      { type: 'NFS', name: 'nfs4', path: '/srv/nfs4', access: '192.168.1.20' },
      { type: 'NFS', name: 'bare', path: '/srv/bare', access: '* (ro)' },
    ])
  })
})
