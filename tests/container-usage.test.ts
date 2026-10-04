import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUsageRange } from '~/shared/container-usage'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-usage-'))
const { UsageRecorder, USAGE_BUCKET_MS, queryUsage, seedUsageHistory } = await import('~/server/container-usage')
const { db, schema } = await import('~/server/db')
const { pruneHistory } = await import('~/server/metrics')

const MB = 1024 ** 2
const ct = (name: string, cpu: number | undefined, mem: number | undefined, state = 'running', unit?: string) => ({ name, state, cpu, memUsage: mem, ...(unit ? { unit } : {}) })

describe('per-container usage', () => {
  it('averages 5 s samples into 5-minute buckets with peaks; stopped containers add nothing', () => {
    const r = new UsageRecorder(db)
    const t0 = Math.floor((Date.now() - 3600_000) / USAGE_BUCKET_MS) * USAGE_BUCKET_MS
    // bucket 1: jellyfin 10 % and 30 %, immich 2 %; old-nginx stopped
    r.record([ct('jellyfin', 10, 400 * MB, 'running', 'jellyfin.service'), ct('immich', 2, 900 * MB), ct('old-nginx', 50, 10 * MB, 'exited')], t0 + 1000)
    r.record([ct('jellyfin', 30, 600 * MB, 'running', 'jellyfin.service'), ct('immich', 2, 900 * MB)], t0 + 6000)
    // nothing written until the bucket ends
    expect(db().select().from(schema.metricSamples).all().filter((x) => x.metric.startsWith('ct:'))).toHaveLength(0)
    // bucket 2: jellyfin 50 %
    r.record([ct('jellyfin', 50, 500 * MB, 'running', 'jellyfin.service'), ct('immich', undefined, undefined)], t0 + USAGE_BUCKET_MS + 1000)
    r.flush()
    const rows = db().select().from(schema.metricSamples).all().filter((x) => x.metric.startsWith('ct:'))
    const at = (metric: string, ts: number) => rows.find((x) => x.metric === metric && x.ts === ts)?.value
    expect(at('ct:jellyfin:cpu', t0)).toBe(20)
    expect(at('ct:jellyfin:cpumax', t0)).toBe(30)
    expect(at('ct:jellyfin:mem', t0)).toBe(500 * MB)
    expect(at('ct:jellyfin:memmax', t0)).toBe(600 * MB)
    expect(at('ct:jellyfin:cpu', t0 + USAGE_BUCKET_MS)).toBe(50)
    expect(rows.some((x) => x.metric.startsWith('ct:old-nginx'))).toBe(false)
    expect(rows.filter((x) => x.metric.startsWith('ct:immich:') && x.ts === t0 + USAGE_BUCKET_MS)).toHaveLength(0) // no stats in bucket 2

    const u = queryUsage(db(), '24h', r.units)
    expect(u.map((x) => x.name)).toEqual(['jellyfin', 'immich']) // highest CPU first
    expect(u[0]).toMatchObject({ unit: 'jellyfin.service', cpuAvg: 35, cpuMax: 50, memMax: 600 * MB })
    expect(u[0]!.uptime).toBeCloseTo((2 * USAGE_BUCKET_MS) / 86_400_000)
    expect(u[1]).toMatchObject({ cpuAvg: 2, memAvg: 900 * MB })
    // over 24 h a chart point spans 15 minutes: the two buckets are one or two points, depending on the clock
    expect(u[0]!.cpu.length).toBeGreaterThanOrEqual(1)
    expect(u[0]!.cpu.length).toBeLessThanOrEqual(2)
    const count = () => db().select().from(schema.metricSamples).all().filter((x) => x.metric.startsWith('ct:')).length
    const before = count()
    r.flush() // nothing pending: no duplicates
    expect(count()).toBe(before)
  })

  it('thins 30 days to about 120 points and keeps peaks as peaks', () => {
    seedUsageHistory(db(), [ct('busy', 5, 200 * MB)]) // not seeded: there are rows already
    expect(queryUsage(db(), '30d').some((x) => x.name === 'busy')).toBe(false)
    const t = schema.metricSamples
    const end = Math.floor(Date.now() / USAGE_BUCKET_MS) * USAGE_BUCKET_MS
    const rows = []
    for (let ts = end - 29 * 86_400_000; ts < end; ts += USAGE_BUCKET_MS) rows.push({ ts, metric: 'ct:busy:cpu', value: 5 }, { ts, metric: 'ct:busy:cpumax', value: ts === end - 12 * 3_600_000 ? 400 : 8 })
    for (let i = 0; i < rows.length; i += 500) db().insert(t).values(rows.slice(i, i + 500)).run()
    const busy = queryUsage(db(), '30d').find((x) => x.name === 'busy')!
    expect(busy.cpu.length).toBeLessThanOrEqual(121)
    expect(busy.cpu.length).toBeGreaterThan(100)
    expect(busy.cpuAvg).toBeCloseTo(5)
    expect(busy.cpuMax).toBe(400)
    expect(Math.max(...busy.cpuPeak.map(([, v]) => v))).toBe(400) // the spike survives thinning
    expect(queryUsage(db(), '24h').find((x) => x.name === 'busy')!.cpuMax).toBe(400)
  })

  it('pruning keeps 30 days', () => {
    const old = Date.now() - 31 * 86_400_000
    db().insert(schema.metricSamples).values([{ ts: old, metric: 'ct:gone:cpu', value: 1 }, { ts: Date.now() - 20 * 86_400_000, metric: 'ct:kept:cpu', value: 1 }]).run()
    pruneHistory(db())
    const names = db().select().from(schema.metricSamples).all().map((x) => x.metric)
    expect(names).not.toContain('ct:gone:cpu')
    expect(names).toContain('ct:kept:cpu')
    expect(parseUsageRange('7d')).toBe('7d')
    expect(parseUsageRange('1y')).toBe('24h')
    expect(parseUsageRange(null)).toBe('24h')
  })
})
