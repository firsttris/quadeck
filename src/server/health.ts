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

export interface HealthTarget {
  url: string
  probe?: string
}

/**
 * Checks the public URL first. If that fails from the server itself (typical:
 * *.home names that only the LAN's DNS resolves, or hairpin NAT), the
 * upstream from the Caddy route is checked directly instead.
 */
export async function checkTarget(t: HealthTarget, check = checkUrl): Promise<HttpHealth> {
  const direct = await check(t.url)
  if (direct.health !== 'bad' || !t.probe) return direct
  const viaUpstream = await check(t.probe)
  if (viaUpstream.health === 'bad') return { health: 'bad', note: `${direct.note}; Upstream ${t.probe}: ${viaUpstream.note?.replace(/^nicht erreichbar: /, '')}` }
  return { health: viaUpstream.health, note: `Upstream ${t.probe} · ${viaUpstream.note} (URL vom Server aus nicht erreichbar)` }
}

export class HealthChecker {
  readonly results = new Map<string, HttpHealth>()
  private running = false

  async checkAll(targets: HealthTarget[]) {
    if (this.running) return
    this.running = true
    try {
      const unique = [...new Map(targets.map((t) => [t.url, t])).values()]
      const urls = new Set(unique.map((t) => t.url))
      for (const u of this.results.keys()) if (!urls.has(u)) this.results.delete(u)
      // Small concurrency limit; LAN targets answer fast.
      const queue = [...unique]
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let t = queue.shift(); t; t = queue.shift()) this.results.set(t.url, await checkTarget(t))
        }),
      )
    } finally {
      this.running = false
    }
  }
}
