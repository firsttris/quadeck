import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SystemPower } from '~/server/smart/power'
import {
  DEFAULT_ENERGY,
  cpuEstimate,
  cpuZone,
  dailyAverage,
  dayStart,
  group,
  monthProjection,
  parseEnergySettings,
  parseLsblkKinds,
  powerNow,
  raplWatts,
  standbySavings,
  sumSplit,
  withSettings,
  type HourEnergy,
  type PowerSample,
} from '~/shared/energy'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-energy-'))
const { EnergyMeter, energyHours, energyReport, gpuWatts, hourStart, setEnergySettings, energySettings } = await import('~/server/energy')
const { db, schema } = await import('~/server/db')
const { pruneHistory } = await import('~/server/metrics')

const MAX = 262_143_328_850
const sample = (at: number, uj: number, extra: Partial<PowerSample> = {}): PowerSample => ({ at, rapl: [{ id: 'intel-rapl:0', name: 'package-0', energyUj: uj, maxUj: MAX }], disks: [], ...extra })

describe('RAPL', () => {
  it('watts from two counter readings, also across the wrap', () => {
    expect(raplWatts(sample(0, 0), sample(30_000, 420_000_000))).toBeCloseTo(14)
    expect(raplWatts(sample(0, MAX - 100_000_000), sample(10_000, 40_000_000))).toBeCloseTo(14)
    expect(raplWatts(undefined, sample(0, 1))).toBeUndefined()
    expect(raplWatts(sample(5, 1), sample(5, 2))).toBeUndefined()
    expect(raplWatts(sample(0, 0, { rapl: [] }), sample(1000, 0, { rapl: [] }))).toBeUndefined()
  })
  it('counts packages and DRAM, never psys, cores or the mmio duplicate', () => {
    expect(cpuZone({ id: 'intel-rapl:0', name: 'package-0' })).toBe(true)
    expect(cpuZone({ id: 'intel-rapl:1', name: 'package-1' })).toBe(true)
    expect(cpuZone({ id: 'intel-rapl:0:2', name: 'dram' })).toBe(true)
    expect(cpuZone({ id: 'intel-rapl:0:0', name: 'core' })).toBe(false)
    expect(cpuZone({ id: 'intel-rapl:1', name: 'psys' })).toBe(false)
    expect(cpuZone({ id: 'intel-rapl-mmio:0', name: 'package-0' })).toBe(false)
    const zones = (pkg: number, dram: number, core: number) => [
      { id: 'intel-rapl:0', name: 'package-0', energyUj: pkg, maxUj: MAX },
      { id: 'intel-rapl:0:0', name: 'core', energyUj: core, maxUj: MAX },
      { id: 'intel-rapl:0:1', name: 'dram', energyUj: dram, maxUj: MAX },
      { id: 'intel-rapl:1', name: 'psys', energyUj: pkg * 3, maxUj: MAX },
    ]
    expect(raplWatts({ at: 0, rapl: zones(0, 0, 0), disks: [] }, { at: 1000, rapl: zones(10e6, 2e6, 8e6), disks: [] })).toBeCloseTo(12)
  })
  it('reads the zones from sysfs (root helper)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-rapl-'))
    for (const [id, name, uj] of [
      ['intel-rapl:0', 'package-0', '123456'],
      ['intel-rapl:0:0', 'core', '100'],
      ['intel-rapl-mmio:0', 'package-0', '999'],
    ]) {
      mkdirSync(join(dir, id))
      writeFileSync(join(dir, id, 'name'), `${name}\n`)
      writeFileSync(join(dir, id, 'energy_uj'), `${uj}\n`)
      writeFileSync(join(dir, id, 'max_energy_range_uj'), `${MAX}\n`)
    }
    mkdirSync(join(dir, 'intel-rapl:1')) // no counters readable
    const calls: string[][] = []
    const exec = async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'lsblk')
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            blockdevices: [
              { name: 'sda', type: 'disk', rota: true, tran: 'sata', model: 'WDC WD80EFZZ ' },
              { name: 'sdb', type: 'disk', rota: '1', tran: 'usb', model: 'Elements' },
              { name: 'sdc', type: 'disk', rota: false, tran: 'sata', model: 'Samsung SSD 870' },
              { name: 'nvme0n1', type: 'disk', rota: false, tran: 'nvme', model: 'Samsung SSD 980' },
              { name: 'zram0', type: 'disk', rota: false },
              { name: 'loop0', type: 'loop' },
              { name: 'sr0', type: 'rom', rota: true },
            ],
          }),
        }
      return { code: 0, stderr: '', stdout: argv.at(-1) === '/dev/sdb' ? ' drive state is:  standby\n' : ' drive state is:  active/idle\n' }
    }
    const p = new SystemPower('/x/rules', join(dir, 'hist'), exec, '/x', '/x/hdparm.conf', '/usr/sbin/hdparm', dir)
    const s = await p.powerSample()
    expect(s.rapl).toEqual([
      { id: 'intel-rapl:0', name: 'package-0', energyUj: 123456, maxUj: MAX },
      { id: 'intel-rapl:0:0', name: 'core', energyUj: 100, maxUj: MAX },
    ])
    expect(s.disks).toEqual([
      { name: 'sda', model: 'WDC WD80EFZZ', kind: 'hdd', usb: false, state: 'active' },
      { name: 'sdb', model: 'Elements', kind: 'hdd', usb: true, state: 'unknown' },
      { name: 'sdc', model: 'Samsung SSD 870', kind: 'ssd', usb: false, state: 'unknown' },
      { name: 'nvme0n1', model: 'Samsung SSD 980', kind: 'nvme', usb: false, state: 'unknown' },
    ])
    expect(calls.filter((c) => c[0] === '/usr/sbin/hdparm').map((c) => c.at(-1))).toEqual(['/dev/sda']) // only internal spinning disks are asked
    expect(new SystemPower('/x', join(dir, 'h2'), exec, '/x', '/x', undefined, join(dir, 'missing')).readRapl()).toEqual([])
    expect(parseLsblkKinds('nope')).toEqual([])
  })
})

