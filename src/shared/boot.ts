// Boot: systemd-boot entries and settings from bootctl, the warnings worth
// knowing before the next kernel update, and the running kernel command line
// explained. Pure functions, shared by the page and the root helper.

import { msg, type Message } from './i18n'
import { m } from '~/paraglide/messages'

export type BootLoader = 'systemd-boot' | 'grub' | 'unknown'

export interface BootEntry {
  id: string
  /** The .conf file (type1). */
  path?: string
  title: string
  version?: string
  /** type1 (.conf), type2 (UKI), auto (firmware, shell, reboot into firmware), other. */
  type: 'type1' | 'type2' | 'auto' | 'other'
  linux?: string
  initrd: string[]
  options?: string
  isDefault: boolean
  /** Booted this time. */
  isSelected: boolean
  isOneshot: boolean
  /** Files the entry points to that are not there. */
  missing: string[]
  /** Kernel + initrds in bytes (type1). */
  size?: number
}

export interface BootWarning {
  level: 'critical' | 'warning' | 'info'
  text: string
}

export interface BootState {
  loader: BootLoader
  firmware?: string
  secureBoot?: string
  /** systemd-boot that started this boot. */
  runningVersion?: string
  /** systemd-boot binary on the ESP. */
  espVersion?: string
  /** Version of the installed systemd package (bootctl --version). */
  packageVersion?: string
  /** Where kernels and entries live ($BOOT: the ESP or an XBOOTLDR partition). */
  boot?: { path: string; size: number; free: number }
  /** Seconds, or 'menu-force' (wait forever) / 'menu-hidden' (0, key shows the menu). */
  timeout?: number | 'menu-force' | 'menu-hidden'
  /** Where the timeout comes from: EFI variable (bootctl set-timeout) wins over loader.conf. */
  timeoutSource?: 'efi' | 'loader.conf' | 'default'
  entries: BootEntry[]
  oneshot?: string
  /** `systemctl reboot --firmware-setup` works. */
  firmwareSetup: boolean
  cmdline: string
  /** Kernel flavours (Arch): installed, running, boot entries. Absent elsewhere. */
  kernels?: KernelInfo[]
  /** DKMS modules (NVIDIA, ZFS …) need the headers of every kernel. */
  dkms?: boolean
  /** Entries for a new kernel can be written by Quadeck (systemd-boot with classic .conf entries). */
  canCreateEntries?: boolean
  warnings: BootWarning[]
  error?: string
}

/**
 * Entries systemd-boot adds itself that are no system to boot: reboot and power off, and reboot
 * into the firmware when the page has its own button for that. Windows, macOS, the EFI shell stay.
 */
export function hiddenAutoEntry(e: Pick<BootEntry, 'id' | 'type'>, firmwareButton: boolean): boolean {
  if (e.type !== 'auto') return false
  return e.id === 'auto-reboot' || e.id === 'auto-poweroff' || (firmwareButton && e.id === 'auto-reboot-to-firmware-setup')
}

/** Entry ids bootctl accepts (file names of entries, auto-* ids). */
export const ENTRY_ID = /^[A-Za-z0-9@_.+~-]{1,200}$/

// ---------- bootctl list --json=short ----------

interface ListJson {
  type?: string
  id?: string
  path?: string
  title?: string
  showTitle?: string
  version?: string
  linux?: string
  initrd?: string[] | string
  options?: string
  cmdline?: string
  isDefault?: boolean
  isSelected?: boolean
  root?: string
}

