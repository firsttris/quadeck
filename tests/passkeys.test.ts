import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'quadeck-test-'))
process.env.QUADECK_DATA_DIR = dir

const auth = await import('~/server/auth')
const passkeys = await import('~/server/passkeys')
const { db, schema } = await import('~/server/db')

const post = (origin?: string) => new Request('https://nas.example.org/api/auth/passkey/options', { method: 'POST', headers: origin ? { origin } : {} })

/** A client response that signed `challenge`; enough to reach the challenge check. */
const signed = (challenge: string, id = 'cred-1') =>
  ({ id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://nas.example.org' })).toString('base64url') } }) as never

const store = (id: string, rpId = 'nas.example.org') =>
  db()
    .insert(schema.passkeys)
    .values({ id, publicKey: 'AA', counter: 0, transports: ['internal'], rpId, name: id, createdAt: Date.now() })
    .run()

describe('relying party', () => {
  it('takes the host name from the Origin the browser sent', () => {
    expect(passkeys.relyingParty(post('https://nas.example.org'))).toEqual({ origin: 'https://nas.example.org', rpId: 'nas.example.org' })
    expect(passkeys.relyingParty(post('https://nas.example.org:8443'))).toEqual({ origin: 'https://nas.example.org:8443', rpId: 'nas.example.org' })
    expect(passkeys.relyingParty(post('http://localhost:8686'))).toEqual({ origin: 'http://localhost:8686', rpId: 'localhost' })
  })
  it('refuses plain HTTP, IP addresses and requests without Origin', () => {
    for (const origin of ['http://nas.example.org', 'https://192.168.1.2', 'https://[::1]', 'null', undefined]) {
      expect(() => passkeys.relyingParty(post(origin))).toThrow(auth.HttpError)
    }
  })
})

describe('challenges', () => {
  it('accepts a login challenge once, and only for an unknown passkey as a failed login', async () => {
    const options = await passkeys.loginOptions(post('https://nas.example.org'))
    expect(options.rpId).toBe('nas.example.org')
    expect(options.userVerification).toBe('required')
    // Unknown credential: no login, but the challenge is used up
    await expect(passkeys.verifyLogin(post('https://nas.example.org'), signed(options.challenge, 'nobody'))).resolves.toBe(false)
    await expect(passkeys.verifyLogin(post('https://nas.example.org'), signed(options.challenge, 'nobody'))).rejects.toThrow(auth.HttpError)
  })
  it('refuses a challenge handed out for another host or made up', async () => {
    const options = await passkeys.loginOptions(post('https://other.example.org'))
    await expect(passkeys.verifyLogin(post('https://nas.example.org'), signed(options.challenge))).rejects.toThrow(auth.HttpError)
    await expect(passkeys.verifyLogin(post('https://nas.example.org'), signed('made-up'))).rejects.toThrow(auth.HttpError)
  })
  it('ties a registration challenge to the session that asked for it', async () => {
    const options = await passkeys.registrationOptions(post('https://nas.example.org'), 'session-a')
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
    await expect(passkeys.register(post('https://nas.example.org'), 'session-b', signed(options.challenge), 'Laptop')).rejects.toThrow(auth.HttpError)
  })
  it('keeps the same user handle and excludes passkeys this host already has', async () => {
    store('known')
    const a = await passkeys.registrationOptions(post('https://nas.example.org'), 's')
    const b = await passkeys.registrationOptions(post('https://nas.example.org'), 's')
    expect(a.user.id).toBe(b.user.id)
    expect(a.excludeCredentials?.map((c) => c.id)).toEqual(['known'])
    const other = await passkeys.registrationOptions(post('https://other.example.org'), 's')
    expect(other.excludeCredentials).toEqual([])
  })
})

describe('stored passkeys', () => {
  it('renames and deletes, with a clear error for unknown ones and bad names', () => {
    store('phone')
    passkeys.renamePasskey('phone', '  Handy  ')
    expect(passkeys.listPasskeys().find((p) => p.id === 'phone')?.name).toBe('Handy')
    expect(() => passkeys.renamePasskey('phone', ' ')).toThrow(auth.HttpError)
    expect(() => passkeys.renamePasskey('phone', 'x'.repeat(passkeys.MAX_NAME_LENGTH + 1))).toThrow(auth.HttpError)
    expect(() => passkeys.renamePasskey('missing', 'x')).toThrow(auth.HttpError)
    passkeys.deletePasskey('phone')
    expect(() => passkeys.deletePasskey('phone')).toThrow(auth.HttpError)
  })
  it('are all removed by quadeck passwd', () => {
    store('laptop')
    expect(passkeys.hasPasskeys()).toBe(true)
    auth.resetPassword()
    expect(passkeys.hasPasskeys()).toBe(false)
  })
})
