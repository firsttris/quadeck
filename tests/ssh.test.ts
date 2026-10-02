import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { judgeSettings, keyLoginPossible, loginUsers, parseSshChange, SystemSsh } from '~/server/ssh/backend'
import { addKey, parseAuthLog, parseAuthorizedKeys, parseEstablished, parseDropIn, parseKeyLine, parseSshdT, removeKey, renderDropIn } from '~/server/ssh/keys'
import type { SshUser } from '~/shared/ssh'

const demo = JSON.parse(readFileSync('fixtures/demo/ssh.json', 'utf8')) as { users: { keys: string[] }[]; hostKeys: string[] }
const [laptop, phone] = demo.users[1]!.keys as [string, string]
const desktop = readFileSync('tests/fixtures/desktop.pub', 'utf8').trim()
const rsa4096 = readFileSync('tests/fixtures/rsa4096.pub', 'utf8').trim()

describe('keys', () => {
  it('computes the same fingerprints and sizes as ssh-keygen -l', () => {
    // Expected values from `ssh-keygen -lf` on the same files.
    expect(parseKeyLine(laptop)).toMatchObject({ key: { type: 'ssh-ed25519', bits: 256, fingerprint: 'SHA256:1lzw73vp0zALTm+XWgbuhGELqbyFhRtZW5+SRDdsqTE', comment: 'tristan@laptop' } })
    expect(parseKeyLine(phone)).toMatchObject({ key: { type: 'ssh-rsa', bits: 2048, fingerprint: 'SHA256:h6I/cms+IIamV/4ZJ/nCKEJNNx0qHVdBix3W9uJHu2Q', weak: expect.stringContaining('2048') } })
    expect(parseKeyLine(rsa4096)).toMatchObject({ key: { bits: 4096, fingerprint: 'SHA256:DLc6yHKIE4pt0mXJhdJQj6xPu6IZFIu1BWcero4Fb7s', weak: undefined } })
    expect(parseKeyLine(demo.hostKeys[1]!)).toMatchObject({ key: { type: 'ecdsa-sha2-nistp256', bits: 256, fingerprint: 'SHA256:N0Jx2MfxxwX5UvLuJhHNJIEVKMB7SnW9Fj+7+nLGKbg' } })
  })

  it('rejects garbage and mismatched key data, keeps options', () => {
    expect(parseKeyLine('hello world')).toEqual({ error: expect.stringContaining('Kein bekannter Schlüsseltyp') })
    expect(parseKeyLine('ssh-ed25519 !!!')).toEqual({ error: expect.stringContaining('Base64') })
    // RSA data labelled as ed25519
    expect(parseKeyLine(`ssh-ed25519 ${phone.split(' ')[1]} x`)).toEqual({ error: expect.stringContaining('passen nicht') })
    const withOpts = `from="192.168.1.*",no-pty ${laptop}`
    expect(parseKeyLine(withOpts)).toMatchObject({ key: { options: 'from="192.168.1.*",no-pty', comment: 'tristan@laptop' } })
  })

  it('adds, deduplicates and removes keys without touching other lines', () => {
    const file = `# Laptop\n${laptop}\ncommand="/usr/bin/backup" ${phone}\n`
    expect(parseAuthorizedKeys(file)).toHaveLength(2)
    const added = addKey(file, `  ${desktop}  `)
    expect(added).toBe(`${file}${desktop}\n`)
    expect(() => addKey(added, desktop)).toThrow('schon eingetragen')
    expect(() => addKey(file, `no-pty ${desktop}`)).toThrow('Optionen')
    expect(() => addKey(file, 'ssh-ed25519 AAAA')).toThrow()
    const fp = (parseKeyLine(phone) as { key: { fingerprint: string } }).key.fingerprint
    expect(removeKey(added, fp)).toBe(`# Laptop\n${laptop}\n${desktop}\n`)
  })
})