export function parseBootctlList(json: string, oneshot?: string): (Omit<BootEntry, 'missing' | 'size'> & { root?: string })[] {
  let data: ListJson[]
  try {
    data = JSON.parse(json) as ListJson[]
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data
    .filter((e) => e && typeof e.id === 'string')
    .map((e) => ({
      id: e.id!,
      path: e.path || undefined,
      title: e.showTitle || e.title || e.id!,
      version: e.version || undefined,
      type: e.type === 'type1' || e.type === 'type2' || e.type === 'auto' ? e.type : e.id!.startsWith('auto-') ? 'auto' : 'other',
      linux: e.linux || undefined,
      initrd: Array.isArray(e.initrd) ? e.initrd : e.initrd ? [e.initrd] : [],
      options: e.options || e.cmdline || undefined,
      isDefault: !!e.isDefault,
      isSelected: !!e.isSelected,
      isOneshot: e.id === oneshot,
      root: e.root || undefined,
    }))
}

// ---------- bootctl status ----------

export interface StatusInfo {
  firmware?: string
  secureBoot?: string
  runningVersion?: string
  espVersion?: string
  firmwareSetup: boolean
}

export function parseBootctlStatus(text: string): StatusInfo {
  const field = (name: string) => text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  // Current Boot Loader → "Product: systemd-boot 256.4-1-arch"
  const running = text.match(/Current Boot Loader:[\s\S]*?Product:\s*systemd-boot\s+(\S+)/)?.[1]
  // Available Boot Loaders on ESP → "File: └─/EFI/systemd/systemd-bootx64.efi (systemd-boot 256.4-1-arch)"
  const esp = text.match(/systemd-boot\w*\.efi \(systemd-boot (\S+?)\)/i)?.[1]
  return {
    firmware: field('Firmware'),
    secureBoot: field('Secure Boot'),
    runningVersion: running,
    espVersion: esp,
    firmwareSetup: /Boot into FW:\s*(supported|active)/i.test(text),
  }
}

/** "systemd 256 (256.4-1-arch)" → "256.4-1-arch". */
export function parseSystemdVersion(text: string): string | undefined {
  return text.match(/^systemd \d+ \(([^)]+)\)/m)?.[1] ?? text.match(/^systemd (\d+)/m)?.[1]
}

/** Compares systemd versions like 256.4-1-arch: major, minor. */
export function versionOlder(a: string, b: string): boolean {
  const n = (v: string) => (v.match(/^(\d+)(?:\.(\d+))?/) ?? []).slice(1, 3).map((x) => Number(x ?? 0))
  const [a1 = 0, a2 = 0] = n(a)
  const [b1 = 0, b2 = 0] = n(b)
  return a1 < b1 || (a1 === b1 && a2 < b2)
}

// ---------- timeout ----------

/** loader.conf / LoaderConfigTimeout value → seconds or menu mode. */
export function parseTimeout(v: string | undefined): BootState['timeout'] {
  const t = v?.trim()
  if (!t) return undefined
  if (t === 'menu-force') return 'menu-force'
  if (t === 'menu-hidden' || t === '0') return t === '0' ? 0 : 'menu-hidden'
  if (/^\d+$/.test(t)) return Number(t)
  return undefined
}

