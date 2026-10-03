// Boot: systemd-boot via bootctl (entries, default, timeout, one-time entry,
// update of the loader on the ESP) and the reboot itself. Reads run in the
// helper; writes to EFI variables run through systemd-run, because the
// helper's own sandbox (ProtectKernelTunables) keeps /sys read-only.

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { msg } from '~/shared/i18n'
import { HttpError } from '../auth'
import { run } from '../exec'
import {
  ENTRY_ID,
  bootWarnings,
  decodeEfiString,
  isFlavor,
  kernelEntry,
  kernelEntryId,
  kernelInfos,
  loaderConfValue,
  parsePacmanQ,
  parseBootctlList,
  parseBootctlStatus,
  parseSystemdVersion,
  parseTimeout,
  type BootEntry,
  type BootState,
  type KernelFlavor,
} from '~/shared/boot'

export interface BootAdmin {
  bootState(): Promise<BootState>
  /** The entry Quadeck would write for an installed flavour without one. */
  kernelEntryPreview(pkg: string): Promise<{ path: string; content: string }>
}

/** Writes; the caller has checked the unlock. */
export interface BootBackend extends BootAdmin {
  setBootDefault(id: string): Promise<BootState>
  setBootTimeout(value: string): Promise<BootState>
  cancelOneshot(): Promise<BootState>
  updateBootLoader(): Promise<BootState>
  /** Reboots after a short delay (the answer still reaches the browser), optionally once into `entry` or the firmware setup. */
  reboot(opts: { entry?: string; firmware?: boolean }): Promise<{ at: number }>
  createKernelEntry(pkg: string): Promise<BootState>
  /** Only entries that point to missing files or were written by Quadeck, never the default or the running one. */
  removeBootEntry(id: string): Promise<BootState>
}

export const QUADECK_ENTRY = '# Created by Quadeck'
/** Entries written by versions before 0.4. */
const LEGACY_QUADECK_ENTRY = '# Angelegt von Quadeck'
const isQuadeckEntry = (content: string | undefined) => !!content && (content.startsWith(QUADECK_ENTRY) || content.startsWith(LEGACY_QUADECK_ENTRY))

/** Checks shared by the real machine and the demo. */
export function entryForFlavor(state: BootState, pkg: string, read: (p: string) => string | undefined, exists: (p: string) => boolean) {
  if (!isFlavor(pkg)) throw new HttpError(400, msg('boot_error_unknownKernel'))
  if (state.loader !== 'systemd-boot' || !state.canCreateEntries) throw new HttpError(409, msg('boot_error_entriesBySystem'))
  const k = state.kernels?.find((x) => x.pkg === pkg)
  if (!k?.installed) throw new HttpError(409, msg('boot_error_notInstalled', { pkg }))
  if (k.entries.length) throw new HttpError(409, msg('boot_error_alreadyHasEntry', { pkg }))
  const def = state.entries.find((e) => e.isDefault && e.type === 'type1' && e.path)
  const template = def?.path ? read(def.path) : undefined
  if (!def?.path || !template) throw new HttpError(409, msg('boot_error_noTemplateEntry'))
  const boot = state.boot?.path ?? dirname(dirname(dirname(def.path)))
  for (const f of [`/vmlinuz-${pkg}`, `/initramfs-${pkg}.img`]) if (!exists(join(boot, f))) throw new HttpError(409, msg('boot_error_imageMissing', { boot, file: f }))
  const dir = dirname(def.path)
  let path = join(dir, kernelEntryId(pkg as KernelFlavor))
  if (exists(path)) path = join(dir, `quadeck-${pkg}.conf`)
  return { path, content: kernelEntry(template, pkg as KernelFlavor) }
}

export function removableEntry(state: BootState, id: string, read: (p: string) => string | undefined) {
  if (!ENTRY_ID.test(id)) throw new HttpError(400, msg('boot_error_invalidEntry'))
  const e = state.entries.find((x) => x.id === id)
  if (!e) throw new HttpError(404, msg('boot_error_entryNotFound', { id }))
  if (e.type !== 'type1' || !e.path || !e.path.endsWith('.conf') || !/\/loader\/entries\/[^/]+$/.test(e.path)) throw new HttpError(409, msg('boot_error_notLoaderEntry'))
  if (e.isDefault || e.isSelected) throw new HttpError(409, msg('boot_error_entryInUse'))
  if (!e.missing.length && !isQuadeckEntry(read(e.path))) throw new HttpError(409, msg('boot_error_entryNotRemovable'))
  return e.path
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
  if (!ENTRY_ID.test(id)) throw new HttpError(400, msg('boot_error_invalidEntry'))
  if (!entries.some((e) => e.id === id)) throw new HttpError(404, msg('boot_error_entryNotFound', { id }))
}

