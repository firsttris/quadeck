import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { smoothPath } from '~/components/HistoryChart'
import { parseLspciName, parseNvidiaSmi, readDrmCard } from '~/server/collectors/gpu'
import { and, gte, inArray } from 'drizzle-orm'
import { metricPrefix, openDb, schema } from '~/server/db'
import { metricRows, parseRange, pruneHistory, queryHistory } from '~/server/metrics'
import type { SystemMetrics } from '~/shared/types'
import { GpuCollector, NVIDIA_EVERY_MS } from '~/server/collectors/gpu'

const sample: SystemMetrics = {
  ts: 1_000_000,
  cpu: 0.25,
  load: [0, 0, 0],
  memTotal: 1000,
  memUsed: 400,
  temp: { celsius: 51, sensor: 'k10temp' },
  net: { rx: 10, tx: 20, iface: 'eth0' },
  gpus: [{ id: 'card0', name: 'Intel Arc', vendor: 'intel', util: 0.5, utilKind: 'clock', memUsed: 1, memTotal: 4 }],
}

describe('metric history', () => {
  it('turns a sample into rows (skipping missing values)', () => {
    expect(metricRows(sample).map((r) => [r.metric, r.value])).toEqual([
      ['cpu', 0.25],
      ['ram', 0.4],
      ['net_rx', 10],
      ['net_tx', 20],
      ['temp', 51],
      ['gpu_util', 0.5],
      ['gpu_mem', 0.25],
    ])
    expect(metricRows({ ...sample, temp: undefined, gpus: undefined }).map((r) => r.metric)).toEqual(['cpu', 'ram', 'net_rx', 'net_tx'])
  })

  it('averages into buckets per range and prunes after 7 days', () => {
    const { db } = openDb(':memory:')
    const now = 10 * 24 * 3600_000
    const rows = []
    for (let t = now - 3600_000; t < now; t += 30_000) rows.push({ ts: t, metric: 'cpu', value: t < now - 1800_000 ? 0.2 : 0.6 })
    rows.push({ ts: now - 8 * 24 * 3600_000, metric: 'cpu', value: 1 }, { ts: now - 60_000, metric: 'bogus', value: 1 })
    db.insert(schema.metricSamples).values(rows).run()

    const h1 = queryHistory(db, '1h', now)
    expect(h1.cpu!.length).toBe(120)
    expect(Object.keys(h1)).toEqual(['cpu'])
    const d7 = queryHistory(db, '7d', now)
    // 7 days / 300 buckets ≈ 2016 s per bucket → the hour fits into two or three buckets.
    expect(d7.cpu!.length).toBeLessThanOrEqual(4)
    const avg = d7.cpu!.reduce((a, [, v]) => a + v, 0) / d7.cpu!.length
    expect(avg).toBeGreaterThan(0.2)
    expect(avg).toBeLessThan(0.6)

    pruneHistory(db, now)
    expect(db.select().from(schema.metricSamples).all().some((r) => r.value === 1 && r.metric === 'cpu')).toBe(false)
    expect(parseRange('24h')).toBe('24h')
    expect(parseRange('1y')).toBe('1h')
  })
})

describe('nvidia-smi is not polled every tick', () => {
  it('reuses its values for NVIDIA_EVERY_MS', async () => {
    let calls = 0
    let t = 0
    const smi = async () => (calls++, { code: 0, stdout: '0, NVIDIA GeForce RTX 3060, 12, 512, 12288, 40, 15.2, 210\n', stderr: '' })
    const c = new GpuCollector('/nonexistent', true, smi, () => t)
    expect((await c.collect())[0]).toMatchObject({ vendor: 'nvidia' })
    t = 5_000
    await c.collect()
    t = 10_000
    await c.collect()
    expect(calls).toBe(1)
    t = NVIDIA_EVERY_MS
    await c.collect()
    expect(calls).toBe(2)
  })
})

