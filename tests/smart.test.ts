import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openDb, schema } from '~/server/db'
import { pruneHistory, querySmartHistory, smartBaselines } from '~/server/metrics'
import { parseJobSpec } from '~/server/packages/job'
import { parseSmartctl, physicalDisks, statusFromExit } from '~/server/smart/parse'
import { installCommand } from '~/shared/packages'
import { assessSmart, attributeLevel, describeNote, describeReason, smartHints, type SmartDisk } from '~/shared/smart'
import { smartSamples } from '~/shared/smart-metrics'

const fx = (n: string) => parseSmartctl(n, readFileSync(`fixtures/demo/smart/${n}.json`, 'utf8'))

describe('smartctl --json', () => {
  it('reads a healthy HDD', () => {
    const d = fx('sda')
    expect(d).toMatchObject({ name: 'sda', status: 'OK', supported: true, model: 'ST12000VN0008-2YS101', rotationRate: 7200, temperature: 34, powerOnHours: 21890, id: 'ST12000VN0008-2YS101-ZRT0A1B2' })
    expect(d.attributes.find((a) => a.id === 5)).toMatchObject({ name: 'Reallocated_Sector_Ct', raw: '0', prefailure: true })
    expect(assessSmart(d)).toEqual({ level: 'ok', reasons: [], notes: [] })
  })

  it('flags reallocated and pending sectors and advises replacement', () => {
    const a = assessSmart(fx('sdb'))
    expect(a.level).toBe('warning')
    expect(a.reasons.map(describeReason)).toEqual(['8 Sektoren wurden ersetzt (Reallocated)', '2 Sektoren warten auf Ersatz (Pending)'])
    expect(smartHints([a])).toEqual(['replace'])
  })

  it('CRC errors: a lifetime counter – only growth is a warning, then it blames the cable', () => {
    const d = fx('sdc') // 14 CRC errors
    // No history yet, or no new errors since: a note, not a warning.
    expect(assessSmart(d)).toEqual({ level: 'ok', reasons: [], notes: [{ kind: 'crc-old', count: 14, since: undefined }] })
    const since = Date.UTC(2026, 8, 25)
    const stable = assessSmart(d, { crc: { value: 14, since } })
    expect(stable.level).toBe('ok')
    expect(describeNote(stable.notes[0]!)).toMatch(/^14 ältere Übertragungsfehler \(CRC\), seit .* keine neuen – der Zähler wird nie zurückgesetzt/)
    expect(smartHints([stable])).toEqual([])
    const crcRow = d.attributes.find((a) => a.id === 199)!
    expect(attributeLevel(crcRow, { crc: { value: 14, since } })).toBe('ok')
    // Still growing: the connection is not right yet.
    const growing = assessSmart(d, { crc: { value: 9, since } })
    expect(growing).toMatchObject({ level: 'warning', reasons: [{ kind: 'crc', count: 14, added: 5, since }] })
    expect(describeReason(growing.reasons[0]!)).toMatch(/^5 neue Übertragungsfehler \(CRC\) seit .* – insgesamt 14; Kabel oder Backplane prüfen/)
    expect(smartHints([growing])).toEqual(['cable'])
    expect(attributeLevel(crcRow, { crc: { value: 9, since } })).toBe('warning')
  })

  it('takes the CRC baseline from the oldest sample of the last week', () => {
    const { db: d } = openDb(':memory:')
    const now = Date.UTC(2026, 9, 2, 12)
    const h = 3600_000
    d.insert(schema.metricSamples)
      .values([
        { ts: now - 30 * 24 * h, metric: 'smart:disk-a:crc', value: 2 },
        { ts: now - 6 * 24 * h, metric: 'smart:disk-a:crc', value: 9 },
        { ts: now - 1 * h, metric: 'smart:disk-a:crc', value: 14 },
        { ts: now - 1 * h, metric: 'smart:disk-b:temp', value: 30 },
      ])
      .run()
    expect(smartBaselines(d, ['disk-a', 'disk-b'], now)).toEqual({ 'disk-a': { crc: { value: 9, since: now - 6 * 24 * h } } })
  })

  it('leaves sleeping disks alone and is not alarmed by them', () => {
    const d = fx('sdd')
    expect(d).toMatchObject({ standby: true, supported: true, status: 'UNKNOWN', message: 'schläft – wird nicht geweckt' })
    expect(assessSmart(d).level).toBe('ok')
  })

  it('reads NVMe health', () => {
    const d = fx('nvme0n1')
    expect(d).toMatchObject({ protocol: 'NVMe', rotationRate: 0, wearLevel: 7, errorMedium: 0, unsafeShutdowns: 19, temperature: 41, selfTests: [{ type: 'Short', passed: true }] })
    expect(assessSmart(d).level).toBe('ok')
    // A critical warning bit makes it critical even when smartctl's exit status is 0.
    const j = JSON.parse(readFileSync('fixtures/demo/smart/nvme0n1.json', 'utf8'))
    j.nvme_smart_health_information_log.critical_warning = 4
    j.nvme_smart_health_information_log.percentage_used = 103
    const bad = parseSmartctl('nvme0n1', JSON.stringify(j))
    expect(assessSmart(bad)).toMatchObject({ level: 'critical' })
    expect(assessSmart(bad).reasons.map((r) => r.kind)).toEqual(['status', 'wear'])
  })

  it('treats virtual disks without SMART as unsupported, not as a problem (captured from a VM)', () => {
    const d = parseSmartctl('vda', readFileSync('tests/fixtures/smartctl-virtio.json', 'utf8'))
    expect(d).toMatchObject({ supported: false, status: 'UNKNOWN', message: '/dev/vda: Unable to detect device type' })
    expect(assessSmart(d)).toEqual({ level: 'ok', reasons: [], notes: [] })
    expect(smartSamples(d)).toEqual([])
  })

  it('maps exit status bits like SnapRAID', () => {
    expect(statusFromExit(0)).toBe('OK')
    expect(statusFromExit(2)).toBe('UNKNOWN')
    expect(statusFromExit(8)).toBe('FAIL')
    expect(statusFromExit(16 | 64)).toBe('PREFAIL')
    expect(statusFromExit(64)).toBe('LOGERR')
    expect(statusFromExit(128)).toBe('SELFERR')
  })

  it('assesses temperature and failing attributes', () => {
    const base = fx('sda')
    const hot: SmartDisk = { ...base, temperature: 61 }
    expect(assessSmart(hot)).toEqual({ level: 'critical', reasons: [{ kind: 'temperature', celsius: 61 }], notes: [] })
    expect(smartHints([assessSmart(hot)])).toEqual(['cooling'])
    expect(attributeLevel({ id: 1, name: 'x', value: 1, worst: 1, threshold: 10, raw: '0', whenFailed: 'now', prefailure: true })).toBe('critical')
    expect(attributeLevel({ id: 197, name: 'x', value: 100, worst: 100, threshold: 0, raw: '3', prefailure: false })).toBe('warning')
  })

  it('finds physical disks (captured lsblk from a VM: zram skipped)', () => {
    expect(physicalDisks(readFileSync('tests/fixtures/lsblk-disks.json', 'utf8'))).not.toContain('zram0')
    expect(physicalDisks(JSON.stringify({ blockdevices: [{ name: 'sda', type: 'disk' }, { name: 'loop0', type: 'loop' }, { name: 'sr0', type: 'rom' }, { name: 'nvme0n1', type: 'disk' }, { name: 'md0', type: 'raid1' }] }))).toEqual(['sda', 'nvme0n1'])
  })
})

