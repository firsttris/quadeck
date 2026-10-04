import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SystemPower, parseLsblkDisks, processesOn } from '~/server/smart/power'
import { dailyWakes, hdparmArgs, parseHdparmApm, parseHdparmState, parsePowerRules, parsePowerSetting, powerRules, standbyValue, wakeRate } from '~/shared/power'

describe('standby values and the udev rule', () => {
  it('encodes minutes the way hdparm -S wants them', () => {
    expect([0, 10, 20, 30, 60, 120].map((n) => standbyValue(n as 0))).toEqual([0, 120, 240, 241, 242, 244])
    expect(hdparmArgs({ minutes: 20, apm: 'disk' })).toEqual(['-S', '240'])
    expect(hdparmArgs({ minutes: 30, apm: 'save' })).toEqual(['-B', '127', '-S', '241'])
    expect(hdparmArgs({ minutes: 0, apm: 'perf' })).toEqual(['-B', '254', '-S', '0'])
  })
  it('accepts only the offered values', () => {
    expect(parsePowerSetting({ minutes: 30, apm: 'save' })).toEqual({ minutes: 30, apm: 'save' })
    expect(parsePowerSetting({ minutes: '20' })).toEqual({ minutes: 20, apm: 'disk' })
    expect(parsePowerSetting({ minutes: 7 })).toBeUndefined()
    expect(parsePowerSetting({ minutes: 20, apm: 'turbo' })).toEqual({ minutes: 20, apm: 'disk' })
  })
  it('writes one line per serial and reads it back; odd serials never reach the file', () => {
    const text = powerRules({ ZRT0A1B2: { minutes: 20, apm: 'disk' }, X1Z0: { minutes: 30, apm: 'save' }, 'evil" RUN+="/bin/sh': { minutes: 10, apm: 'disk' } }, '/usr/bin/hdparm')
    expect(text.split('\n')).toEqual([
      '# Written by Quadeck (Disks → Energy saving) – changes are overwritten',
      'ACTION=="add|change", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ENV{ID_SERIAL_SHORT}=="X1Z0", RUN+="/usr/bin/hdparm -B 127 -S 241 /dev/%k"',
      'ACTION=="add|change", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ENV{ID_SERIAL_SHORT}=="ZRT0A1B2", RUN+="/usr/bin/hdparm -S 240 /dev/%k"',
      '',
    ])
    expect(parsePowerRules(text)).toEqual({ X1Z0: { minutes: 30, apm: 'save' }, ZRT0A1B2: { minutes: 20, apm: 'disk' } })
    expect(parsePowerRules('ACTION=="add", RUN+="/bin/true"\n# hdparm -S 9')).toEqual({})
  })
  it('reads hdparm output', () => {
    expect(parseHdparmState('\n/dev/sdb:\n drive state is:  standby\n')).toBe('standby')
    expect(parseHdparmState('/dev/sdb:\n drive state is:  active/idle\n')).toBe('active')
    expect(parseHdparmState('/dev/sdb:\n drive state is:  unknown\n')).toBe('unknown')
    expect(parseHdparmApm('/dev/sda:\n APM_level\t= 254\n')).toBe(254)
    expect(parseHdparmApm(' APM_level      = off\n')).toBe('off')
    expect(parseHdparmApm(' APM_level      = not supported\n')).toBeUndefined()
  })
})

describe('spin-ups', () => {
  const day = 86_400_000
  const now = 30 * day
  it('per day from the counter, only with enough history and no reset', () => {
    expect(wakeRate([[now - 7 * day, 100], [now - 3 * day, 140], [now, 170]], now)).toBe(10)
    expect(wakeRate([[now - 3600_000, 100], [now, 102]], now)).toBeUndefined()
    expect(wakeRate([[now - 2 * day, 100], [now, 50]], now)).toBeUndefined()
    expect(wakeRate([[now - 20 * day, 0], [now - 2 * day, 100], [now, 120]], now)).toBe(10) // older points ignored
  })
  it('as a daily series', () => {
    expect(dailyWakes([[0, 10], [day / 2, 14], [day + 1, 20], [3 * day + 5, 40]]).map(([, v]) => v)).toEqual([6, 10])
  })
})

