import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diskRole, parseLsblk, withSmartTemp } from '~/server/collectors/disks'

describe('lsblk', () => {
  const fs = parseLsblk(readFileSync(new URL('./fixtures/lsblk.json', import.meta.url), 'utf8'))

  it('keeps one entry per mounted filesystem, root first, skipping boot/efi/swap/loop', () => {
    expect(fs.map((f) => f.mount)).toEqual(['/', '/mnt/disk1', '/mnt/parity1'])
  })

  it('maps partitions to their whole disk', () => {
    expect(fs.find((f) => f.mount === '/')).toMatchObject({ dev: 'nvme0n1', path: '/dev/nvme0n1p3', fstype: 'btrfs' })
    expect(fs.find((f) => f.mount === '/mnt/disk1')!.dev).toBe('sda')
    expect(fs.find((f) => f.mount === '/mnt/parity1')!.dev).toBe('sdd')
  })

  it('accepts the old single MOUNTPOINT column', () => {
    const old = parseLsblk(JSON.stringify({ blockdevices: [{ name: 'sdb', type: 'disk', size: '10', fstype: 'ext4', mountpoint: '/data' }] }))
    expect(old).toEqual([{ dev: 'sdb', path: '/dev/sdb', mount: '/data', fstype: 'ext4', size: 10 }])
  })

  it('derives roles from mountpoints', () => {
    expect(diskRole('/')).toBe('System')
    expect(diskRole('/mnt/parity1')).toBe('Parität')
    expect(diskRole('/mnt/disk2')).toBe('Daten')
  })
})

describe('disk temperature from SMART', () => {
  const disk = { dev: 'sdb', path: '/dev/sdb1', mount: '/mnt/data', fstype: 'ext4', size: 1, used: 0, role: 'data' }
  it('fills in only without a kernel sensor and while the reading is fresh', () => {
    const now = 10 * 3600_000
    expect(withSmartTemp(disk, { tempC: 34, at: now - 1800_000 }, now)).toMatchObject({ tempC: 34, tempFromSmart: true })
    expect(withSmartTemp({ ...disk, tempC: 40 }, { tempC: 34, at: now }, now)).toEqual({ ...disk, tempC: 40 })
    expect(withSmartTemp(disk, { tempC: 34, at: now - 3 * 3600_000 }, now)).toBe(disk)
    expect(withSmartTemp(disk, undefined, now)).toBe(disk)
  })
})
