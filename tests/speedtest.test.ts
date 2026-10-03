import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentAlerts, defaultSettings, parseSettings } from '~/shared/notify'
import { judgeSpeed, lastSlot, mbps, pingStats, usualDown, type SpeedResult } from '~/shared/speedtest'
import type { Snapshot } from '~/shared/types'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-speed-'))
const { drain, internetSpeed, testData, runInternetTest, speedCheck, speedSeries, speedTick, setSpeedSchedule, nextSpeedRun } = await import('~/server/speedtest')

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

describe('automatic speed test', () => {
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime()

  it('finds the last planned run: daily or every 6 hours, also across midnight', () => {
    expect(lastSlot({ enabled: true, every: 'daily', hour: 4 }, at(2026, 9, 3, 10), 17)).toBe(at(2026, 9, 3, 4, 17))
    expect(lastSlot({ enabled: true, every: 'daily', hour: 4 }, at(2026, 9, 3, 3), 17)).toBe(at(2026, 9, 2, 4, 17))
    expect(lastSlot({ enabled: true, every: '6h', hour: 4 }, at(2026, 9, 3, 23), 0)).toBe(at(2026, 9, 3, 22))
    expect(lastSlot({ enabled: true, every: '6h', hour: 4 }, at(2026, 9, 3, 1), 0)).toBe(at(2026, 9, 2, 22))
  })

  it('judges against the usual speed or a fixed value', () => {
    const now = Date.now()
    const h = (down: number, ago: number): SpeedResult => ({ at: now - ago * 3600_000, kind: 'internet', down, up: 40, ping: 9, jitter: 1 })
    const history = [h(500, 2), h(480, 26), h(520, 50), h(10, 300), { ...h(900, 1), kind: 'client' as const }]
    expect(usualDown(history, now)).toBe(500) // the last 7 days, internet only
    expect(usualDown(history.slice(0, 2), now)).toBeUndefined() // too few
    const rel = { speedMode: 'relative' as const, speedPercent: 50, speedMbit: 100 }
    expect(judgeSpeed(240, 500, rel)).toEqual({ slow: true, expected: 250 })
    expect(judgeSpeed(260, 500, rel)).toEqual({ slow: false, expected: 250 })
    expect(judgeSpeed(5, undefined, rel)).toEqual({ slow: false }) // nothing to compare with yet
    expect(judgeSpeed(90, undefined, { ...rel, speedMode: 'fixed' })).toEqual({ slow: true, expected: 100 })
  })

  it('the notification rule is off until switched on, and reports a confirmed problem', () => {
    expect(defaultSettings().rules.internet).toBe(false)
    expect(parseSettings({ rules: {} }, defaultSettings()).rules.internet).toBe(false)
    const s = parseSettings({ rules: { internet: true }, speedMode: 'fixed', speedMbit: 250 }, defaultSettings())
    expect(s).toMatchObject({ speedMode: 'fixed', speedMbit: 250, speedPercent: 50 })
    const snap = {
      units: [],
      services: [],
      containers: [],
      smart: [],
      disks: [],
      sources: { systemd: { ok: true }, podman: { ok: true }, smart: { ok: true }, disks: { ok: true } },
      speed: { at: 1, alert: 'slow', down: 90, expected: 250 },
    } as unknown as Snapshot
    expect(currentAlerts(snap, s).alerts).toEqual([expect.objectContaining({ key: 'internet', rule: 'internet', title: expect.stringMatching(/90 Mbit\/s statt mindestens 250/) })])
    expect(currentAlerts(snap, defaultSettings()).alerts).toEqual([])
  })

  it('runs on schedule, records the graph, and reports only after a second bad result', async () => {
    const rule = { enabled: true, speedMode: 'fixed' as const, speedPercent: 50, speedMbit: 1000 } // the demo measures ~480: too slow
    expect(await speedTick({ demo: true, rule })).toBe(false) // switched off
    setSpeedSchedule({ enabled: true, every: 'daily', hour: new Date().getHours() })
    expect(nextSpeedRun()).toBeGreaterThan(Date.now())
    const now = Date.now() + 3600_000 // after this hour's slot
    expect(await speedTick({ demo: true, rule }, now)).toBe(true)
    expect(speedCheck()).toMatchObject({ recheckAt: expect.any(Number) })
    expect(speedCheck()!.alert).toBeUndefined()
    expect(await speedTick({ demo: true, rule }, Date.now())).toBe(false) // the second run waits 15 minutes
    expect(await speedTick({ demo: true, rule }, speedCheck()!.recheckAt! + 1)).toBe(true)
    expect(speedCheck()).toMatchObject({ alert: 'slow', expected: 1000 })
    expect(speedSeries().down).toHaveLength(2)
    // a good result clears it
    await runInternetTest({ demo: true, rule: { ...rule, speedMbit: 10 } })
    expect(speedCheck()!.alert).toBeUndefined()
  }, 30_000)
})