describe('disks and what holds them', () => {
  const lsblk = JSON.stringify({
    blockdevices: [
      { name: 'nvme0n1', type: 'disk', rota: false, children: [{ name: 'nvme0n1p2', type: 'part', mountpoints: ['/'] }] },
      { name: 'sda', type: 'disk', rota: true, tran: 'sata', serial: 'ZRT0A1B2', model: 'ST12000VN0008', children: [{ name: 'sda1', type: 'part', fstype: 'ext4', mountpoints: ['/mnt/disk1'] }] },
      { name: 'sdb', type: 'disk', rota: '1', tran: 'usb', serial: 'WD 123', model: 'Elements', mountpoints: [null] },
      { name: 'sdc', type: 'disk', rota: true, serial: 'R1', children: [{ name: 'sdc1', type: 'part', fstype: 'linux_raid_member', children: [{ name: 'md0', type: 'raid1', mountpoints: ['/srv'] }] }] },
      { name: 'sdd', type: 'disk', rota: true, serial: 'SYS', children: [{ name: 'sdd1', type: 'part', mountpoint: '/' }] },
      { name: 'sr0', type: 'rom', rota: true },
    ],
  })
  it('spinning disks with system, RAID and USB marks', () => {
    expect(parseLsblkDisks(lsblk)).toEqual([
      { name: 'sda', serial: 'ZRT0A1B2', model: 'ST12000VN0008', usb: false, system: false, raid: false, mounts: ['/mnt/disk1'] },
      { name: 'sdb', serial: 'WD_123', model: 'Elements', usb: true, system: false, raid: false, mounts: [] },
      { name: 'sdc', serial: 'R1', usb: false, system: false, raid: true, mounts: ['/srv'] },
      { name: 'sdd', serial: 'SYS', usb: false, system: true, raid: false, mounts: ['/'] },
    ])
    expect(parseLsblkDisks('nonsense')).toEqual([])
  })
  it('processes with open files below the mounts, grouped by command and unit', () => {
    const proc = mkdtempSync(join(tmpdir(), 'qd-proc-'))
    const pid = (n: number, comm: string, cgroup: string, links: string[], cwd = '/') => {
      mkdirSync(join(proc, String(n), 'fd'), { recursive: true })
      writeFileSync(join(proc, String(n), 'comm'), comm + '\n')
      writeFileSync(join(proc, String(n), 'cgroup'), cgroup)
      links.forEach((l, i) => symlinkSync(l, join(proc, String(n), 'fd', String(i))))
      symlinkSync(cwd, join(proc, String(n), 'cwd'))
    }
    pid(10, 'jellyfin', '0::/system.slice/jellyfin.service/libpod-payload-abc\n', ['/mnt/disk1/movies/a.mkv', '/mnt/disk1/movies/b.mkv', '/dev/null'])
    pid(11, 'jellyfin', '0::/system.slice/jellyfin.service\n', ['/mnt/disk1/x'])
    pid(12, 'bash', '0::/user.slice/user-1000.slice/session-3.scope\n', [], '/mnt/disk1/photos')
    pid(13, 'sshd', '0::/system.slice/sshd.service\n', ['/etc/ssh/sshd_config'])
    pid(14, 'other', '0::/x\n', ['/mnt/disk10/y'])
    expect(processesOn(['/mnt/disk1'], proc)).toEqual([
      { command: 'jellyfin', unit: 'jellyfin.service', files: 3 },
      { command: 'bash', files: 1 },
    ])
    expect(processesOn(['/'], proc)).toEqual([]) // the root mount would match everything
  })
})

