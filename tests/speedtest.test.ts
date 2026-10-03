import { describe, expect, it } from 'vitest'
import { drain, internetSpeed, testData } from '~/server/speedtest'
import { mbps, pingStats } from '~/shared/speedtest'

describe('speed test', () => {
  it('computes Mbit/s, ping and jitter', () => {
    expect(mbps(12_500_000, 1000)).toBe(100) // 12.5 MB in a second = 100 Mbit/s
    expect(pingStats([10, 12, 11, 30, 9])).toEqual({ ping: 11, jitter: 10.8 })
    expect(pingStats([])).toEqual({ ping: 0, jitter: 0 })
  })

  it('sends and receives test data', async () => {
    const n = await drain(testData(3 * 1024 * 1024 + 7))
    expect(n).toBe(3 * 1024 * 1024 + 7)
    expect(await drain(testData(10 ** 12), 5 * 1024 * 1024)).toBeGreaterThan(5 * 1024 * 1024) // stops at the limit
  })

  it('measures against Cloudflare: ping, download, upload, with progress', async () => {
    const calls: string[] = []
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      await new Promise((r) => setTimeout(r, 2))
      calls.push(`${init?.method ?? 'GET'} ${u.replace('https://speed.cloudflare.com', '')}`)
      if (u.includes('__up')) return new Response('ok')
      const bytes = Number(new URL(u).searchParams.get('bytes'))
      return new Response(new Uint8Array(Math.min(bytes, 256 * 1024)), { headers: { 'cf-meta-colo': 'FRA' } })
    }) as typeof fetch
    const progress: string[] = []
    const r = await internetSpeed({ seconds: 0.3, fetchImpl: fake, onProgress: (p) => progress.push(p.phase) })
    expect(r).toMatchObject({ kind: 'internet', where: 'FRA' })
    expect(r.down).toBeGreaterThan(0)
    expect(r.up).toBeGreaterThan(0)
    expect(calls.filter((c) => c === 'GET /__down?bytes=0')).toHaveLength(8)
    expect(calls.some((c) => c === 'POST /__up')).toBe(true)
    expect(new Set(progress)).toEqual(new Set(['ping', 'down', 'up']))
  })
})
