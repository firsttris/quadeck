// SMART via smartctl (root): all physical disks, cached; self-tests on demand.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SmartDisk, SmartReport } from '~/shared/smart'
import { HttpError } from '../auth'
import { run, runOk } from '../exec'
import { parseSmartctl, physicalDisks } from './parse'

export type SelfTestType = 'short' | 'long'

export interface SmartAdmin {
  smartReport(refresh: boolean): Promise<SmartReport>
}

export interface SmartBackend extends SmartAdmin {
  smartSelfTest(disk: string, type: SelfTestType): Promise<SmartReport>
}

const TTL = 15 * 60_000
const MIN_REFRESH = 30_000
export const DISK_NAME = /^[a-z][a-z0-9]{1,15}$/

export class SystemSmart implements SmartBackend {
  private cache?: SmartReport
  private inflight?: Promise<SmartReport>

  private async disks() {
    return physicalDisks(await runOk(['lsblk', '-d', '-J', '-o', 'NAME,TYPE'], { timeoutMs: 10_000 }))
  }

  private async collect(): Promise<SmartReport> {
    if (!Bun.which('smartctl')) return { checkedAt: Date.now(), disks: [], installed: false, error: 'smartctl ist nicht installiert (Paket smartmontools)' }
    const names = await this.disks()
    const disks: SmartDisk[] = []
    // A few at a time: smartctl can take a second per disk.
    for (let i = 0; i < names.length; i += 4) {
      const batch = await Promise.all(
        names.slice(i, i + 4).map(async (n) => {
          // -n standby: never spin up a sleeping disk just to read it.
          const r = await run(['smartctl', '--json=c', '-a', '-n', 'standby', `/dev/${n}`], { timeoutMs: 60_000 })
          return parseSmartctl(n, r.stdout)
        }),
      )
      disks.push(...batch)
    }
    return { checkedAt: Date.now(), disks, installed: true }
  }

  async smartReport(refresh: boolean) {
    const c = this.cache
    // Not installed is not cached: the page asks again right after the install job.
    if (c?.installed && Date.now() - c.checkedAt < (refresh ? MIN_REFRESH : TTL)) return c
    this.inflight ??= this.collect()
      .then((r) => (this.cache = r))
      .finally(() => (this.inflight = undefined))
    return this.inflight
  }

  async smartSelfTest(disk: string, type: SelfTestType) {
    if (!DISK_NAME.test(disk) || !(await this.disks()).includes(disk)) throw new HttpError(404, `Unbekannte Platte: ${disk}`)
    const r = await run(['smartctl', '-t', type, `/dev/${disk}`], { timeoutMs: 30_000 })
    // Exit bits 0/1 = could not even send the command.
    if (r.code & 3) throw new HttpError(422, `smartctl -t ${type}: ${(r.stdout + r.stderr).trim().split('\n').slice(-2).join(' ')}`)
    this.cache = undefined
    return this.smartReport(true)
  }
}

/** Demo: captured smartctl JSON in fixtures/demo/smart/<disk>.json. */
export class FixtureSmart implements SmartBackend {
  private disks: SmartDisk[]
  constructor(dir: string) {
    const d = join(dir, 'smart')
    this.disks = existsSync(d)
      ? readdirSync(d)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => parseSmartctl(f.replace(/\.json$/, ''), readFileSync(join(d, f), 'utf8')))
      : []
  }
  async smartReport() {
    return { checkedAt: Date.now(), disks: structuredClone(this.disks), installed: true }
  }
  async smartSelfTest(disk: string, type: SelfTestType) {
    const d = this.disks.find((x) => x.name === disk)
    if (!d) throw new HttpError(404, `Unbekannte Platte: ${disk}`)
    if (!d.supported || d.standby) throw new HttpError(422, `${disk} kann gerade keinen Selbsttest ausführen`)
    d.testRunning = type === 'short' ? 90 : 99
    return this.smartReport()
  }
}