describe('SystemPower', () => {
  const setup = (extraLsblk = '') => {
    const root = mkdtempSync(join(tmpdir(), 'qd-power-'))
    const rulesDir = join(root, 'rules.d')
    mkdirSync(rulesDir)
    const calls: string[] = []
    const lsblk = JSON.stringify({
      blockdevices: [
        { name: 'sda', type: 'disk', rota: true, serial: 'ZRT0A1B2', model: 'ST12000', children: [{ name: 'sda1', type: 'part', mountpoints: ['/mnt/disk1'] }] },
        { name: 'sdd', type: 'disk', rota: true, serial: 'SYS', children: [{ name: 'sdd1', type: 'part', mountpoints: ['/'] }] },
        ...(extraLsblk ? [JSON.parse(extraLsblk)] : []),
      ],
    })
    const exec = async (argv: string[]) => {
      calls.push(argv.join(' '))
      if (argv[0] === 'lsblk') return { code: 0, stdout: lsblk, stderr: '' }
      if (argv[1] === '-C') return { code: 0, stdout: argv[2] === '/dev/sda' ? ' drive state is:  active/idle\n' : ' drive state is:  standby\n', stderr: '' }
      if (argv[1] === '-B' && argv.length === 3) return { code: 0, stdout: ' APM_level\t= 128\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const p = new SystemPower(join(rulesDir, '69-quadeck-power.rules'), join(root, 'history'), exec, rulesDir, join(root, 'hdparm.conf'), '/usr/sbin/hdparm')
    return { root, rulesDir, calls, p }
  }

  it('state without waking: APM only for awake disks', async () => {
    const { calls, p } = setup()
    const s = await p.diskPower()
    expect(s.installed).toBe(true)
    expect(s.disks.map((d) => [d.name, d.state, d.apmNow, d.system])).toEqual([
      ['sda', 'active', 128, false],
      ['sdd', 'standby', undefined, true],
    ])
    expect(calls).not.toContain('/usr/sbin/hdparm -B /dev/sdd')
  })

  it('saves the rule, reloads udev, applies it now; removing turns standby off', async () => {
    const { rulesDir, calls, p } = setup()
    const s = await p.setDiskPower('ZRT0A1B2', { minutes: 30, apm: 'save' })
    const file = readFileSync(join(rulesDir, '69-quadeck-power.rules'), 'utf8')
    expect(file).toContain('ENV{ID_SERIAL_SHORT}=="ZRT0A1B2", RUN+="/usr/sbin/hdparm -B 127 -S 241 /dev/%k"')
    expect(calls).toContain('udevadm control --reload')
    expect(calls).toContain('/usr/sbin/hdparm -B 127 -S 241 /dev/sda')
    expect(s.disks.find((d) => d.name === 'sda')!.setting).toEqual({ minutes: 30, apm: 'save' })
    expect(await p.powerHistory()).toHaveLength(1)

    calls.length = 0
    await p.setDiskPower('ZRT0A1B2', null)
    expect(readFileSync(join(rulesDir, '69-quadeck-power.rules'), 'utf8')).not.toContain('ZRT0A1B2')
    expect(calls).toContain('/usr/sbin/hdparm -S 0 /dev/sda')
  })

  it('refuses the system disk, unknown serials, and shows foreign settings', async () => {
    const { root, rulesDir, p } = setup()
    await expect(p.setDiskPower('SYS', { minutes: 20, apm: 'disk' })).rejects.toMatchObject({ status: 409 })
    await expect(p.setDiskPower('NOPE', { minutes: 20, apm: 'disk' })).rejects.toMatchObject({ status: 404 })
    await expect(p.setDiskPower('a"b', { minutes: 20, apm: 'disk' })).rejects.toMatchObject({ status: 400 })
    writeFileSync(join(rulesDir, '50-mine.rules'), 'ACTION=="add", RUN+="/usr/bin/hdparm -S 120 /dev/%k"\n')
    writeFileSync(join(rulesDir, '60-net.rules'), 'SUBSYSTEM=="net"\n')
    writeFileSync(join(root, 'hdparm.conf'), '/dev/sdb {\n  spindown_time = 120\n}\n')
    expect((await p.diskPower()).foreign).toEqual([join(rulesDir, '50-mine.rules'), join(root, 'hdparm.conf')])
  })
})