export function assertTimeout(v: string) {
  if (!TIMEOUT_VALUE.test(v) || (/^\d+$/.test(v) && Number(v) > 600)) throw new HttpError(400, msg('boot_error_invalidTimeout'))
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
    let kernels: BootState['kernels']
    if (Bun.which('pacman')) {
      const q = await run(['pacman', '-Q', 'linux', 'linux-lts', 'linux-zen', 'linux-hardened'])
      kernels = kernelInfos(parsePacmanQ(q.stdout), release(), entries)
    }
    const def = entries.find((e) => e.isDefault)
    const state: Omit<BootState, 'warnings'> = {
      ...base,
      ...info,
      kernels,
      dkms: !!Bun.which('dkms'),
      canCreateEntries: !!kernels && def?.type === 'type1' && !!def.path && /^\/vmlinuz-/.test(def.linux ?? ''),
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
    if (s.loader !== 'systemd-boot') throw new HttpError(409, msg('boot_error_noSystemdBoot'))
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

  async kernelEntryPreview(pkg: string) {
    return entryForFlavor(await this.bootState(), pkg, read, existsSync)
  }

  async createKernelEntry(pkg: string) {
    const { path, content } = entryForFlavor(await this.bootState(), pkg, read, existsSync)
    const tmp = `${path}.quadeck-tmp`
    writeFileSync(tmp, content, { mode: 0o644 })
    renameSync(tmp, path)
    return this.bootState()
  }

  async removeBootEntry(id: string) {
    rmSync(removableEntry(await this.bootState(), id, read), { force: true })
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
  private state: Omit<BootState, 'warnings'> & { entryFiles?: Record<string, string> }
  /** Reboots the demo pretended to do. */
  reboots: { entry?: string; firmware?: boolean }[] = []

  /** `installed`: the demo's package list (kernels come and go with the package jobs). */
  constructor(
    dir: string,
    private installed: () => Promise<Map<string, string>> = async () => new Map([['linux', '6.10.1.arch1-1']]),
  ) {
    this.state = JSON.parse(read(join(dir, 'boot.json')) ?? '{"loader":"unknown","entries":[],"firmwareSetup":false,"cmdline":""}') as Omit<BootState, 'warnings'>
  }

  private files = () => this.state.entryFiles ?? {}

  async bootState(): Promise<BootState> {
    const inst = await this.installed()
    const entries = this.state.entries.map((e) => {
      const pkg = e.linux?.replace(/^\/vmlinuz-/, '')
      const missing = e.type === 'type1' && pkg && !inst.has(pkg) ? [e.linux!, ...e.initrd.filter((i) => !/ucode/.test(i))] : e.missing
      return { ...e, isOneshot: e.id === this.state.oneshot, missing }
    })
    const kernels = this.state.loader === 'systemd-boot' ? kernelInfos(inst, '6.10.1-arch1-1', entries) : undefined
    const s = { ...this.state, entryFiles: undefined, entries, kernels, dkms: false, canCreateEntries: !!kernels }
    return { ...s, warnings: bootWarnings(s) }
  }

  async kernelEntryPreview(pkg: string) {
    const inst = await this.installed()
    return entryForFlavor(
      await this.bootState(),
      pkg,
      (p) => this.files()[p],
      (p) => (p.includes('/vmlinuz-') || p.includes('/initramfs-') ? inst.has(p.replace(/^.*\/(vmlinuz|initramfs)-/, '').replace(/\.img$/, '')) : !!this.files()[p]),
    )
  }

  async createKernelEntry(pkg: string) {
    const { path, content } = await this.kernelEntryPreview(pkg)
    this.state.entryFiles = { ...this.files(), [path]: content }
    const version = (await this.installed()).get(pkg)
    const id = path.split('/').pop()!
    this.state.entries = [
      ...this.state.entries.filter((e) => e.type !== 'auto'),
      {
        id,
        path,
        title: `Arch Linux (${pkg})`,
        version: version?.replace(/\.(\w+)-/, '-$1-'),
        type: 'type1',
        linux: `/vmlinuz-${pkg}`,
        initrd: ['/intel-ucode.img', `/initramfs-${pkg}.img`],
        isDefault: false,
        isSelected: false,
        isOneshot: false,
        missing: [],
        size: 90_000_000,
      },
      ...this.state.entries.filter((e) => e.type === 'auto'),
    ]
    return this.bootState()
  }

  async removeBootEntry(id: string) {
    const path = removableEntry(await this.bootState(), id, (p) => this.files()[p])
    this.state.entries = this.state.entries.filter((e) => e.path !== path)
    return this.bootState()
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