describe('sshd settings', () => {
  it('reads sshd -T (first value wins, synonyms)', () => {
    const out = 'port 22\nport 2222\npermitrootlogin without-password\npubkeyauthentication yes\npasswordauthentication no\nallowusers tristan admin\n'
    expect(parseSshdT(out)).toEqual({ ports: [22, 2222], permitRootLogin: 'prohibit-password', pubkeyAuthentication: true, passwordAuthentication: false, allowUsers: ['tristan', 'admin'] })
  })

  it('renders and reads the drop-in', () => {
    const s = { passwordAuthentication: false, permitRootLogin: 'no' as const, allowUsers: ['tristan'] }
    const text = renderDropIn(s)
    expect(text).toContain('PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers tristan\n')
    expect(parseDropIn(text)).toEqual(s)
    expect(renderDropIn({ ...s, passwordAuthentication: true, allowUsers: [] })).not.toMatch(/KbdInteractive|AllowUsers/)
    expect(parseDropIn('')).toBeNull()
  })

  it('refuses settings that would lock everyone out', () => {
    const u = (name: string, uid: number, keys: number, problems: string[] = []): SshUser => ({
      name,
      uid,
      home: `/home/${name}`,
      problems,
      keys: Array.from({ length: keys }, (_, i) => ({ type: 'ssh-ed25519', fingerprint: `fp${name}${i}`, comment: '' })),
    })
    const users = [u('root', 0, 1), u('tristan', 1000, 0)]
    expect(judgeSettings(users, { passwordAuthentication: false, permitRootLogin: 'prohibit-password', allowUsers: [] }).blocked).toBeUndefined()
    expect(judgeSettings(users, { passwordAuthentication: false, permitRootLogin: 'no', allowUsers: [] }).blocked).toContain('niemand')
    expect(judgeSettings(users, { passwordAuthentication: false, permitRootLogin: 'prohibit-password', allowUsers: ['tristan'] }).blocked).toContain('niemand')
    expect(judgeSettings(users, { passwordAuthentication: true, permitRootLogin: 'no', allowUsers: ['root'] }).blocked).toContain('Kein erlaubter')
    // Keys sshd ignores (permissions) do not count.
    expect(keyLoginPossible([u('tristan', 1000, 1, ['~/.ssh ist für andere beschreibbar'])], { passwordAuthentication: false, permitRootLogin: 'no', allowUsers: [] })).toBe(false)
    expect(judgeSettings(users, { passwordAuthentication: true, permitRootLogin: 'yes', allowUsers: ['bob'] }).warnings.join()).toMatch(/Unbekannte Benutzer.*bob/)
  })

  it('validates changes from outside', () => {
    expect(() => parseSshChange({ kind: 'add-key', user: '../root', key: 'x' })).toThrow()
    expect(() => parseSshChange({ kind: 'add-key', user: 'tristan', key: `${laptop}\n${phone}` })).toThrow('Genau eine')
    expect(() => parseSshChange({ kind: 'remove-key', user: 'tristan', fingerprint: 'nope' })).toThrow()
    expect(() => parseSshChange({ kind: 'settings', settings: { permitRootLogin: 'maybe' } })).toThrow()
    expect(() => parseSshChange({ kind: 'settings', settings: { permitRootLogin: 'no', allowUsers: ['a b'] } })).toThrow()
    expect(parseSshChange({ kind: 'settings', settings: { passwordAuthentication: false, permitRootLogin: 'no', allowUsers: ['tristan', 'tristan'] } })).toEqual({
      kind: 'settings',
      settings: { passwordAuthentication: false, permitRootLogin: 'no', allowUsers: ['tristan'] },
      force: false,
    })
  })
})

describe('journal', () => {
  it('reads accepted logins and counts failures per IP', () => {
    const now = 1_800_000_000_000
    const s = (ago: number) => ((now - ago * 1000) / 1000).toFixed(6)
    const log = [
      `${s(60)} nas sshd-session[812]: Accepted publickey for tristan from 192.168.1.31 port 51234 ssh2: ED25519 SHA256:1lzw73vp0zALTm+XWgbuhGELqbyFhRtZW5+SRDdsqTE`,
      `${s(3600)} nas sshd[700]: Accepted password for tristan from 10.8.0.2 port 40000 ssh2`,
      `${s(30)} nas sshd[900]: Failed password for root from 45.155.205.233 port 1 ssh2`,
      `${s(20)} nas sshd[901]: Failed password for invalid user admin from 45.155.205.233 port 2 ssh2`,
      `${s(10)} nas sshd[902]: Invalid user test from 103.152.18.40 port 3`,
      `${s(90000)} nas sshd[1]: Failed password for root from 1.2.3.4 port 1 ssh2`,
    ].join('\n')
    const r = parseAuthLog(log, now)
    expect(r.logins).toEqual([
      { ts: now - 60_000, method: 'publickey', user: 'tristan', from: '192.168.1.31', port: 51234, fingerprint: 'SHA256:1lzw73vp0zALTm+XWgbuhGELqbyFhRtZW5+SRDdsqTE' },
      { ts: now - 3_600_000, method: 'password', user: 'tristan', from: '10.8.0.2', port: 40000, fingerprint: undefined },
    ])
    expect(r.failed).toEqual([
      { from: '45.155.205.233', count: 2, last: now - 20_000 },
      { from: '103.152.18.40', count: 1, last: now - 10_000 },
    ])
  })
})

