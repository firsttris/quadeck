// HTTP health checks: HEAD on each service URL, every 60 s. Used when the
// container has no Podman healthcheck, and for manual links.

import type { HttpHealth } from './registry'

const SLOW_MS = 2000

export async function checkUrl(url: string): Promise<HttpHealth> {
  const started = performance.now()
  const opts = { redirect: 'manual', signal: AbortSignal.timeout(8000), tls: { rejectUnauthorized: false } } as RequestInit
  try {
    let res = await fetch(url, { ...opts, method: 'HEAD' })
    await res.body?.cancel()
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { ...opts, method: 'GET' })
      await res.body?.cancel() // only the status matters; never read streams (cameras, SSE)
    }
    const ms = Math.round(performance.now() - started)
    if (res.status >= 500) return { health: 'bad', note: `HTTP ${res.status}` }
    if (ms > SLOW_MS) return { health: 'warn', note: `langsam (${ms} ms)` }
    return { health: 'ok', note: `HTTP ${res.status} · ${ms} ms` }
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'Zeitüberschreitung' : (e as Error).message
    return { health: 'bad', note: `nicht erreichbar: ${msg}` }
  }
}

export class HealthChecker {
  readonly results = new Map<string, HttpHealth>()
  private running = false

  async checkAll(urls: string[]) {
    if (this.running) return
    this.running = true
    try {
      const unique = [...new Set(urls)]
      for (const u of this.results.keys()) if (!unique.includes(u)) this.results.delete(u)
      // Small concurrency limit; LAN targets answer fast.
      const queue = [...unique]
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let u = queue.shift(); u; u = queue.shift()) this.results.set(u, await checkUrl(u))
        }),
      )
    } finally {
      this.running = false
    }
  }
}