export function loaderConfValue(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^\\s*${key}\\s+(\\S.*?)\\s*$`, 'm'))?.[1]
}

/** EFI variable file contents: 4 bytes of attributes, then UTF-16LE with a trailing NUL. */
export function decodeEfiString(buf: Uint8Array): string {
  const body = buf.subarray(4)
  let s = ''
  for (let i = 0; i + 1 < body.length; i += 2) {
    const c = body[i]! | (body[i + 1]! << 8)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

export const timeoutChoices = (): { value: string; label: string }[] => [
  { value: 'menu-hidden', label: msg(m.boot_timeout_menuHidden) },
  { value: '1', label: msg(m.boot_timeout_oneSecond) },
  { value: '3', label: msg(m.boot_timeout_threeSeconds) },
  { value: '5', label: msg(m.boot_timeout_fiveSeconds) },
  { value: '10', label: msg(m.boot_timeout_tenSeconds) },
  { value: 'menu-force', label: msg(m.boot_timeout_menuForce) },
]

export function describeTimeout(t: BootState['timeout']): string {
  if (t === undefined) return msg(m.boot_status_timeoutDefault)
  if (t === 'menu-force') return msg(m.boot_status_waitsForChoice)
  if (t === 'menu-hidden' || t === 0) return msg(m.boot_status_menuHidden)
  return `${t} s`
}

// ---------- warnings ----------

export function bootWarnings(s: Omit<BootState, 'warnings'>): BootWarning[] {
  const out: BootWarning[] = []
  if (s.loader !== 'systemd-boot') return out
  for (const e of s.entries)
    if (e.missing.length)
      out.push({
        level: e.isDefault ? 'critical' : 'warning',
        text: msg(m.boot_warn_missingFiles, { title: e.title, files: e.missing.join(', '), isDefault: String(!!e.isDefault) }),
      })
  for (const k of s.kernels ?? []) if (k.installed && !k.entries.length && s.canCreateEntries) out.push({ level: 'warning', text: msg(m.boot_warn_kernelNoEntry, { pkg: k.pkg }) })
  if (s.boot) {
    const biggest = Math.max(0, ...s.entries.map((e) => e.size ?? 0))
    if (biggest && s.boot.free < biggest)
      out.push({
        level: 'critical',
        text: msg(m.boot_warn_espTooSmall, { path: s.boot.path, free: mib(s.boot.free), needed: mib(biggest) }),
      })
    else if (s.boot.size && s.boot.free / s.boot.size < 0.15)
      out.push({
        level: 'warning',
        text: msg(m.boot_warn_espFull, { path: s.boot.path, percent: Math.round(100 - (s.boot.free / s.boot.size) * 100), free: mib(s.boot.free) }),
      })
  }
  if (s.espVersion && s.packageVersion && versionOlder(s.espVersion, s.packageVersion))
    out.push({
      level: 'warning',
      text: msg(m.boot_warn_loaderOutdated, { espVersion: s.espVersion, packageVersion: s.packageVersion }),
    })
  const kernels = new Set(s.entries.filter((e) => e.type !== 'auto' && e.linux).map((e) => e.linux))
  const ukis = s.entries.filter((e) => e.type === 'type2').length
  if (kernels.size + ukis === 1)
    out.push({
      level: 'info',
      text: msg(m.boot_warn_oneKernel, { canInstall: String(!!s.kernels) }),
    })
  if (!s.entries.some((e) => e.isDefault)) out.push({ level: 'warning', text: msg(m.boot_warn_noDefaultEntry) })
  return out
}

// Both languages are built at once (the helper has no viewer), so no localeOf() here.
/** Size in the viewer's number format (rendered with the message, also later on the server). */
const mib = (b: number) => (b >= 1024 ** 3 ? msg(m.format_size_gib, { size: b / 1024 ** 3 }) : msg(m.format_size_mib, { size: Math.round(b / 1024 ** 2) }))

// ---------- kernel command line ----------

export interface CmdlineParam {
  name: string
  value?: string
  text?: string
}

/** Splits /proc/cmdline; quoted values stay together. Everything after "--" is for init. */
export function parseCmdline(cmdline: string): CmdlineParam[] {
  const out: CmdlineParam[] = []
  const tokens = cmdline.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  for (const t of tokens) {
    if (t === '--') break
    const i = t.indexOf('=')
    const name = i < 0 ? t : t.slice(0, i)
    const value = i < 0 ? undefined : t.slice(i + 1).replace(/^"|"$/g, '')
    out.push({ name, value, text: explainParam(name, value) })
  }
  return out
}

const params = (): Record<string, string | ((v?: string) => string)> => ({
  root: msg(m.boot_param_root),
  rootflags: msg(m.boot_param_rootflags),
  rootfstype: msg(m.boot_param_rootfstype),
  rw: msg(m.boot_param_rw),
  ro: msg(m.boot_param_ro),
  resume: msg(m.boot_param_resume),
  cryptdevice: msg(m.boot_param_cryptdevice),
  'rd.luks.uuid': msg(m.boot_param_cryptdevice),
  'rd.luks.name': msg(m.boot_param_cryptdevice),
  initrd: msg(m.boot_param_initrd),
  quiet: msg(m.boot_param_quiet),
  splash: msg(m.boot_param_splash),
  loglevel: (v) => msg(m.boot_param_loglevel, { level: v ?? '?' }),
  nowatchdog: msg(m.boot_param_nowatchdog),
  nmi_watchdog: msg(m.boot_param_nmiWatchdog),
  mitigations: (v) => (v === 'off' ? msg(m.boot_param_mitigationsOff) : msg(m.boot_param_mitigations)),
  'i915.enable_guc': msg(m.boot_param_i915Guc),
  'i915.enable_fbc': msg(m.boot_param_i915Fbc),
  'xe.force_probe': msg(m.boot_param_xeForceProbe),
  'i915.force_probe': msg(m.boot_param_i915ForceProbe),
  'amdgpu.ppfeaturemask': msg(m.boot_param_amdgpuFeatureMask),
  'nvidia-drm.modeset': msg(m.boot_param_nvidiaModeset),
  'nvidia_drm.modeset': msg(m.boot_param_nvidiaModeset),
  'usbcore.autosuspend': (v) => (v === '-1' ? msg(m.boot_param_usbAutosuspendOff) : msg(m.boot_param_usbAutosuspend)),
  'nvme_core.default_ps_max_latency_us': (v) => (v === '0' ? msg(m.boot_param_nvmeApstOff) : msg(m.boot_param_nvmeApst)),
  pcie_aspm: (v) => (v === 'off' ? msg(m.boot_param_pcieAspmOff) : v === 'force' ? msg(m.boot_param_pcieAspmForce) : msg(m.boot_param_pcieAspm)),
  'pcie_aspm.policy': msg(m.boot_param_pcieAspmPolicy),
  intel_iommu: (v) => (v === 'on' ? msg(m.boot_param_intelIommuOn) : msg(m.boot_param_intelIommu)),
  amd_iommu: msg(m.boot_param_amdIommu),
  iommu: (v) => (v === 'pt' ? msg(m.boot_param_iommuPassthrough) : msg(m.boot_param_iommu)),
  'vfio-pci.ids': msg(m.boot_param_vfioPciIds),
  consoleblank: (v) => msg(m.boot_param_consoleblank, { seconds: v ?? '?' }),
  console: msg(m.boot_param_console),
  'zswap.enabled': (v) => (v === '1' ? msg(m.boot_param_zswapOn) : msg(m.boot_param_zswap)),
  'zswap.compressor': msg(m.boot_param_zswapCompressor),
  'systemd.unified_cgroup_hierarchy': msg(m.boot_param_unifiedCgroup),
  'systemd.show_status': msg(m.boot_param_showStatus),
  'rd.udev.log_level': msg(m.boot_param_rdUdevLogLevel),
  'rd.systemd.show_status': msg(m.boot_param_rdShowStatus),
  'udev.log_level': msg(m.boot_param_udevLogLevel),
  ipv6: 'IPv6',
  'ipv6.disable': (v) => (v === '1' ? msg(m.boot_param_ipv6Disable) : 'IPv6'),
  transparent_hugepage: msg(m.boot_param_transparentHugepage),
  hugepages: msg(m.boot_param_hugepages),
  amd_pstate: msg(m.boot_param_amdPstate),
  intel_pstate: msg(m.boot_param_intelPstate),
  acpi_osi: msg(m.boot_param_acpiOsi),
  acpi_enforce_resources: msg(m.boot_param_acpiEnforceResources),
  'libata.force': msg(m.boot_param_libataForce),
  'random.trust_cpu': msg(m.boot_param_randomTrustCpu),
  apparmor: msg(m.boot_param_apparmor),
  lsm: msg(m.boot_param_lsm),
  selinux: 'SELinux',
  audit: msg(m.boot_param_audit),
  module_blacklist: msg(m.boot_param_moduleBlacklist),
  'modprobe.blacklist': msg(m.boot_param_moduleBlacklist),
  fbcon: msg(m.boot_param_fbcon),
  nomodeset: msg(m.boot_param_nomodeset),
  init: msg(m.boot_param_init),
  panic: (v) => msg(m.boot_param_panic, { seconds: v ?? '?' }),
  'kvm.ignore_msrs': msg(m.boot_param_kvmIgnoreMsrs),
  split_lock_detect: msg(m.boot_param_splitLockDetect),
})

export function explainParam(name: string, value?: string): string | undefined {
  const p = params()[name]
  return typeof p === 'function' ? p(value) : p
}

// ---------- kernel flavours (Arch) ----------

export type KernelFlavor = 'linux' | 'linux-lts' | 'linux-zen' | 'linux-hardened'

const flavor = (pkg: KernelFlavor, label: Message, text: Message) => ({
  pkg,
  get label() {
    return msg(label)
  },
  get text() {
    return msg(text)
  },
})

/** `label` and `text` are getters: read in the viewer's language. */
export const KERNEL_FLAVORS: { pkg: KernelFlavor; readonly label: string; readonly text: string }[] = [
  flavor('linux', m.boot_flavor_linux_label, m.boot_flavor_linux_text),
  flavor('linux-lts', m.boot_flavor_linuxlts_label, m.boot_flavor_linuxlts_text),
  flavor('linux-zen', m.boot_flavor_linuxzen_label, m.boot_flavor_linuxzen_text),
  flavor('linux-hardened', m.boot_flavor_linuxhardened_label, m.boot_flavor_linuxhardened_text),
]

export const isFlavor = (v: unknown): v is KernelFlavor => KERNEL_FLAVORS.some((k) => k.pkg === v)

export interface KernelInfo {
  pkg: KernelFlavor
  installed: boolean
  version?: string
  running: boolean
  /** Ids of the entries that boot it. */
  entries: string[]
  /** One of its entries is the default. */
  isDefault: boolean
}

/** `uname -r` → flavour: 6.12.48-1-lts, 6.16.8-zen1-1-zen, 6.16.8-hardened1-1-hardened, 6.16.8-arch1-1. */
export function flavorOfRelease(release: string): KernelFlavor {
  if (/-lts$/.test(release)) return 'linux-lts'
  if (/-zen$/.test(release)) return 'linux-zen'
  if (/-hardened$/.test(release)) return 'linux-hardened'
  return 'linux'
}

/** `pacman -Q linux linux-lts …` lines → installed versions. */
export function parsePacmanQ(out: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const l of out.split('\n')) {
    const [name, version] = l.trim().split(/\s+/)
    if (name && version && !l.startsWith('error')) m.set(name, version)
  }
  return m
}

export function kernelInfos(installed: Map<string, string>, release: string, entries: BootEntry[]): KernelInfo[] {
  const running = flavorOfRelease(release)
  return KERNEL_FLAVORS.map(({ pkg }) => {
    const own = entries.filter((e) => e.type === 'type1' && e.linux === `/vmlinuz-${pkg}`)
    return { pkg, installed: installed.has(pkg), version: installed.get(pkg), running: pkg === running && installed.has(pkg), entries: own.map((e) => e.id), isDefault: own.some((e) => e.isDefault) }
  })
}

/** Why a flavour may not be removed, or undefined. */
export function kernelRemoveProblem(k: KernelInfo, all: KernelInfo[]): string | undefined {
  if (k.running) return msg(m.boot_note_kernelRunning)
  if (k.isDefault) return msg(m.boot_note_kernelIsDefault)
  if (!all.some((x) => x.installed && x.pkg !== k.pkg)) return msg(m.boot_note_lastKernel)
  return undefined
}

/**
 * A boot entry for another flavour, made from an existing one: same options
 * (root=, rootflags …) and microcode, kernel and initramfs swapped.
 */
export function kernelEntry(template: string, pkg: KernelFlavor): string {
  const lines = template.split('\n').filter((l) => !/^\s*(title|linux|version|sort-key|machine-id)\s/.test(l) && !/^#/.test(l))
  const initrd = lines.filter((l) => /^\s*initrd\s/.test(l))
  const ucode = initrd.filter((l) => /ucode/.test(l))
  const rest = lines.filter((l) => !/^\s*initrd\s/.test(l) && l.trim())
  return ['# Created by Quadeck', `title   Arch Linux (${pkg})`, `linux   /vmlinuz-${pkg}`, ...ucode, `initrd  /initramfs-${pkg}.img`, ...rest].join('\n') + '\n'
}

/** File name of the new entry. */
export const kernelEntryId = (pkg: KernelFlavor) => `${pkg === 'linux' ? 'arch' : `arch-${pkg.replace(/^linux-/, '')}`}.conf`

// ---------- editing entry files (loader/entries/*.conf) ----------

/** File names Quadeck writes; the name is the entry id bootctl shows. */
export const ENTRY_FILE = /^[A-Za-z0-9@_+~-][A-Za-z0-9@_.+~-]{0,194}\.conf$/
/** Larger files are not boot entries. */
export const ENTRY_MAX = 16 * 1024

/** Keys of the Boot Loader Specification (type #1) and of systemd-boot. */
const ENTRY_KEYS = ['title', 'version', 'machine-id', 'sort-key', 'linux', 'initrd', 'efi', 'options', 'devicetree', 'devicetree-overlay', 'architecture', 'uki', 'uki-url', 'profile']
const SINGLE_KEYS = ['title', 'version', 'machine-id', 'sort-key', 'linux', 'efi', 'devicetree', 'architecture', 'uki']
/** Keys whose value is a file on the boot partition. */
const FILE_KEYS = ['linux', 'initrd', 'efi', 'devicetree', 'uki']

export interface EntryLine {
  line: number
  key: string
  value: string
}

/** `key value` lines; blank lines and # comments are skipped. */
export function parseEntryConf(text: string): EntryLine[] {
  const out: EntryLine[] = []
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim()
    if (!l || l.startsWith('#')) return
    const m = /^(\S+)(?:\s+(.*))?$/.exec(l)!
    out.push({ line: i + 1, key: m[1]!, value: (m[2] ?? '').trim() })
  })
  return out
}

export interface EntryProblem {
  level: 'error' | 'warning'
  /** 1-based line in the file. */
  line?: number
  text: string
}

/**
 * Checks an entry before it is written: a kernel (linux, efi or uki), files
 * that exist on the boot partition, root= in the options when this system
 * boots with one. Errors block saving, warnings do not.
 */
export function checkEntryConf(text: string, opts: { exists?: (file: string) => boolean; needsRoot?: boolean } = {}): EntryProblem[] {
  const out: EntryProblem[] = []
  if (text.length > ENTRY_MAX) return [{ level: 'error', text: msg(m.boot_check_tooLarge) }]
  const lines = parseEntryConf(text)
  const seen = new Set<string>()
  for (const l of lines) {
    if (!ENTRY_KEYS.includes(l.key)) out.push({ level: 'warning', line: l.line, text: msg(m.boot_check_unknownKey, { key: l.key }) })
    else if (!l.value) out.push({ level: 'error', line: l.line, text: msg(m.boot_check_noValue, { key: l.key }) })
    else if (FILE_KEYS.includes(l.key)) {
      if (!l.value.startsWith('/')) out.push({ level: 'error', line: l.line, text: msg(m.boot_check_relativePath, { file: l.value }) })
      else if (opts.exists && !opts.exists(l.value)) out.push({ level: 'error', line: l.line, text: msg(m.boot_check_fileMissing, { file: l.value }) })
    }
    if (SINGLE_KEYS.includes(l.key) && seen.has(l.key)) out.push({ level: 'warning', line: l.line, text: msg(m.boot_check_repeated, { key: l.key }) })
    seen.add(l.key)
  }
  const has = (k: string) => lines.some((l) => l.key === k && l.value)
  if (!has('linux') && !has('efi') && !has('uki')) out.push({ level: 'error', text: msg(m.boot_check_noKernel) })
  const options = lines
    .filter((l) => l.key === 'options')
    .map((l) => l.value)
    .join(' ')
  if (has('linux') && opts.needsRoot && !/(^|\s)root=\S/.test(options)) out.push({ level: 'error', line: lines.find((l) => l.key === 'options')?.line, text: msg(m.boot_check_noRoot) })
  if (!has('title')) out.push({ level: 'warning', text: msg(m.boot_check_noTitle) })
  return out.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9))
}

/** What the list shows for an entry file (title, kernel, initrds, options). */
export function entryFromConf(text: string): Pick<BootEntry, 'title' | 'version' | 'linux' | 'initrd' | 'options'> {
  const lines = parseEntryConf(text)
  const last = (k: string) => lines.filter((l) => l.key === k && l.value).pop()?.value
  const options = lines.filter((l) => l.key === 'options' && l.value).map((l) => l.value)
  return {
    title: last('title') ?? '',
    version: last('version'),
    linux: last('linux'),
    initrd: lines.filter((l) => l.key === 'initrd' && l.value).map((l) => l.value),
    options: options.length ? options.join(' ') : undefined,
  }
}

/** A free file name for a copy: arch.conf → arch-copy.conf, arch-copy-2.conf … */
export function copyEntryName(id: string, taken: string[]): string {
  const base = id.replace(/\.conf$/, '').replace(/-copy(-\d+)?$/, '')
  for (let i = 1; ; i++) {
    const name = `${base}-copy${i > 1 ? `-${i}` : ''}.conf`
    if (!taken.includes(name)) return name
  }
}

/** The copy's text: the same, with " (copy)" after the title, so the menu tells them apart. */
export function copyEntryContent(text: string, id: string): string {
  if (/^\s*title\s+\S/m.test(text)) return text.replace(/^(\s*title\s+)(.*?)\s*$/m, (_, k: string, v: string) => `${k}${v} (copy)`)
  return `title   ${id.replace(/\.conf$/, '')} (copy)\n${text}`
}

/** A new entry, filled in from the default one (kernel, initrds, options). */
export function newEntryContent(def: BootEntry | undefined): string {
  const lines = ['title   New entry']
  if (def?.type === 'type1' && def.linux) {
    lines.push(`linux   ${def.linux}`, ...def.initrd.map((i) => `initrd  ${i}`))
    if (def.options) lines.push(`options ${def.options}`)
  } else lines.push('linux   /vmlinuz-linux', 'initrd  /initramfs-linux.img', 'options root=')
  return lines.join('\n') + '\n'
}

/** An entry Quadeck can edit: a .conf file directly in loader/entries. */
export const isEditableEntry = (e: BootEntry) => e.type === 'type1' && !!e.path && /\/loader\/entries\/[^/]+\.conf$/.test(e.path)

export interface BootEntryFile {
  id: string
  path: string
  content: string
  /** To notice a change by someone else in the meantime. */
  hash: string
  /** The default and the running entry are not edited in place (make a copy and test it). */
  locked?: 'default' | 'running'
  history: { id: string; date: number; message: string }[]
}

export type BootEntryChange = { kind: 'create'; name: string; content: string } | { kind: 'edit'; id: string; content: string; expected?: string } | { kind: 'rename'; id: string; name: string }

/** A change from JSON (browser → server → helper); undefined if it is none. */
export function parseBootEntryChange(raw: unknown): BootEntryChange | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  if (r.kind === 'create' && s(r.name) !== undefined && s(r.content) !== undefined) return { kind: 'create', name: s(r.name)!, content: s(r.content)! }
  if (r.kind === 'edit' && s(r.id) !== undefined && s(r.content) !== undefined) return { kind: 'edit', id: s(r.id)!, content: s(r.content)!, expected: s(r.expected) }
  if (r.kind === 'rename' && s(r.id) !== undefined && s(r.name) !== undefined) return { kind: 'rename', id: s(r.id)!, name: s(r.name)! }
  return undefined
}

// ---------- the entry as a form ----------

/** What the form edits; every other line (comments, version, sort-key …) stays as it is. */
export interface EntryForm {
  title: string
  linux: string
  /** In boot order: microcode first, then the initramfs. */
  initrd: string[]
  /** Kernel parameters, one token each (root=UUID=…, quiet, foo="a b"). */
  options: string[]
}

export const splitOptions = (s: string) => s.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? []

export function entryForm(text: string): EntryForm {
  const e = entryFromConf(text)
  return { title: e.title, linux: e.linux ?? '', initrd: e.initrd, options: splitOptions(e.options ?? '') }
}

const confLine = (key: string, value: string) => `${key.padEnd(7)} ${value}`

/** The text with the form's values: title, linux, initrd and options rewritten where they were, the rest untouched. */
export function applyEntryForm(text: string, f: EntryForm): string {
  const lines = text.replace(/\n$/, '').split('\n')
  const keyOf = (l: string) => /^\s*([a-z-]+)(\s|$)/.exec(l)?.[1]
  const want: Record<string, string[]> = {
    title: f.title.trim() ? [f.title.replace(/^\s+/, '')] : [],
    linux: f.linux.trim() ? [f.linux.trim()] : [],
    initrd: f.initrd.map((i) => i.trim()).filter(Boolean),
    options: f.options.length ? [f.options.join(' ')] : [],
  }
  const out: string[] = []
  const done = new Set<string>()
  for (const l of lines) {
    const k = keyOf(l)
    if (!k || !(k in want)) {
      out.push(l)
      continue
    }
    if (done.has(k)) continue
    done.add(k)
    out.push(...want[k]!.map((v) => confLine(k, v)))
  }
  // Keys that were not in the file yet: title first, the others in the usual order.
  const missing = (k: string) => !done.has(k) && want[k]!.length > 0
  if (missing('title')) {
    const first = out.findIndex((l) => l.trim() && !l.trim().startsWith('#'))
    out.splice(first < 0 ? out.length : first, 0, confLine('title', want.title![0]!))
  }
  for (const k of ['linux', 'initrd', 'options'])
    if (missing(k)) {
      const after = Math.max(...['title', 'linux', 'initrd', 'options'].map((x) => out.map(keyOf).lastIndexOf(x)))
      out.splice(after + 1, 0, ...want[k]!.map((v) => confLine(k, v)))
    }
  return out.filter((l, i) => l.trim() || i < out.length - 1).join('\n') + '\n'
}

/** Files on the boot partition by what they are for. */
export function bootFileKinds(files: string[]) {
  const kernels = files.filter((f) => /\/(vmlinuz|vmlinux|bzImage|linux)[^/]*$|\/Image$/.test(f) && !/\.img$/.test(f))
  const microcode = files.filter((f) => /ucode[^/]*\.img$/.test(f))
  const initrds = files.filter((f) => /\.img$/.test(f) && !/ucode/.test(f) && /init/.test(f))
  return { kernels, microcode, initrds }
}

/** Parameters with an explanation, for the suggestions when adding one. */
export const knownParams = () => Object.keys(params())
