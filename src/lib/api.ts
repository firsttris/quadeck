// Client-side calls to our /api routes. Every write carries the session's
// CSRF token (set once by the app layout from the auth state).

let csrfToken = ''

export function setCsrfToken(t: string) {
  csrfToken = t
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T = { ok: true }>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`)
  return data as T
}

/** For requests that do not go through api() (raw bodies). */
export const csrfHeaders = (): Record<string, string> => ({ 'x-csrf-token': csrfToken })