describe('SMART history', () => {
  it('stores trend samples, reads them per disk and keeps them a year', () => {
    const { db } = openDb(':memory:')
    const now = 400 * 24 * 3600_000
    const disk = fx('sdb')
    expect(smartSamples(disk)).toEqual([
      { key: 'temp', value: 35 },
      { key: 'realloc', value: 8 },
      { key: 'pending', value: 2 },
      { key: 'uncorrectable', value: 0 },
      { key: 'crc', value: 0 },
    ])
    const rows = [now - 100 * 24 * 3600_000, now - 3600_000].flatMap((ts, i) => smartSamples(disk).map((s) => ({ ts, metric: `smart:${disk.id}:${s.key}`, value: i === 0 && s.key === 'realloc' ? 0 : s.value })))
    rows.push({ ts: now - 30 * 24 * 3600_000, metric: 'cpu', value: 0.5 }, { ts: now - 380 * 24 * 3600_000, metric: `smart:${disk.id}:temp`, value: 30 })
    db.insert(schema.metricSamples).values(rows).run()
    const h = querySmartHistory(db, disk.id, 365, now)
    expect(h.realloc!.map(([, v]) => v)).toEqual([0, 8])
    expect(querySmartHistory(db, 'other', 365, now)).toEqual({})
    pruneHistory(db, now)
    const left = db.select().from(schema.metricSamples).all()
    expect(left.some((r) => r.metric === 'cpu')).toBe(false) // older than 7 days
    expect(left.filter((r) => r.metric.startsWith('smart:')).length).toBe(10) // within a year
  })
})

describe('install jobs', () => {
  it('only installs known features, with the right package per distro', () => {
    expect(parseJobSpec({ kind: 'install', feature: 'smart' })).toEqual({ kind: 'install', feature: 'smart' })
    expect(() => parseJobSpec({ kind: 'install', feature: 'evil; rm -rf /' })).toThrow()
    expect(() => parseJobSpec({ kind: 'install', names: ['anything'] })).toThrow()
    expect(installCommand('pacman', 'smart')).toBe('sudo pacman -S --needed smartmontools')
    expect(installCommand('apt', 'nfs')).toBe('sudo apt install nfs-kernel-server')
    expect(installCommand('dnf', 'ssh')).toBe('sudo dnf install openssh-server')
  })
})
