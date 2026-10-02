// Boot: systemd-boot via bootctl (entries, default, timeout, one-time entry,
// update of the loader on the ESP) and the reboot itself. Reads run in the
// helper; writes to EFI variables run through systemd-run, because the
// helper's own sandbox (ProtectKernelTunables) keeps /sys read-only.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { HttpError } from '../auth'
import { run } from '../exec'
import {
  ENTRY_ID,
  bootWarnings,
  decodeEfiString,
  loaderConfValue,
  parseBootctlList,
  parseBootctlStatus,
  parseSystemdVersion,
  parseTimeout,
  type BootEntry,
  type BootState,
} from '~/shared/boot'

export interface BootAdmin {
  bootState(): Promise<BootState>
}

/** Writes; the caller has checked the unlock. */
export interface BootBackend extends BootAdmin {
  setBootDefault(id: string): Promise<BootState>
  setBootTimeout(value: string): Promise<BootState>
  cancelOneshot(): Promise<BootState>
  updateBootLoader(): Promise<BootState>
  /** Reboots after a short delay (the answer still reaches the browser), optionally once into `entry` or the firmware setup. */
  reboot(opts: { entry?: string; firmware?: boolean }): Promise<{ at: number }>
}

export const TIMEOUT_VALUE = /^(menu-force|menu-hidden|\d{1,3})$/
const LOADER_GUID = '4a67b082-0a4c-41cf-b6c7-440b29bb8c4f'
const REBOOT_DELAY_MS = 1500

