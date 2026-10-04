// Podman secrets through the libpod API (root helper). Values go in the request body only –
// never in argv, never logged, never read back (the API is never asked to show them).

import { msg } from '~/shared/i18n'
import { MAX_SECRET_BYTES, SECRET_NAME, findPlain, secretRefs, type SecretsState } from '~/shared/secrets'
import { HttpError } from '../auth'
import type { PodmanApi } from './storage'

interface SecretInfo {
  ID: string
  Spec?: { Name?: string }
  CreatedAt?: string
  UpdatedAt?: string
}

const time = (s?: string) => {
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t : undefined
}

async function fail(res: Response): Promise<never> {
  let text = await res.text()
  try {
    text = (JSON.parse(text) as { message?: string }).message ?? text
  } catch {
    // plain text
  }
  throw new HttpError(res.status === 409 ? 409 : res.status === 404 ? 404 : 502, text.trim().slice(0, 300) || `Podman: HTTP ${res.status}`)
}

export async function secretsState(api: PodmanApi, quadlets: { name: string; content: string }[]): Promise<SecretsState> {
  const res = await api('/v4.0.0/libpod/secrets/json')
  if (!res.ok) await fail(res)
  const list = (await res.json()) as SecretInfo[]
  const containers = quadlets.filter((q) => q.name.endsWith('.container'))
  const secrets = list
    .map((s) => {
      const name = s.Spec?.Name ?? s.ID
      const created = time(s.CreatedAt)
      const updated = time(s.UpdatedAt)
      return { id: s.ID, name, ...(created ? { created } : {}), ...(updated && updated !== created ? { updated } : {}), usedBy: containers.filter((q) => secretRefs(q.content).includes(name)).map((q) => q.name) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const taken = new Set(secrets.map((s) => s.name))
  return { secrets, plain: containers.flatMap((q) => findPlain(q.name, q.content, taken)) }
}

export function checkSecret(name: string, value: string) {
  if (!SECRET_NAME.test(name)) throw new HttpError(400, msg('secrets_error_name'))
  if (typeof value !== 'string' || !value.length) throw new HttpError(400, msg('secrets_error_empty'))
  if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES) throw new HttpError(413, msg('secrets_error_tooLarge'))
}

/** Creates a secret; replace swaps the value of an existing one (Podman 4.7+). */
export async function createSecret(api: PodmanApi, name: string, value: string, replace = false) {
  checkSecret(name, value)
  const q = new URLSearchParams({ name, driver: 'file', ...(replace ? { replace: 'true' } : {}) })
  const res = await api(`/v4.0.0/libpod/secrets/create?${q}`, { method: 'POST', body: value, headers: { 'content-type': 'application/octet-stream' } })
  if (res.status === 409) throw new HttpError(409, msg('secrets_error_exists', { name }))
  if (!res.ok) await fail(res)
}

export async function removeSecret(api: PodmanApi, name: string) {
  if (!SECRET_NAME.test(name)) throw new HttpError(400, msg('secrets_error_name'))
  const res = await api(`/v4.0.0/libpod/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (res.status === 404) throw new HttpError(404, msg('secrets_error_unknown', { name }))
  if (!res.ok) await fail(res)
}
