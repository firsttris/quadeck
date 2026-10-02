import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureUsers, SystemUsers, shadowError } from '~/server/users/backend'
import { parseUserChange } from '~/server/users/parse'
import { adminsWithPassword, changeProblem, describeChange, parseLast, passwordState, type UsersState } from '~/shared/users'

describe('account files', () => {
  it('tells locked, passwordless and expired accounts apart', () => {
    const now = Date.UTC(2026, 9, 2)
    expect(passwordState('$6$rounds=5000$salt$hash', undefined, now)).toEqual({ locked: false, hasPassword: true })
    expect(passwordState('$y$j9T$salt$hash', undefined, now)).toEqual({ locked: false, hasPassword: true })
    expect(passwordState('!$6$salt$hash', undefined, now)).toEqual({ locked: true, hasPassword: true })
    expect(passwordState('*', undefined, now)).toEqual({ locked: false, hasPassword: false })
    expect(passwordState('!*', undefined, now)).toEqual({ locked: true, hasPassword: false })
    expect(passwordState('!', undefined, now)).toEqual({ locked: true, hasPassword: false })
    expect(passwordState('$6$x$y', 1, now)).toEqual({ locked: true, hasPassword: true }) // usermod -e 1
    expect(passwordState('$6$x$y', 30000, now).locked).toBe(false)
  })

  it('reads the login history of last', () => {
    const out = [
      'tristan  pts/0        192.168.1.31     2026-10-02T14:30:00+02:00   still logged in',
      'anna     pts/1        192.168.1.44     2026-09-30T09:10:11+02:00 - 2026-09-30T09:35:00+02:00  (00:24)',
      'tristan  tty1                          2026-09-01T08:00:00+02:00 - 2026-09-01T08:10:00+02:00  (00:10)',
      'reboot   system boot  6.16.8-arch1-1   2026-09-01T07:59:00+02:00   still running',
      '',
      'wtmp begins 2026-08-01T00:00:00+02:00',
    ].join('\n')
    const r = parseLast(out)
    expect(r).toEqual([
      { user: 'tristan', tty: 'pts/0', from: '192.168.1.31', start: Date.parse('2026-10-02T14:30:00+02:00'), end: undefined, active: true },
      { user: 'anna', tty: 'pts/1', from: '192.168.1.44', start: Date.parse('2026-09-30T09:10:11+02:00'), end: Date.parse('2026-09-30T09:35:00+02:00'), active: false },
      { user: 'tristan', tty: 'tty1', from: undefined, start: Date.parse('2026-09-01T08:00:00+02:00'), end: Date.parse('2026-09-01T08:10:00+02:00'), active: false },
    ])
  })

  it('builds the accounts from passwd, group and shadow (real files, read only)', async () => {
    const etc = mkdtempSync(join(tmpdir(), 'qd-users-'))
    const home = join(etc, 'home-tristan')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA2vBQ/IMGRDjntTzCHjHPXPhxVt7vzJsuwXt32ebPIO tristan@laptop\n')
    writeFileSync(join(etc, 'passwd'), `root:x:0:0::/root:/bin/bash\nhttp:x:33:33::/srv/http:/usr/bin/nologin\ntristan:x:1000:1000:Tristan T,,,:${home}:/bin/bash\nnobody:x:65534:65534::/:/usr/bin/nologin\n`)
    writeFileSync(join(etc, 'group'), 'root:x:0:root\nsudo:x:27:tristan\nvideo:x:44:tristan\nhttp:x:33:\ntristan:x:1000:\nmedia:x:1100:tristan\n')
    writeFileSync(join(etc, 'shadow'), 'root:$6$a$b:1::::::\ntristan:$y$j9T$a$b:1::::::\n')
    writeFileSync(join(etc, 'shells'), '# shells\n/bin/sh\n/bin/bash\n/bin/bash\n')
    const s = await new SystemUsers(etc).usersState()
    expect(s.adminGroup).toBe('sudo')
    expect(s.shells).toEqual(['/bin/sh', '/bin/bash'])
    expect(s.accounts.map((a) => a.name)).toEqual(['root', 'tristan'])
    expect(s.accounts[1]).toMatchObject({ fullName: 'Tristan T', groups: ['sudo', 'video', 'media'], admin: true, locked: false, hasPassword: true, keys: 1 })
    expect(s.accounts[0]).toMatchObject({ admin: true, protected: expect.stringMatching(/root/) })
    expect(s.groups.map((g) => g.name)).toEqual(['sudo', 'media', 'video'])
    expect(s.groups.find((g) => g.name === 'video')!.text).toMatch(/Grafikkarte/)
  })
})

