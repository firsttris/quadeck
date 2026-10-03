// Login, sessions and CSRF protection.
//
// - One admin password (argon2id via Bun.password), set on first start with a
//   one-time setup token that only root can read (`quadeck setup-token`).
// - Session cookie: random token, only its SHA-256 is stored. HttpOnly,
//   SameSite=Strict, Secure behind HTTPS.
// - CSRF: every unsafe request must be same-origin, and every authenticated
//   write must echo the session's CSRF token in X-CSRF-Token.

import { msg } from '~/shared/i18n'
import { and, eq, gt, lt } from 'drizzle-orm'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'
import { db, schema } from './db'
import { deleteSetting, getSetting, setSetting } from './settings'

export const SESSION_COOKIE = 'qd_session'
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const PASSWORD_KEY = 'auth.password_hash'

export interface Session {
  id: string
  csrf: string
  expiresAt: number
}

const randomToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')
const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')

export function timingSafeEqualStr(a: string, b: string) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!
  return diff === 0
}

// ---------- password / setup ----------

export function hasPassword() {
  return !!getSetting<string>(PASSWORD_KEY)
}

export const MIN_PASSWORD_LENGTH = 10

export async function setPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(msg('auth_passwordMustHaveAtLeast', { MIN_PASSWORD_LENGTH }))
  setSetting(PASSWORD_KEY, await Bun.password.hash(password, { algorithm: 'argon2id' }))
  // A new password ends all existing sessions.
  db().delete(schema.sessions).run()
  clearSetupToken()
}

export function resetPassword() {
  deleteSetting(PASSWORD_KEY)
  db().delete(schema.sessions).run()
}

export async function verifyPassword(password: string) {
  const hash = getSetting<string>(PASSWORD_KEY)
  if (!hash) return false
  return Bun.password.verify(password, hash)
}

const setupTokenPath = () => join(config().dataDir, 'setup-token')

/** Returns the current setup token, creating one if no password is set yet. */
export function ensureSetupToken(): string | undefined {
  if (hasPassword()) return undefined
  const p = setupTokenPath()
  if (existsSync(p)) {
    const t = readFileSync(p, 'utf8').trim()
    if (t) return t
  }
  mkdirSync(config().dataDir, { recursive: true, mode: 0o700 })
  const t = randomToken(18)
  try {
    // 'wx': if the service and the CLI race, exactly one token wins.
    writeFileSync(p, t + '\n', { mode: 0o600, flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(p, 'utf8').trim() || undefined
    throw e
  }
  chmodSync(p, 0o600)
  return t
}

export function checkSetupToken(token: string) {
  const t = ensureSetupToken()
  return !!t && timingSafeEqualStr(t, token.trim())
}

function clearSetupToken() {
  rmSync(setupTokenPath(), { force: true })
}

// ---------- sessions ----------

export function createSession(): { token: string; session: Session } {
  const token = randomToken()
  const session = { id: sha256(token), csrf: randomToken(), expiresAt: Date.now() + SESSION_TTL_MS }
  db()
    .insert(schema.sessions)
    .values({ ...session, createdAt: Date.now() })
    .run()
  db().delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now())).run()
  return { token, session }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function getSession(request: Request): Session | undefined {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]
  if (!token) return undefined
  const row = db()
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, Date.now())))
    .get()
  return row ? { id: row.id, csrf: row.csrf, expiresAt: row.expiresAt } : undefined
}

export function destroySession(request: Request) {
  const s = getSession(request)
  if (s) db().delete(schema.sessions).where(eq(schema.sessions.id, s.id)).run()
}

export function isHttps(request: Request) {
  return new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
}

export function sessionCookie(request: Request, token: string, maxAgeSec = SESSION_TTL_MS / 1000) {
  return [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeSec)}`, ...(isHttps(request) ? ['Secure'] : [])].join('; ')
}

export function clearedSessionCookie(request: Request) {
  return sessionCookie(request, '', 0)
}

// ---------- CSRF ----------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Same-origin check for unsafe methods. Browsers always send Origin on
 * cross-site POSTs; Sec-Fetch-Site is a second signal. Non-browser clients
 * without either header are allowed (they cannot carry a victim's cookie).
 */
export function isSameOrigin(request: Request): boolean {
  if (SAFE_METHODS.has(request.method)) return true
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  const allowed = [request.headers.get('x-forwarded-host'), request.headers.get('host'), config().publicHost].filter(Boolean)
  try {
    return allowed.includes(new URL(origin).host)
  } catch {
    return false
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Throws HttpError unless the request carries a valid session (and CSRF token for writes). */
export function requireSession(request: Request): Session {
  const session = getSession(request)
  if (!session) throw new HttpError(401, msg('auth_notLogged'))
  if (!SAFE_METHODS.has(request.method)) {
    if (!isSameOrigin(request)) throw new HttpError(403, msg('auth_foreignOrigin'))
    const sent = request.headers.get('x-csrf-token') ?? ''
    if (!timingSafeEqualStr(sent, session.csrf)) throw new HttpError(403, msg('auth_csrfTokenMissingInvalid'))
  }
  return session
}

// ---------- login throttling ----------
//
// An attempt is counted as a failure *before* the password is verified, so
// parallel requests cannot all slip past the check; a success clears it.
// argon2 verifications are additionally capped globally (CPU/memory).

const failures = new Map<string, { count: number; until: number; at: number }>()
const MAX_TRACKED = 10_000
const MAX_VERIFYING = 4
let verifying = 0

/** Header set by our own Bun server (src/main.ts) from the socket peer; client copies are stripped. */
export const PEER_HEADER = 'x-quadeck-peer'

const trustedProxies = () => (config().trustedProxies.length ? config().trustedProxies : ['127.', '::1', '::ffff:127.'])

export function clientKey(request: Request) {
  const peer = request.headers.get(PEER_HEADER) ?? 'unknown'
  // X-Forwarded-For only from a trusted reverse proxy, and only its own (last) hop.
  if (trustedProxies().some((p) => peer.startsWith(p))) {
    const hops = (request.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
    return hops[hops.length - 1] || peer
  }
  return peer
}

export function loginBlockedFor(key: string): number {
  const f = failures.get(key)
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0
}

export function recordLoginFailure(key: string) {
  if (failures.size >= MAX_TRACKED && !failures.has(key)) {
    const now = Date.now()
    for (const [k, v] of failures) if (v.until < now && now - v.at > 3600_000) failures.delete(k)
    if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value!)
  }
  const f = failures.get(key) ?? { count: 0, until: 0, at: 0 }
  f.count++
  f.at = Date.now()
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (f.count - 5))
  failures.set(key, f)
}

export function recordLoginSuccess(key: string) {
  failures.delete(key)
}

/**
 * Starts a password/token check for this client. Throws HttpError 429 when
 * the client is blocked or too many checks are running; otherwise returns a
 * function to call with the outcome.
 */
export function beginAttempt(request: Request): (success: boolean) => void {
  const key = clientKey(request)
  const wait = loginBlockedFor(key)
  if (wait) throw new HttpError(429, msg('auth_tooManyFailedAttemptsPlease', { wait }))
  if (verifying >= MAX_VERIFYING) throw new HttpError(429, msg('auth_tooManySimultaneousLoginAttempts'))
  verifying++
  const before = failures.get(key)
  const snapshot = before ? { ...before } : undefined
  recordLoginFailure(key)
  let done = false
  return (success) => {
    if (done) return
    done = true
    verifying--
    if (success) {
      if (snapshot) failures.set(key, snapshot)
      recordLoginSuccess(key)
    }
  }
}
