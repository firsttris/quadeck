import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fsTrend, fullInUnit, perMonth } from '~/shared/disk-usage'
import { parseLsblk } from '~/server/collectors/disks'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-fs-'))
const { FsHistory, fsTrends, seedFsHistory } = await import('~/server/disk-history')
const { db, schema } = await import('~/server/db')
const { pruneHistory } = await import('~/server/metrics')

const DAY = 86_400_000
const TB = 1e12
const NOW = Date.UTC(2026, 9, 5, 12)
/** One sample per hour over `days`, growing by `perDay` bytes. */
const line = (days: number, start: number, perDay: number) => Array.from({ length: days * 24 }, (_, i): [number, number] => [NOW - (days * 24 - 1 - i) * 3600_000, start + (perDay * i) / 24])

describe('trend and forecast', () => {
  it('fits growth per day and says when the disk is full', () => {
    const t = fsTrend(line(30, 9 * TB, 50e9), 12 * TB, NOW)!
    expect(t.perDay / 1e9).toBeCloseTo(50, 3)
    expect(t.steady).toBe(false)
    // 9 TB + 30 days × 50 GB ≈ 10.5 TB; 1.5 TB left at 50 GB/day = 30 days
    expect(t.fullInDays).toBe(30)
    expect(t.spark).toHaveLength(30)
    expect(t.spark.at(-1)).toBeCloseTo(10.5 / 12, 2)
    expect(perMonth(t) / 1e9).toBeCloseTo(1520, -1)
  })

  it('steady, shrinking, too little history', () => {
    expect(fsTrend(line(30, 300e9, 100e6), 1 * TB, NOW)).toMatchObject({ steady: true }) // 0.01 % a day
    expect(fsTrend(line(30, 300e9, 100e6), 1 * TB, NOW)!.fullInDays).toBeUndefined()
    const shrinking = fsTrend(line(30, 9 * TB, -40e9), 12 * TB, NOW)!
    expect(shrinking.perDay).toBeLessThan(0)
    expect(shrinking.fullInDays).toBeUndefined()
    expect(fsTrend(line(1, 9 * TB, 50e9), 12 * TB, NOW)).toBeUndefined() // one day is not a trend
    expect(fsTrend([], 12 * TB, NOW)).toBeUndefined()
    expect(fsTrend(line(30, 9 * TB, 50e9), 0, NOW)).toBeUndefined()
    // only the last 30 days count: a big jump 40 days ago is ignored
    const old: [number, number][] = [[NOW - 40 * DAY, 1 * TB], ...line(30, 9 * TB, 0)]
    expect(fsTrend(old, 12 * TB, NOW)!.steady).toBe(true)
  })

  it('beyond ten years there is no date to show', () => {
    expect(fsTrend(line(30, 1 * TB, 3e9), 14 * TB, NOW)!.fullInDays).toBeUndefined() // 13 TB at 3 GB/day ≈ 12 years
  })

  it('rounds to days, weeks, months, years', () => {
    expect(fullInUnit(0.4)).toEqual({ n: 1, unit: 'days' })
    expect(fullInUnit(9)).toEqual({ n: 9, unit: 'days' })
    expect(fullInUnit(20)).toEqual({ n: 3, unit: 'weeks' })
    expect(fullInUnit(670)).toEqual({ n: 22, unit: 'months' })
    expect(fullInUnit(1200)).toEqual({ n: 3, unit: 'years' })
  })
})

describe('history in the database', () => {
  it('writes one sample per file system and hour, trends from it, keeps 400 days', () => {
    const h = new FsHistory(db)
    const disks = [{ mount: '/mnt/disk1', size: 12 * TB, used: 9 * TB }, { mount: '/', size: 1 * TB, used: 0.3 * TB }]
    for (let d = 10; d >= 0; d--)
      for (const min of [0, 10, 59]) h.record(disks.map((x) => ({ ...x, used: x.mount === '/' ? x.used : x.used + (10 - d) * 50e9 })), NOW - d * DAY + min * 60_000 - 30 * 60_000)
    const rows = db()
      .select()
      .from(schema.metricSamples)
      .all()
      .filter((r) => r.metric.startsWith('fs:'))
    // three calls per hour, but one row each (the 10/59 minute calls fall into neighbouring hours)
    expect(rows.filter((r) => r.metric === 'fs:/mnt/disk1').length).toBeLessThanOrEqual(22)
    const trends = fsTrends(db(), [{ mount: '/mnt/disk1', size: 12 * TB, used: 9.5 * TB }, { mount: '/', size: 1 * TB, used: 0.3 * TB }, { mount: '/new', size: TB, used: 1 }], NOW)
    expect(trends.get('/mnt/disk1')!.perDay / 1e9).toBeCloseTo(50, 0)
    expect(trends.get('/')!.steady).toBe(true)
    expect(trends.has('/new')).toBe(false)
    // 400 days, not the 7 days of the CPU history
    db().insert(schema.metricSamples).values({ ts: NOW - 300 * DAY, metric: 'fs:/mnt/disk1', value: 1 }).run()
    db().insert(schema.metricSamples).values({ ts: NOW - 401 * DAY, metric: 'fs:/mnt/disk1', value: 1 }).run()
    pruneHistory(db(), NOW)
    const left = db().select().from(schema.metricSamples).all().filter((r) => r.metric === 'fs:/mnt/disk1').map((r) => r.ts)
    expect(left).toContain(NOW - 300 * DAY)
    expect(left).not.toContain(NOW - 401 * DAY)
  })

  it('the demo history gives the data disks a trend and the system disk none', () => {
    const disks = [{ mount: '/', size: 1 * TB, used: 0.3 * TB }, { mount: '/mnt/a', size: 12 * TB, used: 10 * TB }]
    db().delete(schema.metricSamples).run()
    seedFsHistory(db(), disks, NOW)
    const t = fsTrends(db(), disks, NOW)
    expect(t.get('/')!.steady).toBe(true)
    expect(t.get('/mnt/a')!.fullInDays).toBeGreaterThan(0)
  })
})

describe('which disks a file system lives on', () => {
  it('RAID and LVM over several disks list all of them', () => {
    const raid = { name: 'md0', path: '/dev/md0', type: 'raid1', size: '10', fstype: 'ext4', mountpoints: ['/mnt/pool'] }
    const json = JSON.stringify({
      blockdevices: [
        { name: 'sda', type: 'disk', size: '10', children: [{ name: 'sda1', type: 'part', size: '10', fstype: 'linux_raid_member', children: [raid] }] },
        { name: 'sdb', type: 'disk', size: '10', children: [{ name: 'sdb1', type: 'part', size: '10', fstype: 'linux_raid_member', children: [raid] }] },
        { name: 'sdc', type: 'disk', size: '10', children: [{ name: 'sdc1', path: '/dev/sdc1', type: 'part', size: '10', fstype: 'xfs', mountpoints: ['/mnt/disk3'] }] },
      ],
    })
    const fs = parseLsblk(json)
    expect(fs.find((f) => f.mount === '/mnt/pool')).toMatchObject({ dev: 'md0', disks: ['sda', 'sdb'] })
    expect(fs.find((f) => f.mount === '/mnt/disk3')).toMatchObject({ dev: 'sdc', disks: ['sdc'] })
  })
})