describe('checks', () => {
  const base = async () => new FixtureUsers('fixtures/demo').usersState()

  it('never locks out the last administrator with a password', async () => {
    const s = await base()
    expect(adminsWithPassword(s.accounts)).toEqual(['tristan']) // root is locked in the demo
    expect(changeProblem(s, { kind: 'lock', name: 'tristan' })).toMatch(/niemand mehr als Administrator/)
    expect(changeProblem(s, { kind: 'delete', name: 'tristan', removeHome: false })).toMatch(/niemand mehr/)
    expect(changeProblem(s, { kind: 'update', name: 'tristan', fullName: 'Tristan', shell: '/bin/bash', groups: [], admin: false })).toMatch(/niemand mehr/)
    // A second admin with a password first – then it is fine.
    const two: UsersState = { ...s, accounts: s.accounts.map((a) => (a.name === 'anna' ? { ...a, admin: true } : a)) }
    expect(changeProblem(two, { kind: 'lock', name: 'tristan' })).toBeUndefined()
    expect(changeProblem(s, { kind: 'lock', name: 'anna' })).toBeUndefined()
  })

  it('validates names, passwords, shells and groups', async () => {
    const s = await base()
    const create = (o: object) => changeProblem(s, { kind: 'create', name: 'max', fullName: '', admin: false, shell: '/bin/bash', groups: [], ...o })
    expect(create({})).toBeUndefined()
    expect(create({ name: 'Max' })).toMatch(/Kleinbuchstaben/)
    expect(create({ name: 'tristan' })).toMatch(/gibt es schon/)
    expect(create({ password: 'kurz' })).toMatch(/mindestens 8/)
    expect(create({ password: 'a\nb-langes-passwort' })).toMatch(/ungültige Zeichen/)
    expect(create({ shell: '/tmp/evil' })).toMatch(/nicht in \/etc\/shells/)
    expect(create({ groups: ['root'] })).toMatch(/Gruppe root gibt es nicht/)
    expect(create({ fullName: 'a:b' })).toMatch(/Doppelpunkt/)
    expect(changeProblem(s, { kind: 'delete', name: 'root', removeHome: false })).toMatch(/root ist das Systemkonto/)
    expect(changeProblem(s, { kind: 'password', name: 'niemand', password: 'langes-passwort' })).toMatch(/gibt es nicht/)
    expect(describeChange({ kind: 'create', name: 'max', fullName: '', admin: true, shell: '/bin/bash', groups: [] }, 'wheel')).toMatch(/ohne Passwort – Anmeldung nur mit SSH-Schlüssel/)
  })

  it('parses requests strictly', () => {
    expect(parseUserChange({ kind: 'create', name: 'max', fullName: 'Max', admin: true, password: '', shell: '/bin/bash', groups: ['video', 'video'] })).toEqual({ kind: 'create', name: 'max', fullName: 'Max', admin: true, password: undefined, shell: '/bin/bash', groups: ['video'] })
    expect(() => parseUserChange({ kind: 'create', name: 'max', shell: '/bin/bash', groups: 'video' })).toThrow(/Gruppen/)
    expect(() => parseUserChange({ kind: 'drop-table', name: 'x' })).toThrow(/Unbekannte/)
    expect(shadowError('userdel', 'userdel: user tristan is currently used by process 812')).toMatch(/gerade angemeldet/)
  })
})

describe('demo machine', () => {
  it('creates, changes, locks, unlocks and deletes an account', async () => {
    const u = new FixtureUsers('fixtures/demo')
    let s = await u.applyUser({ kind: 'create', name: 'max', fullName: 'Max', admin: false, shell: '/usr/bin/zsh', groups: ['video'] })
    expect(s.accounts.find((a) => a.name === 'max')).toMatchObject({ uid: 1002, hasPassword: false, locked: false, groups: ['video'], admin: false })
    s = await u.applyUser({ kind: 'update', name: 'max', fullName: 'Max M', shell: '/bin/bash', groups: ['render'], admin: true })
    expect(s.accounts.find((a) => a.name === 'max')).toMatchObject({ fullName: 'Max M', shell: '/bin/bash', groups: ['wheel', 'render'], admin: true })
    s = await u.applyUser({ kind: 'password', name: 'max', password: 'ein-langes-passwort' })
    expect(s.accounts.find((a) => a.name === 'max')!.hasPassword).toBe(true)
    // Now there are two admins with a password: tristan may be locked.
    s = await u.applyUser({ kind: 'lock', name: 'tristan' })
    expect(s.accounts.find((a) => a.name === 'tristan')!.locked).toBe(true)
    s = await u.applyUser({ kind: 'unlock', name: 'tristan' })
    expect(s.accounts.find((a) => a.name === 'tristan')).toMatchObject({ locked: false, hasPassword: true })
    s = await u.applyUser({ kind: 'samba-password', name: 'max', password: 'samba-passwort' })
    expect(s.accounts.find((a) => a.name === 'max')!.samba).toBe(true)
    s = await u.applyUser({ kind: 'delete', name: 'max', removeHome: true })
    expect(s.accounts.some((a) => a.name === 'max')).toBe(false)
    await expect(u.applyUser({ kind: 'lock', name: 'tristan' })).rejects.toThrow(/niemand mehr/)
  })
})
