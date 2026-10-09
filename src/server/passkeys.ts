// Passkeys (WebAuthn) as a second way into the admin login, next to the password.
//
// - A passkey is bound to the host name it was made on (the relying party ID): WebAuthn needs
//   HTTPS (or localhost) and a name, not an IP address, so the login page offers it only there.
// - Login with a passkey needs user verification (fingerprint, face, device PIN) and is throttled
//   like a password login.
// - Adding one asks for the admin password again, so a stolen session cannot plant its own.
// - `quadeck passwd` removes every passkey together with the password.

import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { eq } from 'drizzle-orm'
import { HttpError } from './auth'
import { db, schema } from './db'
import { getSetting, setSetting } from './settings'

const RP_NAME = 'Quadeck'
const USER_ID_KEY = 'auth.passkey_user_id'
const CHALLENGE_TTL_MS = 5 * 60_000
const MAX_CHALLENGES = 1000
export const MAX_NAME_LENGTH = 64

export interface PasskeyInfo {
  id: string
  name: string
  rpId: string
  createdAt: number
  lastUsedAt: number | null
}

// ---------- relying party ----------

const isIpAddress = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')

/**
 * The page's origin and host name, from the Origin header the browser sets on every POST.
 * Throws when WebAuthn cannot work there: plain HTTP other than localhost, or an IP address.
 */
export function relyingParty(request: Request): { origin: string; rpId: string } {
  const header = request.headers.get('origin')
  let url: URL
  try {
    url = new URL(header ?? '')
  } catch {
    throw new HttpError(400, msg(m.api_passkey_unsupportedOrigin))
  }
  const rpId = url.hostname
  const secure = url.protocol === 'https:' || rpId === 'localhost'
  if (!secure || isIpAddress(rpId)) throw new HttpError(400, msg(m.api_passkey_unsupportedOrigin))
  return { origin: url.origin, rpId }
}

/** The one admin as a WebAuthn user: a random handle made once, kept in the settings. */
function userId(): Uint8Array<ArrayBuffer> {
  let id = getSetting<string>(USER_ID_KEY)
  if (!id) {
    id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    setSetting(USER_ID_KEY, id)
  }
  return new Uint8Array(Buffer.from(id, 'base64url')) as Uint8Array<ArrayBuffer>
}

// ---------- challenges ----------
//
// Each options request hands out a fresh challenge that a response may use once, within five
// minutes. A registration challenge is tied to the session that asked for it.

const challenges = new Map<string, { purpose: 'login' | 'register'; sessionId?: string; rpId: string; expiresAt: number }>()

function rememberChallenge(challenge: string, entry: { purpose: 'login' | 'register'; sessionId?: string; rpId: string }) {
  const now = Date.now()
  for (const [k, v] of challenges) if (v.expiresAt < now) challenges.delete(k)
  if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!)
  challenges.set(challenge, { ...entry, expiresAt: now + CHALLENGE_TTL_MS })
}

/** Takes a challenge out of the store if it fits; a challenge never works twice. */
function takeChallenge(challenge: string, purpose: 'login' | 'register', rpId: string, sessionId?: string): boolean {
  const c = challenges.get(challenge)
  if (!c) return false
  challenges.delete(challenge)
  return c.purpose === purpose && c.rpId === rpId && c.sessionId === sessionId && c.expiresAt > Date.now()
}

/** Reads the challenge a response signed, from its clientDataJSON. */
function signedChallenge(clientDataJSON: unknown): string {
  try {
    const data = JSON.parse(Buffer.from(String(clientDataJSON), 'base64url').toString('utf8')) as { challenge?: unknown }
    return typeof data.challenge === 'string' ? data.challenge : ''
  } catch {
    return ''
  }
}

// ---------- stored passkeys ----------