describe('power now', () => {
  it('adds CPU, GPU, disks and the rest with power supply loss', () => {
    const p = powerNow({
      at: 1,
      cpuW: 14,
      load: 0.5,
      gpuW: 9,
      disks: [
        { name: 'sda', kind: 'hdd', usb: false, state: 'active' },
        { name: 'sdb', kind: 'hdd', usb: false, state: 'standby' },
        { name: 'sdc', kind: 'ssd', usb: false, state: 'unknown' },
        { name: 'nvme0n1', kind: 'nvme', usb: false, state: 'unknown' },
      ],
      settings: { price: 0.35, baseW: 15, lossPct: 10 },
    })
    expect(p.disks).toBeCloseTo(6 + 0.8 + 1.2 + 3)
    expect(p.loss).toBeCloseTo((14 + 9 + 11 + 15) * 0.1)
    expect(p.rest).toBeCloseTo(15 + 4.9)
    expect(p.total).toBeCloseTo(14 + 9 + 11 + 19.9)
    expect(p).toMatchObject({ cpuMeasured: true, gpuMeasured: true })
    expect(p.disksNow.map((d) => d.watts)).toEqual([6, 0.8, 1.2, 3])
  })
  it('without counters: CPU from the load, GPU zero and marked', () => {
    const p = powerNow({ at: 1, load: 0.5, disks: [], settings: { price: 0, baseW: 0, lossPct: 0 } })
    expect(p.cpu).toBe(cpuEstimate(0.5))
    expect(p).toMatchObject({ gpu: 0, cpuMeasured: false, gpuMeasured: false, total: 19 })
    expect(withSettings(p, { price: 0, baseW: 10, lossPct: 50 })).toMatchObject({ rest: 10 + (19 + 10) * 0.5, total: 19 + 10 + 14.5 })
    expect(cpuEstimate(-1)).toBe(4)
    expect(cpuEstimate(9)).toBe(34)
    expect(gpuWatts([{ id: 'a', name: 'x', vendor: 'nvidia', utilKind: 'load', powerW: 7 }, { id: 'b', name: 'y', vendor: 'intel', utilKind: 'clock' }])).toBe(7)
    expect(gpuWatts([{ id: 'b', name: 'y', vendor: 'intel', utilKind: 'clock' }])).toBeUndefined()
  })
  it('settings: comma decimals, bounds', () => {
    expect(parseEnergySettings({ price: '0,32', baseW: '12', lossPct: 8 })).toEqual({ price: 0.32, baseW: 12, lossPct: 8 })
    for (const bad of [{ price: -1, baseW: 1, lossPct: 1 }, { price: 1, baseW: 501, lossPct: 1 }, { price: 1, baseW: 1, lossPct: 60 }, { price: 'x', baseW: 1, lossPct: 1 }, {}]) expect(() => parseEnergySettings(bad)).toThrow()
  })
})

