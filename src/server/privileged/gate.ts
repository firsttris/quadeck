// The unlock gate: privileged actions need a short-lived unlock token,
// obtained with an admin account's password (root or wheel/sudo member).
// It lives where the root actions run — in the helper when there is one —
// so a compromised web app cannot act without the password.

import { msg } from '~/shared/i18n'
import { HttpError } from '../auth'
import { readAuthFiles, suggestedUser, verifySystemPassword, type SystemAuthFiles } from './crypt'

/** system: Linux password (default) · quadeck: Quadeck password (single-process only) · none: no unlock needed */
export type UnlockMode = 'system' | 'quadeck' | 'none'

export interface UnlockInfo {
  mode: UnlockMode
  suggestedUser: string
  minutes: number
}

export class LockedError extends HttpError {
  constructor() {
    super(423, msg('helper_error_locked'))
  }
}

const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

export class Gate {
  /** token → expiry and the account that unlocked (the terminal runs as that user). */
  private tokens = new Map<string, { exp: number; user: string }>()
  private lockListeners: ((token: string) => void)[] = []
  private failures = 0
  private blockedUntil = 0

  constructor(
    readonly mode: UnlockMode,
    readonly minutes: number,
    private opts: { authFiles?: () => SystemAuthFiles; verifyQuadeck?: (pw: string) => Promise<boolean> } = {},
  ) {}

  info(): UnlockInfo {
    let user = 'root'
    if (this.mode === 'system') {
      try {
        user = suggestedUser((this.opts.authFiles ?? readAuthFiles)())
      } catch {
        user = 'root'
      }
    }
    return { mode: this.mode, suggestedUser: user, minutes: this.minutes }
  }

  async unlock(user: string, password: string): Promise<{ token: string; expiresAt: number }> {
    if (this.mode === 'none') return { token: 'none', expiresAt: Number.MAX_SAFE_INTEGER }
    const now = Date.now()
    if (this.blockedUntil > now) throw new HttpError(429, msg('helper_error_tooManyAttempts', { seconds: Math.ceil((this.blockedUntil - now) / 1000) }))
    // Count before verifying, so parallel attempts cannot all slip through.
    this.failures++
    if (this.failures >= 5) this.blockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** (this.failures - 5))
    let ok = false
    if (this.mode === 'quadeck') {
      ok = !!(await this.opts.verifyQuadeck?.(password))
    } else {
      const r = verifySystemPassword((this.opts.authFiles ?? readAuthFiles)(), user.trim(), password)
      if (r === 'not-admin') throw new HttpError(403, msg('helper_error_notAdmin', { user }))
      if (r === 'no-password') throw new HttpError(403, msg('helper_error_noPassword', { user }))
      if (r === 'unsupported') throw new HttpError(501, msg('helper_error_cryptUnavailable'))
      ok = r === 'ok'
    }
    if (!ok) throw new HttpError(401, msg('api_auth_wrongPassword'))
    this.failures = 0
    this.blockedUntil = 0
    const token = randomToken()
    const expiresAt = now + this.minutes * 60_000
    this.tokens.set(token, { exp: expiresAt, user: this.mode === 'system' ? user.trim() : this.info().suggestedUser })
    for (const [t, v] of this.tokens) if (v.exp < now) this.tokens.delete(t)
    return { token, expiresAt }
  }

  lock(token: string | undefined) {
    if (!token) return
    this.tokens.delete(token)
    for (const f of this.lockListeners) f(token)
  }

  /** Called with the token when someone locks (ends that unlock's terminal sessions). */
  onLock(f: (token: string) => void) {
    this.lockListeners.push(f)
  }

  /** The account behind a valid token (in other modes: the suggested admin account). */
  userOf(token: string | undefined): string | undefined {
    if (this.mode === 'none') return this.info().suggestedUser
    if (this.unlockedUntil(token) === null) return undefined
    return this.tokens.get(token!)?.user
  }

  /** Expiry of a valid token, else null. */
  unlockedUntil(token: string | undefined): number | null {
    if (this.mode === 'none') return Number.MAX_SAFE_INTEGER
    if (!token) return null
    const v = this.tokens.get(token)
    if (!v || v.exp < Date.now()) {
      this.tokens.delete(token)
      return null
    }
    return v.exp
  }

  check(token: string | undefined) {
    if (this.unlockedUntil(token) === null) throw new LockedError()
  }
}