export function listPasskeys(): PasskeyInfo[] {
  return db()
    .select({ id: schema.passkeys.id, name: schema.passkeys.name, rpId: schema.passkeys.rpId, createdAt: schema.passkeys.createdAt, lastUsedAt: schema.passkeys.lastUsedAt })
    .from(schema.passkeys)
    .all()
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function hasPasskeys() {
  return !!db().select({ id: schema.passkeys.id }).from(schema.passkeys).limit(1).get()
}

export function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new HttpError(400, msg(m.api_passkey_nameRequired))
  if (n.length > MAX_NAME_LENGTH) throw new HttpError(400, msg(m.api_passkey_nameTooLong, { max: MAX_NAME_LENGTH }))
  return n
}

function requirePasskey(id: string) {
  if (!db().select({ id: schema.passkeys.id }).from(schema.passkeys).where(eq(schema.passkeys.id, id)).get()) throw new HttpError(404, msg(m.api_passkey_notFound))
}

export function renamePasskey(id: string, name: unknown) {
  const cleaned = cleanName(name)
  requirePasskey(id)
  db().update(schema.passkeys).set({ name: cleaned }).where(eq(schema.passkeys.id, id)).run()
}

export function deletePasskey(id: string) {
  requirePasskey(id)
  db().delete(schema.passkeys).where(eq(schema.passkeys.id, id)).run()
}

export function deleteAllPasskeys() {
  db().delete(schema.passkeys).run()
}

// ---------- registration ----------

export async function registrationOptions(request: Request, sessionId: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpId } = relyingParty(request)
  const existing = db().select({ id: schema.passkeys.id, transports: schema.passkeys.transports }).from(schema.passkeys).where(eq(schema.passkeys.rpId, rpId)).all()
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userID: userId(),
    userName: 'admin',
    userDisplayName: `Quadeck (${rpId})`,
    attestationType: 'none',
    // The same authenticator twice makes no sense: the browser says it already has one
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: (p.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  rememberChallenge(options.challenge, { purpose: 'register', sessionId, rpId })
  return options
}

export async function register(request: Request, sessionId: string, response: RegistrationResponseJSON, name: unknown): Promise<PasskeyInfo> {
  const cleanedName = cleanName(name)
  const { origin, rpId } = relyingParty(request)
  const challenge = signedChallenge(response?.response?.clientDataJSON)
  if (!takeChallenge(challenge, 'register', rpId, sessionId)) throw new HttpError(400, msg(m.api_passkey_expired))
  let verification
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true })
  } catch (e) {
    throw new HttpError(400, msg(m.api_passkey_invalid, { reason: (e as Error).message }))
  }
  if (!verification.verified || !verification.registrationInfo) throw new HttpError(400, msg(m.api_passkey_invalid, { reason: '' }))
  const { credential } = verification.registrationInfo
  const row = {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports ?? null,
    rpId,
    name: cleanedName,
    createdAt: Date.now(),
    lastUsedAt: null,
  }
  db().insert(schema.passkeys).values(row).onConflictDoNothing().run()
  return { id: row.id, name: row.name, rpId, createdAt: row.createdAt, lastUsedAt: null }
}

// ---------- login ----------

export async function loginOptions(request: Request): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpId } = relyingParty(request)
  // No allowCredentials: the browser offers the passkeys it holds for this host
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' })
  rememberChallenge(options.challenge, { purpose: 'login', rpId })
  return options
}

/** Checks a login response; true when it is a valid assertion of a stored passkey. */
export async function verifyLogin(request: Request, response: AuthenticationResponseJSON): Promise<boolean> {
  const { origin, rpId } = relyingParty(request)
  const challenge = signedChallenge(response?.response?.clientDataJSON)
  if (!takeChallenge(challenge, 'login', rpId)) throw new HttpError(400, msg(m.api_passkey_expired))
  const id = typeof response?.id === 'string' ? response.id : ''
  const passkey = id ? db().select().from(schema.passkeys).where(eq(schema.passkeys.id, id)).get() : undefined
  if (!passkey || passkey.rpId !== rpId) return false
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: Uint8Array.from(Buffer.from(passkey.publicKey, 'base64url')),
        counter: passkey.counter,
        transports: (passkey.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
    })
  } catch {
    return false
  }
  if (!verification.verified) return false
  db().update(schema.passkeys).set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: Date.now() }).where(eq(schema.passkeys.id, passkey.id)).run()
  return true
}