describe('energy over time', () => {
  const hour = (ts: number, wh = 50): HourEnergy => ({ ts, cpu: wh * 0.3, gpu: wh * 0.1, disks: wh * 0.3, rest: wh * 0.3 })
  it('groups hours into local days and months', () => {
    const d0 = new Date(2026, 0, 31, 22).getTime()
    const hours = [hour(d0), hour(d0 + 3_600_000), hour(d0 + 2 * 3_600_000), hour(d0 + 3 * 3_600_000)]
    const days = group(hours, 'day')
    expect(days.map((d) => [new Date(d.ts).getDate(), Math.round(sumSplit(d))])).toEqual([
      [31, 100],
      [1, 100],
    ])
    expect(group(hours, 'month').map((d) => new Date(d.ts).getMonth())).toEqual([0, 1])
  })
  it('projects the month and averages days from the hours there are', () => {
    const now = new Date(2026, 3, 10, 12).getTime() // April: 720 hours
    const start = new Date(2026, 3, 1).getTime()
    const hours = Array.from({ length: 24 }, (_, i) => hour(start + i * 3_600_000, 60))
    const p = monthProjection(hours, now)
    expect(p.kwh).toBeCloseTo(1.44)
    expect(p.projected).toBeCloseTo(43.2)
    expect(dailyAverage(hours, now)).toBeCloseTo(1.44)
    expect(dailyAverage(hours.slice(0, 2), now)).toBeUndefined()
    expect(standbySavings([{ kind: 'hdd', seconds: 10 * 3600 * 15 }], 15)).toBeCloseTo((10 * 30 * 5.2) / 1000)
    expect(standbySavings([], 0)).toBe(0)
  })
})

describe('the meter', () => {
  const disks = [{ name: 'sdb', kind: 'hdd' as const, usb: false, state: 'standby' as const }]
  const settings = { price: 0.4, baseW: 10, lossPct: 0 }

  it('adds Wh per hour, skips gaps, survives a restart, keeps two years', () => {
    const t0 = hourStart(Date.now() - 5 * 3_600_000)
    const m = new EnergyMeter()
    // a CPU drawing 14 W: the counter grows by 14 J per second
    let uj = 0
    let last = t0
    const tick = (meter: InstanceType<typeof EnergyMeter>, at: number) => {
      uj += 14 * ((at - last) / 1000) * 1e6
      last = at
      return meter.tick(sample(at, uj, { disks }), { load: 0.1, gpus: [], settings })
    }
    expect(tick(m, t0).cpuMeasured).toBe(false) // no difference yet
    for (let i = 1; i <= 120; i++) tick(m, t0 + i * 30_000) // one hour at 14 W CPU
    const p = m.now!
    expect(p.cpu).toBeCloseTo(14)
    expect(p.cpuMeasured).toBe(true)
    let h = energyHours(db(), t0, t0 + 2 * 3_600_000)
    expect(h).toHaveLength(2) // the last tick opened the next hour
    expect(h[0]!.cpu).toBeCloseTo(14, 0)
    expect(h[0]!.disks).toBeCloseTo(0.8, 1)
    expect(h[0]!.rest).toBeCloseTo(10, 0)

    // a 10-minute gap (server off) is not counted
    tick(m, t0 + 3_600_000 + 10 * 60_000)
    h = energyHours(db(), t0, t0 + 2 * 3_600_000)
    expect(sumSplit(h[1]!)).toBeCloseTo(0.2, 1) // only the one 30 s tick at the hour boundary

    // restart: a new meter continues the current hour instead of overwriting it
    const before = h[1]!.cpu
    const m2 = new EnergyMeter()
    tick(m2, t0 + 3_600_000 + 11 * 60_000)
    tick(m2, t0 + 3_600_000 + 11 * 60_000 + 30_000)
    expect(m2.now!.cpuMeasured).toBe(true)
    expect(energyHours(db(), t0, t0 + 2 * 3_600_000)[1]!.cpu).toBeGreaterThan(before)

    const r = energyReport(db(), m2.now, (d) => (d === 'sdb' ? 'hdd' : undefined))
    expect(r.hours.length).toBeGreaterThanOrEqual(2)
    expect(r.today).toBeGreaterThan(0)
    expect(r.standbyToday.sdb ?? 0).toBeGreaterThanOrEqual(0)
    expect(r.settings).toEqual(energySettings())

    // pruning keeps energy (two years) but not week-old live samples
    const old = Date.now() - 400 * 86_400_000
    db().insert(schema.metricSamples).values([{ ts: old, metric: 'energy:cpu', value: 1 }, { ts: old, metric: 'cpu', value: 1 }, { ts: Date.now() - 800 * 86_400_000, metric: 'energy:cpu', value: 1 }]).run()
    pruneHistory(db())
    expect(energyHours(db(), old - 1000, old + 1000)).toHaveLength(1)
    expect(energyHours(db(), Date.now() - 900 * 86_400_000, Date.now() - 700 * 86_400_000)).toHaveLength(0)
  })

  it('settings are stored', () => {
    expect(energySettings()).toEqual(DEFAULT_ENERGY)
    expect(setEnergySettings({ price: '0,29', baseW: 12, lossPct: 12 })).toEqual({ price: 0.29, baseW: 12, lossPct: 12 })
    expect(energySettings().price).toBe(0.29)
    expect(() => setEnergySettings({ price: 9 })).toThrow()
    expect(dayStart(Date.now())).toBeLessThanOrEqual(Date.now())
  })
})