describe('gpu', () => {
  it('parses nvidia-smi csv', () => {
    expect(parseNvidiaSmi('0, NVIDIA GeForce RTX 3060, 37, 1024, 12288, 61, 45.30, 1800\n1, Tesla, [N/A], 0, 0, 30, [N/A], 0\n')).toEqual([
      { id: 'nvidia0', name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', util: 0.37, utilKind: 'load', memUsed: 1024 * 1048576, memTotal: 12288 * 1048576, tempC: 61, powerW: 45.3, freqMhz: 1800 },
      { id: 'nvidia1', name: 'Tesla', vendor: 'nvidia', util: undefined, utilKind: 'load', memUsed: 0, memTotal: 0, tempC: 30, powerW: undefined, freqMhz: 0 },
    ])
  })

  it('reads amdgpu and i915 from sysfs', () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-drm-'))
    const mk = (card: string, driver: string, files: Record<string, string>) => {
      const dev = join(root, `pci-${card}`)
      mkdirSync(join(dev, 'hwmon', 'hwmon3'), { recursive: true })
      mkdirSync(join(root, card))
      symlinkSync(dev, join(root, card, 'device'))
      mkdirSync(join(root, 'drivers', driver), { recursive: true })
      symlinkSync(join(root, 'drivers', driver), join(dev, 'driver'))
      for (const [f, v] of Object.entries(files)) writeFileSync(f.startsWith('/') ? join(root, card, f) : join(dev, f), v)
    }
    mk('card0', 'amdgpu', { gpu_busy_percent: '42\n', mem_info_vram_used: '1073741824', mem_info_vram_total: '8589934592', 'hwmon/hwmon3/temp1_input': '55000', 'hwmon/hwmon3/power1_average': '120000000' })
    mk('card1', 'i915', { '/gt_act_freq_mhz': '900', '/gt_RP0_freq_mhz': '1800' })
    mk('card2', 'nouveau', {})
    expect(readDrmCard(root, 'card0', 'AMD Radeon RX 6800')).toEqual({ id: 'card0', name: 'AMD Radeon RX 6800', vendor: 'amd', util: 0.42, utilKind: 'load', memUsed: 1073741824, memTotal: 8589934592, tempC: 55, powerW: 120 })
    expect(readDrmCard(root, 'card1', undefined)).toMatchObject({ vendor: 'intel', name: 'Intel GPU', util: 0.5, utilKind: 'clock', freqMhz: 900 })
    expect(readDrmCard(root, 'card2', undefined)).toBeUndefined()
  })

  it('names GPUs from lspci -mm', () => {
    expect(parseLspciName('03:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]" -rc1 "XFX" "Device 6801"')).toBe('AMD Radeon RX 6800/6800 XT / 6900 XT')
    expect(parseLspciName('00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-N [UHD Graphics]" "Intel" "Device 7270"')).toBe('Intel UHD Graphics')
    expect(parseLspciName('garbage')).toBeUndefined()
  })
})

describe('chart', () => {
  it('draws a smooth path that does not overshoot flat or monotone data', () => {
    const d = smoothPath([
      [0, 10],
      [10, 10],
      [20, 0],
      [30, 0],
    ])
    const ys = [...d.matchAll(/[ ,C](-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]))
    expect(Math.max(...ys)).toBeLessThanOrEqual(10)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(smoothPath([[1, 2]])).toBe('M1.0,2.0')
    expect(smoothPath([])).toBe('')
  })
})

describe('history queries use the (metric, ts) index', () => {
  const plan = (q: { sql: string; params: unknown[] }) => {
    const { sqlite } = openDb(':memory:')
    return (sqlite.query(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])) as { detail: string }[]).map((r) => r.detail).join(' | ')
  }
  it('for a name prefix (LIKE never could) and for the system metrics', () => {
    const { db } = openDb(':memory:')
    const t = schema.metricSamples
    expect(plan(db.select().from(t).where(and(metricPrefix('ct:'), gte(t.ts, 0))).toSQL())).toMatch(/SEARCH metric_samples USING (COVERING )?INDEX/)
    expect(plan(db.select().from(t).where(and(inArray(t.metric, ['cpu', 'ram']), gte(t.ts, 0))).toSQL())).toMatch(/SEARCH metric_samples USING (COVERING )?INDEX/)
  })
  it('matches exactly the prefix', () => {
    const { db } = openDb(':memory:')
    const t = schema.metricSamples
    db.insert(t).values(['ct:a:cpu', 'ct;x', 'cs:z', 'ct:', 'smart:sda:temp', 'smart:sdab:temp', 'CT:a'].map((metric) => ({ ts: 1, metric, value: 1 }))).run()
    const names = (p: string) => db.select({ m: t.metric }).from(t).where(metricPrefix(p)).all().map((r) => r.m).sort()
    expect(names('ct:')).toEqual(['ct:', 'ct:a:cpu'])
    expect(names('smart:sda:')).toEqual(['smart:sda:temp'])
  })
})
