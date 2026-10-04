// Energy saving for hard disks (root): state and APM via hdparm, the standby time as a udev rule
// per serial number (/etc/udev/rules.d/69-quadeck-power.rules) with a history, applied right away.

import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { msg } from '~/shared/i18n'
import { SERIAL, hdparmArgs, parseHdparmApm, parseHdparmState, parsePowerRules, powerRules, type DiskPower, type PowerSetting, type PowerState } from '~/shared/power'
import { HttpError } from '../auth'
import { run, type ExecResult } from '../exec'
import { UnitHistory } from '../systemd/editor'
import type { Revision } from '~/shared/quadlets'

export interface PowerAdmin {
  diskPower(): Promise<PowerState>
  /** Processes (and their units) with files open on a disk's mounts: what keeps it awake now. */
  diskUsers(name: string): Promise<DiskUser[]>
  powerHistory(): Promise<Revision[]>
}

/** Writes; the caller has checked the unlock. */
export interface PowerBackend extends PowerAdmin {
  setDiskPower(serial: string, setting: PowerSetting | null): Promise<PowerState>
}

export interface DiskUser {
  command: string
  /** systemd unit (or container) the process belongs to. */
  unit?: string
  files: number
}

type Exec = (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>

interface LsblkNode {
  name: string
  type?: string
  rota?: boolean | string | number
  tran?: string | null
  serial?: string | null
  model?: string | null
  fstype?: string | null
  mountpoints?: (string | null)[]
  mountpoint?: string | null
  children?: LsblkNode[]
}

const SYSTEM_MOUNTS = new Set(['/', '/boot', '/boot/efi', '/efi', '/var', '/usr', '/home', '[SWAP]'])
const yes = (v: LsblkNode['rota']) => v === true || v === 1 || v === '1' || v === 'true'

/** Spinning disks from `lsblk -J -o NAME,TYPE,ROTA,TRAN,SERIAL,MODEL,FSTYPE,MOUNTPOINTS`. */
export function parseLsblkDisks(json: string): Omit<DiskPower, 'state' | 'apmNow' | 'setting'>[] {
  let nodes: LsblkNode[] = []
  try {
    nodes = (JSON.parse(json) as { blockdevices?: LsblkNode[] }).blockdevices ?? []
  } catch {
    return []
  }
  const walk = (n: LsblkNode): LsblkNode[] => [n, ...(n.children ?? []).flatMap(walk)]
  return nodes
    .filter((n) => n.type === 'disk' && yes(n.rota) && /^sd[a-z]+$|^hd[a-z]+$/.test(n.name))
    .map((n) => {
      const all = walk(n)
      const mounts = [...new Set(all.flatMap((x) => [...(x.mountpoints ?? []), x.mountpoint]).filter((m): m is string => !!m))]
      return {
        name: n.name,
        ...(n.serial?.trim() ? { serial: n.serial.trim().replace(/\s+/g, '_') } : {}),
        ...(n.model?.trim() ? { model: n.model.trim() } : {}),
        usb: n.tran === 'usb',
        system: mounts.some((m) => SYSTEM_MOUNTS.has(m)),
        raid: all.some((x) => x.fstype === 'linux_raid_member' || /^raid/.test(x.type ?? '')),
        mounts,
      }
    })
}

/** Processes with files (or their working directory) below one of the mounts. */
export function processesOn(mounts: string[], proc = '/proc'): DiskUser[] {
  const under = (p: string) => mounts.some((m) => m !== '/' && (p === m || p.startsWith(m + '/')))
  const byKey = new Map<string, DiskUser>()
  let pids: string[] = []
  try {
    pids = readdirSync(proc).filter((p) => /^\d+$/.test(p))
  } catch {
    return []
  }
  for (const pid of pids) {
    let files = 0
    try {
      for (const fd of readdirSync(join(proc, pid, 'fd'))) {
        try {
          if (under(readlinkSync(join(proc, pid, 'fd', fd)))) files++
        } catch {
          // closed meanwhile
        }
      }
      if (under(readlinkSync(join(proc, pid, 'cwd')))) files++
    } catch {
      continue // gone, or not ours to read
    }
    if (!files) continue
    let command = pid
    let unit: string | undefined
    try {
      command = readFileSync(join(proc, pid, 'comm'), 'utf8').trim()
      const cg = readFileSync(join(proc, pid, 'cgroup'), 'utf8')
      unit = /\/([^/]+\.service)(?:\/|$)/m.exec(cg)?.[1] ?? (/libpod-([0-9a-f]{12})/.exec(cg)?.[1] ? `container ${/libpod-([0-9a-f]{12})/.exec(cg)![1]}` : undefined)
    } catch {
      // keep what we have
    }
    const key = `${command}|${unit ?? ''}`
    const u = byKey.get(key)
    if (u) u.files += files
    else byKey.set(key, { command, ...(unit ? { unit } : {}), files })
  }
  return [...byKey.values()].sort((a, b) => b.files - a.files)
}

export class SystemPower implements PowerBackend {
  private history: UnitHistory

  constructor(
    private rulesPath = process.env.QUADECK_POWER_RULES || '/etc/udev/rules.d/69-quadeck-power.rules',
    historyDir = process.env.QUADECK_POWER_HISTORY || '/var/lib/quadeck-helper/power-history',
    private exec: Exec = run,
    private rulesDir = '/etc/udev/rules.d',
    private hdparmConf = '/etc/hdparm.conf',
    private hdparmBin?: string,
  ) {
    this.history = new UnitHistory(historyDir)
  }

  private hdparm() {
    return this.hdparmBin ?? Bun.which('hdparm')
  }

  private rules(): Record<string, PowerSetting> {
    try {
      return parsePowerRules(readFileSync(this.rulesPath, 'utf8'))
    } catch {
      return {}
    }
  }

  private foreign(): string[] {
    const out: string[] = []
    try {
      for (const f of readdirSync(this.rulesDir)) {
        const p = join(this.rulesDir, f)
        if (p === this.rulesPath || !f.endsWith('.rules')) continue
        try {
          if (/hdparm[^\n]*-S|spindown|hd-idle/i.test(readFileSync(p, 'utf8'))) out.push(p)
        } catch {
          // unreadable
        }
      }
    } catch {
      // no rules dir
    }
    try {
      if (/^\s*spindown_time\s*=/m.test(readFileSync(this.hdparmConf, 'utf8'))) out.push(this.hdparmConf)
    } catch {
      // none
    }
    return out
  }

  async diskPower(): Promise<PowerState> {
    const r = await this.exec(['lsblk', '-J', '-o', 'NAME,TYPE,ROTA,TRAN,SERIAL,MODEL,FSTYPE,MOUNTPOINTS'], { timeoutMs: 10_000 })
    const hd = this.hdparm()
    const rules = this.rules()
    const disks: DiskPower[] = []
    for (const d of parseLsblkDisks(r.stdout)) {
      let state: DiskPower['state'] = 'unknown'
      let apmNow: DiskPower['apmNow']
      if (hd) {
        // -C asks the drive without waking it; -B only while it is awake anyway.
        state = parseHdparmState((await this.exec([hd, '-C', `/dev/${d.name}`], { timeoutMs: 10_000 })).stdout)
        if (state === 'active') apmNow = parseHdparmApm((await this.exec([hd, '-B', `/dev/${d.name}`], { timeoutMs: 10_000 })).stdout)
      }
      disks.push({ ...d, state, ...(apmNow !== undefined ? { apmNow } : {}), ...(d.serial && rules[d.serial] ? { setting: rules[d.serial] } : {}) })
    }
    return { installed: !!hd, rulesPath: this.rulesPath, foreign: this.foreign(), disks }
  }

  async diskUsers(name: string) {
    const disk = (await this.diskPower()).disks.find((d) => d.name === name)
    if (!disk) throw new HttpError(404, msg('power_error_unknownDisk', { disk: name }))
    return processesOn(disk.mounts)
  }

  async powerHistory() {
    return this.history.list(this.rulesPath)
  }

  async setDiskPower(serial: string, setting: PowerSetting | null) {
    const hd = this.hdparm()
    if (!hd) throw new HttpError(409, msg('power_error_noHdparm'))
    if (!SERIAL.test(serial)) throw new HttpError(400, msg('power_error_unknownDisk', { disk: serial }))
    const state = await this.diskPower()
    const disk = state.disks.find((d) => d.serial === serial)
    if (!disk) throw new HttpError(404, msg('power_error_unknownDisk', { disk: serial }))
    if (setting && disk.system) throw new HttpError(409, msg('power_error_system', { disk: disk.name }))
    if (setting && disk.raid) throw new HttpError(409, msg('power_error_raid', { disk: disk.name }))
    const before = existsSync(this.rulesPath) ? readFileSync(this.rulesPath, 'utf8') : ''
    const rules = this.rules()
    if (setting) rules[serial] = setting
    else delete rules[serial]
    const after = powerRules(rules, hd)
    if (before && !this.history.list(this.rulesPath).length) this.history.add(this.rulesPath, before, 'original')
    writeFileSync(this.rulesPath, after, { mode: 0o644 })
    this.history.add(this.rulesPath, after, 'saved')
    await this.exec(['udevadm', 'control', '--reload'], { timeoutMs: 15_000 })
    // Right away, not only at the next boot. Without a rule: no standby timer any more.
    const a = await this.exec([hd, ...hdparmArgs(setting ?? { minutes: 0, apm: 'disk' }), `/dev/${disk.name}`], { timeoutMs: 20_000 })
    if (a.code !== 0) throw new HttpError(422, msg('power_error_apply', { disk: disk.name, message: a.stderr.trim() || a.stdout.trim() }))
    return this.diskPower()
  }
}

// ---------- demo ----------

export class FixturePower implements PowerBackend {
  private settings: Record<string, PowerSetting> = { ZRT0A1B2: { minutes: 20, apm: 'disk' }, X1Z0A0B0FVGG: { minutes: 30, apm: 'save' }, ZL2PRTY9: { minutes: 20, apm: 'disk' } }
  private hist: Revision[] = [{ id: '1-0', date: Date.now() - 40 * 86_400_000, message: 'saved' }]

  private base(): Omit<DiskPower, 'setting'>[] {
    return [
      { name: 'sda', serial: 'ZRT0A1B2', model: 'ST12000VN0008-2YS101', usb: false, system: false, raid: false, state: 'active', apmNow: 254, mounts: ['/mnt/disk1'] },
      { name: 'sdb', serial: '5QG3KLMN', model: 'WDC WD120EFBX-68B0EN0', usb: false, system: false, raid: false, state: 'active', apmNow: 'off', mounts: ['/mnt/disk2'] },
      { name: 'sdc', serial: 'X1Z0A0B0FVGG', model: 'TOSHIBA MG08ACA14TE', usb: false, system: false, raid: false, state: 'active', apmNow: 127, mounts: ['/mnt/disk3'] },
      { name: 'sdd', serial: 'ZL2PRTY9', model: 'ST14000NM001G', usb: true, system: false, raid: false, state: 'standby', mounts: ['/mnt/parity1'] },
    ]
  }

  async diskPower(): Promise<PowerState> {
    return { installed: true, rulesPath: '/etc/udev/rules.d/69-quadeck-power.rules', foreign: [], disks: this.base().map((d) => ({ ...d, ...(d.serial && this.settings[d.serial] ? { setting: this.settings[d.serial] } : {}) })) }
  }

  async diskUsers(name: string): Promise<DiskUser[]> {
    if (name === 'sdb') return [{ command: 'jellyfin', unit: 'jellyfin.service', files: 14 }, { command: 'smbd', unit: 'smb.service', files: 2 }]
    if (name === 'sda') return [{ command: 'immich', unit: 'immich.service', files: 3 }]
    return []
  }

  async powerHistory() {
    return this.hist
  }

  async setDiskPower(serial: string, setting: PowerSetting | null) {
    if (!this.base().some((d) => d.serial === serial)) throw new HttpError(404, msg('power_error_unknownDisk', { disk: serial }))
    if (setting) this.settings[serial] = setting
    else delete this.settings[serial]
    this.hist.unshift({ id: `${Date.now()}-0`, date: Date.now(), message: 'saved' })
    return this.diskPower()
  }
}