function efiVar(name: string): string | undefined {
  try {
    return decodeEfiString(readFileSync(`/sys/firmware/efi/efivars/${name}-${LOADER_GUID}`)) || undefined
  } catch {
    return undefined
  }
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

export function assertEntry(id: string, entries: BootEntry[]) {
  if (!ENTRY_ID.test(id)) throw new HttpError(400, 'Ungültiger Eintrag')
  if (!entries.some((e) => e.id === id)) throw new HttpError(404, `Eintrag ${id} gibt es nicht`)
}

export function assertTimeout(v: string) {
  if (!TIMEOUT_VALUE.test(v) || (/^\d+$/.test(v) && Number(v) > 600)) throw new HttpError(400, 'Timeout: Sekunden (0–600), menu-hidden oder menu-force')
}

export class SystemBoot implements BootBackend {
  private async bootctl(args: string[]) {
    return run(['bootctl', '--no-pager', ...args], { timeoutMs: 30_000 })
  }

  /** bootctl outside the helper's sandbox: EFI variables live in the read-only /sys. */
  private async bootctlWrite(args: string[]) {
    const viaSystemd = existsSync('/run/systemd/system') && !!Bun.which('systemd-run')
    const argv = viaSystemd ? ['systemd-run', '--wait', '--pipe', '--quiet', '--collect', '--property=Type=exec', '--description=Quadeck: bootctl', '--', 'bootctl', ...args] : ['bootctl', ...args]
    const r = await run(argv, { timeoutMs: 60_000 })
    if (r.code !== 0) throw new HttpError(422, `bootctl ${args.join(' ')}: ${(r.stderr || r.stdout).trim() || `Exit ${r.code}`}`)
  }

  private async loader(): Promise<BootState['loader']> {
    if (Bun.which('bootctl') && (await this.bootctl(['is-installed'])).code === 0) return 'systemd-boot'
    if (['/boot/grub/grub.cfg', '/boot/grub2/grub.cfg', '/boot/efi/EFI/fedora/grub.cfg'].some((p) => existsSync(p))) return 'grub'
    return 'unknown'
  }

  async bootState(): Promise<BootState> {
    const cmdline = (read('/proc/cmdline') ?? '').trim()
    const loader = await this.loader()
    const base = { loader, entries: [] as BootEntry[], firmwareSetup: false, cmdline }
    if (loader !== 'systemd-boot') return { ...base, warnings: [] }
    const [status, version, list, bootPath, espPath] = await Promise.all([
      this.bootctl(['status']),
      run(['bootctl', '--version']),
      this.bootctl(['list', '--json=short']),
      this.bootctl(['--print-boot-path']),
      this.bootctl(['--print-esp-path']),
    ])
    const info = parseBootctlStatus(`${status.stdout}\n${status.stderr}`)
    const boot = bootPath.stdout.trim() || espPath.stdout.trim()
    const esp = espPath.stdout.trim() || boot
    const oneshot = efiVar('LoaderEntryOneShot')
    const entries: BootEntry[] = parseBootctlList(list.stdout, oneshot).map(({ root, ...e }) => {
      const files = e.type === 'type1' ? [e.linux, ...e.initrd].filter((f): f is string => !!f) : []
      const dir = root || boot
      const missing = files.filter((f) => !existsSync(join(dir, f)))
      const size = files.reduce((n, f) => {
        try {
          return n + statSync(join(dir, f)).size
        } catch {
          return n
        }
      }, 0)
      return { ...e, missing, size: size || undefined }
    })
    let fs: BootState['boot']
    try {
      const s = await statfs(boot)
      fs = { path: boot, size: s.blocks * s.bsize, free: s.bavail * s.bsize }
    } catch {
      fs = undefined
    }
    const efiTimeout = efiVar('LoaderConfigTimeout')
    const confTimeout = loaderConfValue(read(join(esp, 'loader/loader.conf')) ?? '', 'timeout')
    const state: Omit<BootState, 'warnings'> = {
      ...base,
      ...info,
      packageVersion: parseSystemdVersion(version.stdout),
      boot: fs,
      timeout: parseTimeout(efiTimeout ?? confTimeout),
      timeoutSource: efiTimeout !== undefined ? 'efi' : confTimeout !== undefined ? 'loader.conf' : 'default',
      entries,
      oneshot,
      error: list.code !== 0 ? `bootctl list: ${list.stderr.trim()}` : undefined,
    }
    return { ...state, warnings: bootWarnings(state) }
  }

  private async systemdBoot() {
    const s = await this.bootState()
    if (s.loader !== 'systemd-boot') throw new HttpError(409, 'Kein systemd-boot – Quadeck ändert hier nur systemd-boot')
    return s
  }

  async setBootDefault(id: string) {
    assertEntry(id, (await this.systemdBoot()).entries)
    await this.bootctlWrite(['set-default', id])
    return this.bootState()
  }

  async setBootTimeout(value: string) {
    assertTimeout(value)
    await this.systemdBoot()
    await this.bootctlWrite(['set-timeout', value])
    return this.bootState()
  }

  async cancelOneshot() {
    await this.systemdBoot()
    await this.bootctlWrite(['set-oneshot', ''])
    return this.bootState()
  }

  async updateBootLoader() {
    await this.systemdBoot()
    await this.bootctlWrite(['update', '--graceful'])
    return this.bootState()
  }

  async reboot(opts: { entry?: string; firmware?: boolean }) {
    if (opts.entry) {
      assertEntry(opts.entry, (await this.systemdBoot()).entries)
      await this.bootctlWrite(['set-oneshot', opts.entry])
    }
    const argv = ['systemctl', 'reboot', ...(opts.firmware ? ['--firmware-setup'] : [])]
    const at = Date.now() + REBOOT_DELAY_MS
    setTimeout(() => void run(argv, { timeoutMs: 30_000 }), REBOOT_DELAY_MS)
    return { at }
  }
}

// ---------- demo fixtures ----------

export class FixtureBoot implements BootBackend {
  private state: Omit<BootState, 'warnings'>
  /** Reboots the demo pretended to do. */
  reboots: { entry?: string; firmware?: boolean }[] = []

  constructor(dir: string) {
    this.state = JSON.parse(read(join(dir, 'boot.json')) ?? '{"loader":"unknown","entries":[],"firmwareSetup":false,"cmdline":""}') as Omit<BootState, 'warnings'>
  }

  async bootState(): Promise<BootState> {
    const entries = this.state.entries.map((e) => ({ ...e, isOneshot: e.id === this.state.oneshot }))
    const s = { ...this.state, entries }
    return { ...s, warnings: bootWarnings(s) }
  }

  async setBootDefault(id: string) {
    assertEntry(id, this.state.entries)
    this.state.entries = this.state.entries.map((e) => ({ ...e, isDefault: e.id === id }))
    return this.bootState()
  }

  async setBootTimeout(value: string) {
    assertTimeout(value)
    this.state.timeout = parseTimeout(value)
    this.state.timeoutSource = 'efi'
    return this.bootState()
  }

  async cancelOneshot() {
    this.state.oneshot = undefined
    return this.bootState()
  }

  async updateBootLoader() {
    this.state.espVersion = this.state.packageVersion
    return this.bootState()
  }

  async reboot(opts: { entry?: string; firmware?: boolean }) {
    if (opts.entry) {
      assertEntry(opts.entry, this.state.entries)
      this.state.oneshot = opts.entry
    }
    this.reboots.push(opts)
    return { at: Date.now() + REBOOT_DELAY_MS }
  }
}