describe('open connections', () => {
  it('finds clients connected to sshd in ss output (IPv4, IPv6, mapped)', () => {
    const out = [
      '0      0      192.168.1.20:22     192.168.1.31:51234',
      '0      0      192.168.1.20:8484   192.168.1.31:60000',
      '0      0      [::ffff:192.168.1.20]:22 [::ffff:10.8.0.2]:40000',
      '0      52     [2001:db8::20]:2222 [2001:db8::31]:50000',
      '0      0      192.168.1.20:41000  1.1.1.1:22',
    ].join('\n')
    expect([...parseEstablished(out, [22, 2222])].sort()).toEqual(['10.8.0.2:40000', '192.168.1.31:51234', '2001:db8::31:50000'])
  })
})

describe('SystemSsh on a temp directory', () => {
  it('lists login users, adds keys with safe permissions, removes them, writes the drop-in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-ssh-'))
    const etc = join(root, 'etc-ssh')
    mkdirSync(join(etc, 'sshd_config.d'), { recursive: true })
    writeFileSync(join(etc, 'sshd_config'), 'Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n')
    writeFileSync(join(etc, 'ssh_host_ecdsa_key.pub'), demo.hostKeys[1]!)
    const home = join(root, 'home', 'tristan')
    mkdirSync(home, { recursive: true, mode: 0o755 })
    const passwd = join(root, 'passwd')
    writeFileSync(passwd, `root:x:0:0:root:${join(root, 'roothome')}:/bin/bash\nbin:x:1:1::/:/usr/bin/nologin\ntristan:x:1000:1000::${home}:/bin/bash\nquadeck:x:970:970::/var/lib/quadeck:/usr/bin/nologin\n`)
    expect(loginUsers(readFileSync(passwd, 'utf8')).map((u) => u.name)).toEqual(['root', 'tristan'])

    const s = new SystemSsh({ etc, passwd, live: false })
    let st = await s.sshState()
    expect(st.hostKeys).toEqual([{ type: 'ecdsa-sha2-nistp256', bits: 256, fingerprint: 'SHA256:N0Jx2MfxxwX5UvLuJhHNJIEVKMB7SnW9Fj+7+nLGKbg' }])
    expect(st.dropInActive).toBe(true)

    const p = await s.previewSsh({ kind: 'add-key', user: 'tristan', key: phone })
    expect(p.warnings[0]).toContain('2048')
    await expect(s.previewSsh({ kind: 'add-key', user: 'quadeck', key: laptop })).rejects.toMatchObject({ status: 404 })
    st = await s.applySsh({ kind: 'add-key', user: 'tristan', key: laptop })
    expect(st.users.find((u) => u.name === 'tristan')!.keys.map((k) => k.comment)).toEqual(['tristan@laptop'])
    expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, '.ssh', 'authorized_keys')).mode & 0o777).toBe(0o600)

    // Passwords off: allowed (tristan has a key) …
    st = await s.applySsh({ kind: 'settings', settings: { passwordAuthentication: false, permitRootLogin: 'no', allowUsers: [] } })
    expect(readFileSync(join(etc, 'sshd_config.d', '01-quadeck.conf'), 'utf8')).toContain('PasswordAuthentication no')
    expect(st.managed).toEqual({ passwordAuthentication: false, permitRootLogin: 'no', allowUsers: [] })
    // … but removing the last key would lock everyone out.
    const fp = st.users.find((u) => u.name === 'tristan')!.keys[0]!.fingerprint
    const blocked = await s.previewSsh({ kind: 'remove-key', user: 'tristan', fingerprint: fp })
    expect(blocked.blocked).toContain('letzte')
    await expect(s.applySsh({ kind: 'remove-key', user: 'tristan', fingerprint: fp })).rejects.toMatchObject({ status: 409 })
    st = await s.applySsh({ kind: 'remove-key', user: 'tristan', fingerprint: fp, force: true })
    expect(st.users.find((u) => u.name === 'tristan')!.keys).toEqual([])
    expect(readFileSync(join(home, '.ssh', 'authorized_keys.quadeck-bak'), 'utf8')).toContain('tristan@laptop')
  })
})
