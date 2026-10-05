// Disk collector: block devices from `lsblk -J -b`, usage via statfs, drive
// temperatures from the kernel's drivetemp/nvme hwmon sensors.

import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SmartDisk, TempSensorGap } from '~/shared/smart'
import type { Disk } from '~/shared/types'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { runOk } from '../exec'

interface LsblkDev {
  name: string
  path?: string
  type: string
  size: number | string | null
  fstype?: string | null
  mountpoint?: string | null
  mountpoints?: (string | null)[]
  pkname?: string | null
  children?: LsblkDev[]
}

export interface MountedFs {
  dev: string // whole-disk kernel name (sda, nvme0n1, md0 …)
  path: string // device node of the filesystem
  mount: string
  fstype: string
  size: number
  /** The physical disks underneath (several for RAID, LVM over more than one disk). */
  disks: string[]
}

const SKIP_FS = new Set(['swap', 'squashfs', 'iso9660', 'vfat', 'erofs'])
const SKIP_MOUNT = /^(\/boot|\/efi|\/snap\/|\/var\/lib\/containers|\/run\/|\[SWAP\])/

/** Flattens lsblk output to one entry per mounted filesystem (shortest mountpoint wins, e.g. btrfs subvolumes). */
export function parseLsblk(json: string): MountedFs[] {
  const data = JSON.parse(json) as { blockdevices?: LsblkDev[] }
  const out = new Map<string, MountedFs>()
  const walk = (d: LsblkDev, disk: string, phys: string[]) => {
    if (d.type === 'disk') phys = [d.name]
    const whole = d.type === 'disk' || d.type === 'raid1' || d.type.startsWith('raid') || d.type === 'md' ? d.name : disk
    const mounts = (d.mountpoints ?? [d.mountpoint]).filter((m): m is string => !!m && !SKIP_MOUNT.test(m))
    const fstype = d.fstype ?? ''
    if (mounts.length && !SKIP_FS.has(fstype) && d.type !== 'loop' && d.type !== 'rom') {
      const mount = mounts.sort((a, b) => a.length - b.length)[0]!
      const path = d.path ?? `/dev/${d.name}`
      const prev = out.get(path)
      // a RAID or LVM volume shows up under each of its disks: collect them
      const disks = [...new Set([...(prev?.disks ?? []), ...phys])]
      if (!prev || mount.length < prev.mount.length) out.set(path, { dev: whole || d.name, path, mount, fstype, size: Number(d.size) || 0, disks })
      else prev.disks = disks
    }
    for (const c of d.children ?? []) walk(c, whole || d.name, phys)
  }
  for (const d of data.blockdevices ?? []) walk(d, d.name, [])
  return [...out.values()].sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)))
}

export function diskRole(mount: string): string {
  if (mount === '/' || mount === '/sysroot' || mount === '/var' || mount === '/home') return 'System'
  if (/parit/i.test(mount)) return msg(m.disks_label_parity)
  return msg(m.disks_label_data)
}

/** Maps whole-disk names (sda, nvme0n1) to their temperature in °C. */
function readDriveTemps(): Map<string, number> {
  const temps = new Map<string, number>()
  let hwmons: string[] = []
  try {
    hwmons = readdirSync('/sys/class/hwmon')
  } catch {
    return temps
  }
  for (const h of hwmons) {
    const base = `/sys/class/hwmon/${h}`
    try {
      const name = readFileSync(`${base}/name`, 'utf8').trim()
      const t = Number(readFileSync(`${base}/temp1_input`, 'utf8')) / 1000
      if (!(t > 0)) continue
      if (name === 'drivetemp') {
        for (const b of readdirSync(`${base}/device/block`)) temps.set(b, t)
      } else if (name === 'nvme') {
        const ctrl = basename(readlinkSync(`${base}/device`)) // nvme0
        for (const b of readdirSync('/sys/block').filter((x) => x.startsWith(ctrl + 'n'))) temps.set(b, t)
      }
    } catch {
      // sensor without block mapping
    }
  }
  return temps
}

export async function collectDisks(): Promise<Disk[]> {
  const json = await runOk(['lsblk', '-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINTS,PKNAME']).catch(() => runOk(['lsblk', '-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,PKNAME']))
  const temps = readDriveTemps()
  // all file systems at once: one slow mount does not hold up the others
  const all = await Promise.all(
    parseLsblk(json).map(async (fs): Promise<Disk | undefined> => {
      try {
        const s = await statfs(fs.mount)
        return { dev: fs.dev, path: fs.path, mount: fs.mount, fstype: fs.fstype, size: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize, tempC: temps.get(fs.dev), role: diskRole(fs.mount), disks: fs.disks.length ? fs.disks : [fs.dev] }
      } catch {
        return undefined
      }
    }),
  )
  return all.filter((d): d is Disk => !!d)
}

/** The kernel sensor wins; SMART fills in when there is none and the reading is at most 2 hours old. */
export function withSmartTemp(d: Disk, smart: { tempC: number; at: number } | undefined, now = Date.now()): Disk {
  if (d.tempC !== undefined || !smart || now - smart.at > 2 * 3600_000) return d
  return { ...d, tempC: smart.tempC, tempFromSmart: true }
}

/** SATA/SAS disks whose temperature only comes from SMART; undefined when there are none. */
export function tempSensorGap(disks: Pick<SmartDisk, 'name' | 'protocol' | 'temperature'>[], sensors: Set<string>, drivetempLoaded: boolean): TempSensorGap | undefined {
  const without = disks.filter((d) => d.protocol !== 'NVMe' && d.temperature !== undefined && !sensors.has(d.name)).map((d) => d.name)
  return without.length ? { disks: without, drivetempLoaded } : undefined
}

export function hostTempSensorGap(disks: SmartDisk[]): TempSensorGap | undefined {
  return tempSensorGap(disks, new Set(readDriveTemps().keys()), existsSync('/sys/module/drivetemp'))
}
