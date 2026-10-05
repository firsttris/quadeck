// Boot: systemd-boot via bootctl (entries, default, timeout, one-time entry,
// update of the loader on the ESP) and the reboot itself. Reads run in the
// helper; writes to EFI variables run through systemd-run, because the
// helper's own sandbox (ProtectKernelTunables) keeps /sys read-only.

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { writeFileAtomic } from '../atomic'
import { contentHash } from '~/shared/caddy'
import type { Revision } from '~/shared/quadlets'
import { release } from 'node:os'
import { statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { HttpError } from '../auth'
import { run } from '../exec'
import { UnitHistory } from '../systemd/editor'
import {
  ENTRY_FILE,
  ENTRY_ID,
  checkEntryConf,
  entryFromConf,
  isEditableEntry,
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
  type BootEntryChange,
  type BootEntryFile,
  type BootState,
  type EntryProblem,
  type KernelFlavor,
} from '~/shared/boot'

export interface BootAdmin {
  bootState(): Promise<BootState>
  /** The entry Quadeck would write for an installed flavour without one. */
  kernelEntryPreview(pkg: string): Promise<{ path: string; content: string }>
  /** An entry's file with its history, for the editor. */
  bootEntryFile(id: string): Promise<BootEntryFile>
  bootEntryRevision(id: string, revision: string): Promise<string>
  /** Problems of an entry's text before it is saved (`id`: the entry it replaces, if any). */
  checkBootEntry(content: string): Promise<EntryProblem[]>
  /** Kernels, initramfs and microcode on the boot partition (paths from its root), for the entry form. */
  bootFiles(): Promise<string[]>
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
  /** Create, edit or rename a .conf entry; checked first, every version kept. */
  writeBootEntry(change: BootEntryChange): Promise<BootState>
  /** Never the default, the running or the next one-time entry, nor the last one that boots. */
  removeBootEntry(id: string): Promise<BootState>
}

/** Checks shared by the real machine and the demo. */
export function entryForFlavor(state: BootState, pkg: string, read: (p: string) => string | undefined, exists: (p: string) => boolean) {
  if (!isFlavor(pkg)) throw new HttpError(400, msg(m.boot_error_unknownKernel))
  if (state.loader !== 'systemd-boot' || !state.canCreateEntries) throw new HttpError(409, msg(m.boot_error_entriesBySystem))
  const k = state.kernels?.find((x) => x.pkg === pkg)
  if (!k?.installed) throw new HttpError(409, msg(m.boot_error_notInstalled, { pkg }))
  if (k.entries.length) throw new HttpError(409, msg(m.boot_error_alreadyHasEntry, { pkg }))
  const def = state.entries.find((e) => e.isDefault && e.type === 'type1' && e.path)
  const template = def?.path ? read(def.path) : undefined
  if (!def?.path || !template) throw new HttpError(409, msg(m.boot_error_noTemplateEntry))
  const boot = state.boot?.path ?? dirname(dirname(dirname(def.path)))
  for (const f of [`/vmlinuz-${pkg}`, `/initramfs-${pkg}.img`]) if (!exists(join(boot, f))) throw new HttpError(409, msg(m.boot_error_imageMissing, { boot, file: f }))
  const dir = dirname(def.path)
  let path = join(dir, kernelEntryId(pkg as KernelFlavor))
  if (exists(path)) path = join(dir, `quadeck-${pkg}.conf`)
  return { path, content: kernelEntry(template, pkg as KernelFlavor) }
}

// ---------- editing entry files ----------

/** The files behind the entries: the real boot partition or the demo's. */
export interface EntryHost {
  read(path: string): string | undefined
  exists(path: string): boolean
  write(path: string, content: string): void
  rename(from: string, to: string): void
  remove(path: string): void
  history: { list(path: string): Revision[]; read(path: string, id: string): string; add(path: string, content: string, kind: 'deleted'): void; saved(path: string, before: string | undefined, after: string): void }
}

/** $BOOT of an entry: paths inside it (linux /vmlinuz-linux) start there. */
const entryRoot = (path: string) => dirname(dirname(dirname(path)))

function entriesDir(state: BootState): string {
  if (state.loader !== 'systemd-boot') throw new HttpError(409, msg(m.boot_error_noSystemdBoot))
  const e = state.entries.find(isEditableEntry)
  if (e?.path) return dirname(e.path)
  if (state.boot) return join(state.boot.path, 'loader/entries')
  throw new HttpError(409, msg(m.boot_error_noEntriesDir))
}

function editableEntry(state: BootState, id: string): BootEntry & { path: string } {
  if (!ENTRY_ID.test(id)) throw new HttpError(400, msg(m.boot_error_invalidEntry))
  const e = state.entries.find((x) => x.id === id)
  if (!e) throw new HttpError(404, msg(m.boot_error_entryNotFound, { id }))
  if (!isEditableEntry(e)) throw new HttpError(409, msg(m.boot_error_notLoaderEntry))
  return e as BootEntry & { path: string }
}

const locked = (e: BootEntry) => (e.isDefault ? 'default' : e.isSelected ? 'running' : undefined)

export function entryFile(state: BootState, id: string, host: EntryHost): BootEntryFile {
  const e = editableEntry(state, id)
  const content = host.read(e.path)
  if (content === undefined) throw new HttpError(404, msg(m.boot_error_entryNotFound, { id }))
  return { id, path: e.path, content, hash: contentHash(content), locked: locked(e), history: host.history.list(e.path) }
}

/** Files directly in $BOOT plus every file an entry points to (some distributions use subdirectories). */
export function entryFiles(state: BootState, list: (dir: string) => string[]): string[] {
  const root = entryRoot(join(entriesDir(state), 'x.conf'))
  const own = list(root).map((f) => `/${f}`)
  const used = state.entries.filter(isEditableEntry).flatMap((e) => [e.linux, ...e.initrd].filter((f): f is string => !!f && !e.missing.includes(f)))
  return [...new Set([...own, ...used])].sort()
}

export function entryRevision(state: BootState, id: string, revision: string, host: EntryHost) {
  return host.history.read(editableEntry(state, id).path, revision)
}

export function checkEntry(state: BootState, content: string, host: EntryHost, dir = entriesDir(state)): EntryProblem[] {
  const root = entryRoot(join(dir, 'x.conf'))
  return checkEntryConf(content, { exists: (f) => host.exists(join(root, f)), needsRoot: /(^|\s)root=\S/.test(state.cmdline) })
}

function assertChecked(state: BootState, content: string, host: EntryHost, dir: string) {
  const errors = checkEntry(state, content, host, dir).filter((p) => p.level === 'error')
  if (errors.length) throw new HttpError(422, msg(m.boot_error_invalidContent, { problems: errors.map((p) => (p.line ? `${msg(m.boot_check_line, { line: p.line })} ${p.text}` : p.text)).join('; ') }))
}

const withNewline = (s: string) => (s.endsWith('\n') ? s : `${s}\n`)

function freeName(state: BootState, dir: string, name: string, host: EntryHost) {
  if (!ENTRY_FILE.test(name)) throw new HttpError(400, msg(m.boot_error_invalidFileName))
  if (state.entries.some((e) => e.id === name) || host.read(join(dir, name)) !== undefined) throw new HttpError(409, msg(m.boot_error_nameTaken, { name }))
  return join(dir, name)
}

/**
 * Writes a change after checking it. The default and the running entry are
 * not edited in place – a copy is tested once first. A renamed default or
 * one-time entry keeps its role (bootctl set-default/set-oneshot).
 */
export async function applyEntryChange(state: BootState, change: BootEntryChange, host: EntryHost, bootctl: (args: string[]) => Promise<void>) {
  if (change.kind === 'create') {
    const dir = entriesDir(state)
    const path = freeName(state, dir, change.name, host)
    const content = withNewline(change.content)
    assertChecked(state, content, host, dir)
    host.write(path, content)
    host.history.saved(path, undefined, content)
    return
  }
  const e = editableEntry(state, change.id)
  const before = host.read(e.path)
  if (before === undefined) throw new HttpError(404, msg(m.boot_error_entryNotFound, { id: change.id }))
  if (change.kind === 'edit') {
    if (locked(e)) throw new HttpError(409, msg(m.boot_error_entryLocked))
    if (change.expected && change.expected !== contentHash(before)) throw new HttpError(409, msg(m.boot_error_changedMeanwhile))
    const content = withNewline(change.content)
    assertChecked(state, content, host, dirname(e.path))
    if (content === before) return
    host.write(e.path, content)
    host.history.saved(e.path, before, content)
    return
  }
  if (change.name === e.id) return
  const path = freeName(state, dirname(e.path), change.name, host)
  host.rename(e.path, path)
  try {
    if (e.isDefault) await bootctl(['set-default', change.name])
    if (e.isOneshot) await bootctl(['set-oneshot', change.name])
  } catch (err) {
    host.rename(path, e.path)
    throw err
  }
}

/** Path of an entry that may go; its text is kept in the history. */
export function removeEntry(state: BootState, id: string, host: EntryHost) {
  const e = editableEntry(state, id)
  if (e.isDefault || e.isSelected) throw new HttpError(409, msg(m.boot_error_entryInUse))
  if (e.isOneshot) throw new HttpError(409, msg(m.boot_error_entryIsOneshot))
  if (!state.entries.some((x) => x.id !== id && x.type !== 'auto' && !x.missing.length)) throw new HttpError(409, msg(m.boot_error_lastEntry))
  const content = host.read(e.path)
  if (content !== undefined) host.history.add(e.path, content, 'deleted')
  host.remove(e.path)
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
  if (!ENTRY_ID.test(id)) throw new HttpError(400, msg(m.boot_error_invalidEntry))
  if (!entries.some((e) => e.id === id)) throw new HttpError(404, msg(m.boot_error_entryNotFound, { id }))
}

export function assertTimeout(v: string) {
  if (!TIMEOUT_VALUE.test(v) || (/^\d+$/.test(v) && Number(v) > 600)) throw new HttpError(400, msg(m.boot_error_invalidTimeout))
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
    if (s.loader !== 'systemd-boot') throw new HttpError(409, msg(m.boot_error_noSystemdBoot))
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
    writeFileAtomic(path, content)
    return this.bootState()
  }

  private history = new UnitHistory(process.env.QUADECK_BOOT_HISTORY || '/var/lib/quadeck-helper/boot-history')
  private host: EntryHost = {
    read,
    exists: existsSync,
    // tmp + rename: no half-written entry on the boot partition (vfat, too)
    write: (path, content) => writeFileAtomic(path, content),
    rename: (from, to) => renameSync(from, to),
    remove: (path) => rmSync(path, { force: true }),
    history: {
      list: (path) => this.history.list(path),
      read: (path, id) => this.history.read(path, id),
      add: (path, content, kind) => this.history.add(path, content, kind),
      saved: (path, before, after) => this.history.saved(path, before, after),
    },
  }

  async bootEntryFile(id: string) {
    return entryFile(await this.systemdBoot(), id, this.host)
  }

  async bootEntryRevision(id: string, revision: string) {
    return entryRevision(await this.systemdBoot(), id, revision, this.host)
  }

  async checkBootEntry(content: string) {
    return checkEntry(await this.systemdBoot(), content, this.host)
  }

  async bootFiles() {
    return entryFiles(await this.systemdBoot(), (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => d.name)
      } catch {
        return []
      }
    })
  }

  async writeBootEntry(change: BootEntryChange) {
    await applyEntryChange(await this.systemdBoot(), change, this.host, (args) => this.bootctlWrite(args))
    return this.bootState()
  }

  async removeBootEntry(id: string) {
    removeEntry(await this.systemdBoot(), id, this.host)
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

  /** Files on the demo's boot partition: the installed kernels, microcode and the entries. */
  private exists(inst: Map<string, string>) {
    return (p: string) => {
      if (p in this.files()) return true
      const f = p.replace(/^\/boot\//, '')
      if (f === p) return false
      if (/^(intel|amd)-ucode\.img$/.test(f)) return true
      const k = /^(?:vmlinuz-(.+)|initramfs-(.+?)(?:-fallback)?\.img)$/.exec(f)
      return !!k && inst.has((k[1] ?? k[2])!)
    }
  }

  async bootState(): Promise<BootState> {
    const inst = await this.installed()
    const exists = this.exists(inst)
    const entries = this.state.entries.map((e) => {
      const missing = e.type === 'type1' ? [e.linux, ...e.initrd].filter((f): f is string => !!f && !exists(join('/boot', f))) : e.missing
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

  private revs = new Map<string, { rev: Revision; content: string }[]>()
  private seq = 0

  /** The demo's entry files; writes also change the list bootctl would show. */
  private async host(): Promise<EntryHost> {
    const inst = await this.installed()
    const sync = (path: string, content: string) => {
      const id = path.split('/').pop()!
      const conf = entryFromConf(content)
      const pkg = conf.linux?.replace(/^\/vmlinuz-/, '')
      const fields = { ...conf, title: conf.title || id, version: conf.version ?? inst.get(pkg ?? '')?.replace(/\.(\w+)-/, '-$1-') }
      const old = this.state.entries.find((e) => e.path === path)
      if (old) this.state.entries = this.state.entries.map((e) => (e === old ? { ...e, ...fields } : e))
      else {
        const entry: BootEntry = { id, path, type: 'type1', ...fields, isDefault: false, isSelected: false, isOneshot: false, missing: [], size: 90_000_000 }
        this.state.entries = [...this.state.entries.filter((e) => e.type !== 'auto'), entry, ...this.state.entries.filter((e) => e.type === 'auto')]
      }
    }
    const add = (path: string, content: string, message: string) => {
      const list = this.revs.get(path) ?? []
      list.unshift({ rev: { id: `${Date.now()}-${++this.seq}`, date: Date.now() + this.seq, message }, content })
      this.revs.set(path, list.slice(0, 30))
    }
    return {
      read: (p) => this.files()[p],
      exists: this.exists(inst),
      write: (p, content) => {
        this.state.entryFiles = { ...this.files(), [p]: content }
        sync(p, content)
      },
      rename: (from, to) => {
        const { [from]: content, ...rest } = this.files()
        this.state.entryFiles = { ...rest, [to]: content! }
        const id = to.split('/').pop()!
        this.state.entries = this.state.entries.map((e) => (e.path === from ? { ...e, id, path: to } : e))
      },
      remove: (p) => {
        const { [p]: _, ...rest } = this.files()
        this.state.entryFiles = rest
        this.state.entries = this.state.entries.filter((e) => e.path !== p)
      },
      history: {
        list: (p) => (this.revs.get(p) ?? []).map((r) => r.rev),
        read: (p, id) => {
          const r = this.revs.get(p)?.find((x) => x.rev.id === id)
          if (!r) throw new HttpError(404, msg(m.common_errors_versionNotFound))
          return r.content
        },
        add: (p, content) => add(p, content, msg(m.systemd_history_beforeDelete)),
        saved: (p, before, after) => {
          if (before !== undefined && !this.revs.get(p)?.length) add(p, before, msg(m.common_history_original))
          add(p, after, msg(m.notifications_saved))
        },
      },
    }
  }

  async bootEntryFile(id: string) {
    return entryFile(await this.bootState(), id, await this.host())
  }

  async bootEntryRevision(id: string, revision: string) {
    return entryRevision(await this.bootState(), id, revision, await this.host())
  }

  async checkBootEntry(content: string) {
    return checkEntry(await this.bootState(), content, await this.host())
  }

  async bootFiles() {
    const inst = await this.installed()
    const kernels = [...inst.keys()].filter(isFlavor)
    return entryFiles(await this.bootState(), () => ['intel-ucode.img', 'amd-ucode.img', ...kernels.flatMap((k) => [`vmlinuz-${k}`, `initramfs-${k}.img`, `initramfs-${k}-fallback.img`])])
  }

  async writeBootEntry(change: BootEntryChange) {
    await applyEntryChange(await this.bootState(), change, await this.host(), async (args) => {
      if (args[0] === 'set-oneshot') this.state.oneshot = args[1] || undefined
    })
    return this.bootState()
  }

  async removeBootEntry(id: string) {
    removeEntry(await this.bootState(), id, await this.host())
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
