// Passkeys in the browser: WebAuthn needs a secure context and a host name, not an IP address
// (src/server/passkeys.ts checks the same on the server).
import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { api } from './api'
import { m } from '~/paraglide/messages'

export function passkeysSupported(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext || !window.PublicKeyCredential) return false
  const host = window.location.hostname
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':') && !host.startsWith('[')
}

/** True when the user closed the browser's passkey dialog or it timed out. */
export function isCancelled(e: unknown): boolean {
  const err = e instanceof WebAuthnError ? (e.cause as Error | undefined) ?? e : (e as Error | undefined)
  return err?.name === 'NotAllowedError' || err?.name === 'AbortError'
}

export function passkeyErrorMessage(e: unknown): string {
  return isCancelled(e) ? m.passkeys_cancelled() : (e as Error).message
}

export async function loginWithPasskey() {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkey/options')
  const response = await startAuthentication({ optionsJSON })
  await api('/api/auth/passkey/login', { body: { response } })
}

export async function createPasskey(name: string, password: string) {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkeys/options', { body: { password } })
  const response = await startRegistration({ optionsJSON })
  await api('/api/auth/passkeys', { body: { response, name } })
}
