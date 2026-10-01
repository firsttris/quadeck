import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'quadeck-test-'))
process.env.QUADECK_DATA_DIR = dir

const auth = await import('~/server/auth')

const req = (method: string, headers: Record<string, string> = {}) => new Request('http://nas:8484/api/units', { method, headers: { host: 'nas:8484', ...headers } })

describe('same-origin check', () => {
  it('allows safe methods and same-origin writes', () => {
    expect(auth.isSameOrigin(req('GET', { origin: 'http://evil' }))).toBe(true)
    expect(auth.isSameOrigin(req('POST', { origin: 'http://nas:8484' }))).toBe(true)
    expect(auth.isSameOrigin(req('POST'))).toBe(true) // non-browser client
  })
  it('rejects cross-site writes', () => {
    expect(auth.isSameOrigin(req('POST', { origin: 'http://evil' }))).toBe(false)
    expect(auth.isSameOrigin(req('POST', { 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(auth.isSameOrigin(req('POST', { origin: 'null' }))).toBe(false)
  })
})

describe('setup, password and sessions', () => {
  let token = ''
  beforeAll(() => {
    token = auth.ensureSetupToken()!
  })

  it('creates a root-only setup token until a password is set', () => {
    expect(token).toMatch(/^[\w-]{20,}$/)
    expect(statSync(join(dir, 'setup-token')).mode & 0o777).toBe(0o600)
    expect(auth.ensureSetupToken()).toBe(token)
    expect(auth.checkSetupToken('wrong')).toBe(false)
    expect(auth.checkSetupToken(token + '\n')).toBe(true)
  })

  it('enforces a minimum password length and verifies with argon2id', async () => {
    await expect(auth.setPassword('short')).rejects.toThrow(/10 Zeichen/)
    await auth.setPassword('correct horse battery')
    expect(auth.hasPassword()).toBe(true)
    expect(auth.ensureSetupToken()).toBeUndefined()
    expect(() => readFileSync(join(dir, 'setup-token'))).toThrow()
    expect(await auth.verifyPassword('correct horse battery')).toBe(true)
    expect(await auth.verifyPassword('wrong')).toBe(false)
  })

  it('requires session + CSRF token for writes', () => {
    const { token: cookie, session } = auth.createSession()
    const c = { cookie: `other=1; ${auth.SESSION_COOKIE}=${cookie}` }
    expect(() => auth.requireSession(req('GET'))).toThrow(/Nicht angemeldet/)
    expect(auth.requireSession(req('GET', c)).csrf).toBe(session.csrf)
    expect(() => auth.requireSession(req('POST', c))).toThrow(/CSRF/)
    expect(() => auth.requireSession(req('POST', { ...c, 'x-csrf-token': 'nope' }))).toThrow(/CSRF/)
    expect(() => auth.requireSession(req('POST', { ...c, 'x-csrf-token': session.csrf, origin: 'http://evil' }))).toThrow(/Herkunft/)
    expect(auth.requireSession(req('POST', { ...c, 'x-csrf-token': session.csrf })).id).toBe(session.id)
  })

  it('stores only a hash of the cookie token and ends sessions on password change', async () => {
    const { token: cookie, session } = auth.createSession()
    expect(session.id).not.toBe(cookie)
    await auth.setPassword('another long password')
    expect(auth.getSession(req('GET', { cookie: `${auth.SESSION_COOKIE}=${cookie}` }))).toBeUndefined()
  })

  it('marks cookies Secure behind HTTPS', () => {
    expect(auth.sessionCookie(req('GET'), 't')).not.toContain('Secure')
    expect(auth.sessionCookie(req('GET', { 'x-forwarded-proto': 'https' }), 't')).toContain('Secure')
    expect(auth.sessionCookie(req('GET'), 't')).toContain('HttpOnly; SameSite=Strict')
  })
})

describe('login throttling', () => {
  it('blocks after 5 failures and only trusts X-Forwarded-For from a local proxy', () => {
    const k = 'test-ip'
    for (let i = 0; i < 4; i++) auth.recordLoginFailure(k)
    expect(auth.loginBlockedFor(k)).toBe(0)
    auth.recordLoginFailure(k)
    expect(auth.loginBlockedFor(k)).toBeGreaterThan(0)
    auth.recordLoginSuccess(k)
    expect(auth.loginBlockedFor(k)).toBe(0)

    const r = (peer: string) => new Request('http://x/', { headers: { [auth.PEER_HEADER]: peer, 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } })
    expect(auth.clientKey(r('127.0.0.1'))).toBe('1.2.3.4') // last hop = the one our proxy appended
    expect(auth.clientKey(r('192.168.1.50'))).toBe('192.168.1.50')
  })

  it('counts parallel attempts before verification and caps concurrent checks', () => {
    const r = new Request('http://x/', { headers: { [auth.PEER_HEADER]: '10.0.0.9' } })
    const pending = Array.from({ length: 4 }, () => auth.beginAttempt(r))
    expect(() => auth.beginAttempt(r)).toThrow(/gleichzeitige/) // global cap
    pending.forEach((f) => f(false))
    auth.beginAttempt(r)(false) // 5th failure
    expect(() => auth.beginAttempt(r)).toThrow(/warten/)
    const other = new Request('http://x/', { headers: { [auth.PEER_HEADER]: '10.0.0.10' } })
    const done = auth.beginAttempt(other)
    done(true)
    expect(auth.loginBlockedFor('10.0.0.10')).toBe(0)
  })
})
