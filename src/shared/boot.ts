// Boot: systemd-boot entries and settings from bootctl, the warnings worth
// knowing before the next kernel update, and the running kernel command line
// explained. Pure functions, shared by the page and the root helper.

import { msg, type MsgKey } from './i18n'

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
  { value: 'menu-hidden', label: msg('boot_hideMenuPressKeyAt') },
  { value: '1', label: msg('boot_1Second') },
  { value: '3', label: msg('boot_3Seconds') },
  { value: '5', label: msg('boot_5Seconds') },
  { value: '10', label: msg('boot_10Seconds') },
  { value: 'menu-force', label: msg('boot_alwaysWaitUntilSomeonePicks') },
]

export function describeTimeout(t: BootState['timeout']): string {
  if (t === undefined) return msg('boot_defaultMenuHidden')
  if (t === 'menu-force') return msg('boot_waitsChoice')
  if (t === 'menu-hidden' || t === 0) return msg('boot_menuHidden')
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
        text: msg('boot_warn_missingFiles', { title: e.title, files: e.missing.join(', '), isDefault: String(!!e.isDefault) }),
      })
  for (const k of s.kernels ?? []) if (k.installed && !k.entries.length && s.canCreateEntries) out.push({ level: 'warning', text: msg('boot_installedButHasNoBoot', { pkg: k.pkg }) })
  if (s.boot) {
    const biggest = Math.max(0, ...s.entries.map((e) => e.size ?? 0))
    if (biggest && s.boot.free < biggest)
      out.push({
        level: 'critical',
        text: msg('boot_onlyLeftKernelInitramfsNeeds', { path: s.boot.path, free: mib(s.boot.free), needed: mib(biggest) }),
      })
    else if (s.boot.size && s.boot.free / s.boot.size < 0.15)
      out.push({
        level: 'warning',
        text: msg('boot_fullFree', { path: s.boot.path, value: Math.round(100 - (s.boot.free / s.boot.size) * 100), free: mib(s.boot.free) }),
      })
  }
  if (s.espVersion && s.packageVersion && versionOlder(s.espVersion, s.packageVersion))
    out.push({
      level: 'warning',
      text: msg('boot_systemdBootEspOlderThan', { espVersion: s.espVersion, packageVersion: s.packageVersion }),
    })
  const kernels = new Set(s.entries.filter((e) => e.type !== 'auto' && e.linux).map((e) => e.linux))
  const ukis = s.entries.filter((e) => e.type === 'type2').length
  if (kernels.size + ukis === 1)
    out.push({
      level: 'info',
      text: msg('boot_warn_oneKernel', { canInstall: String(!!s.kernels) }),
    })
  if (!s.entries.some((e) => e.isDefault)) out.push({ level: 'warning', text: msg('boot_noDefaultEntryFoundSystemd') })
  return out
}

// Both languages are built at once (the helper has no viewer), so no localeOf() here.
/** Size in the viewer's number format (rendered with the message, also later on the server). */
const mib = (b: number) => (b >= 1024 ** 3 ? msg('common_gib', { value: b / 1024 ** 3 }) : msg('common_mib', { value: Math.round(b / 1024 ** 2) }))

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
  root: msg('boot_partitionSystem'),
  rootflags: msg('boot_optionsMountingEGBtrfs'),
  rootfstype: msg('boot_fileSystem'),
  rw: msg('boot_mountSystemWritableRightAway'),
  ro: msg('boot_mountSystemReadOnlyFirst'),
  resume: msg('boot_partitionHibernation'),
  cryptdevice: msg('boot_encryptedPartitionUnlockedAtBoot'),
  'rd.luks.uuid': msg('boot_encryptedPartitionUnlockedAtBoot'),
  'rd.luks.name': msg('boot_encryptedPartitionUnlockedAtBoot'),
  initrd: msg('boot_initramfsLoadedAlongKernel'),
  quiet: msg('boot_fewerMessagesAtBoot'),
  splash: msg('boot_graphicalBootScreen'),
  loglevel: (v) => msg('boot_onlyShowKernelMessagesUp', { value: v ?? '?' }),
  nowatchdog: msg('boot_hardwareWatchdogOffBitFaster'),
  nmi_watchdog: msg('boot_nmiWatchdog0Off'),
  mitigations: (v) => (v === 'off' ? msg('boot_protectionAgainstCpuVulnerabilitiesSpectre') : msg('boot_protectionAgainstCpuVulnerabilitiesSpectre2')),
  'i915.enable_guc': msg('boot_intelGpuLoadGucHuc'),
  'i915.enable_fbc': msg('boot_intelGpuFramebufferCompressionSaves'),
  'xe.force_probe': msg('boot_intelGpuArcXeForce'),
  'i915.force_probe': msg('boot_intelGpuForceDriverCards'),
  'amdgpu.ppfeaturemask': msg('boot_amdGpuPowerOverclockingFeatures'),
  'nvidia-drm.modeset': msg('boot_nvidiaKernelModeSettingNeeded'),
  'nvidia_drm.modeset': msg('boot_nvidiaKernelModeSettingNeeded'),
  'usbcore.autosuspend': (v) => (v === '-1' ? msg('boot_usbPowerSavingOffHelps') : msg('boot_suspendUsbDevicesAfterMany')),
  'nvme_core.default_ps_max_latency_us': (v) => (v === '0' ? msg('boot_nvmePowerSavingStatesOff') : msg('boot_nvmeDeepestAllowedPowerSaving')),
  pcie_aspm: (v) => (v === 'off' ? msg('boot_pciePowerSavingOff') : v === 'force' ? msg('boot_forcePciePowerSavingEven') : msg('boot_pciePowerSaving')),
  'pcie_aspm.policy': msg('boot_pciePowerSavingLevelPowersupersave'),
  intel_iommu: (v) => (v === 'on' ? msg('boot_iommuPassDevicesThroughVms') : msg('boot_intelIommu')),
  amd_iommu: msg('boot_amdIommuPassDevicesThrough'),
  iommu: (v) => (v === 'pt' ? msg('boot_iommuOnlyPassedThroughDevices') : msg('boot_iommuMode')),
  'vfio-pci.ids': msg('boot_reserveThesePciDevicesVms'),
  consoleblank: (v) => msg('boot_blankConsoleScreenAfterS', { value: v ?? '?' }),
  console: msg('boot_whereKernelMessagesGoScreen'),
  'zswap.enabled': (v) => (v === '1' ? msg('boot_compressedCacheFrontSwap') : msg('boot_compressedSwapCacheZswap')),
  'zswap.compressor': msg('boot_compressionZswap'),
  'systemd.unified_cgroup_hierarchy': msg('boot_cgroupsVersion1V2Only'),
  'systemd.show_status': msg('boot_showStatusUnitsAtBoot'),
  'rd.udev.log_level': msg('boot_messagesUdevInitramfs'),
  'rd.systemd.show_status': msg('boot_showStatusUnitsInitramfs'),
  'udev.log_level': msg('boot_messagesUdev'),
  ipv6: 'IPv6',
  'ipv6.disable': (v) => (v === '1' ? msg('boot_ipv6OffEntirely') : 'IPv6'),
  transparent_hugepage: msg('boot_useHugePagesAutomatically'),
  hugepages: msg('boot_reserveFixedNumberHugePages'),
  amd_pstate: msg('boot_amdCpuFrequencyScalingVia'),
  intel_pstate: msg('boot_intelCpuFrequencyScaling'),
  acpi_osi: msg('boot_operatingSystemReportedBiosWorkaround'),
  acpi_enforce_resources: msg('boot_acpiResourcesLaxSensorsSome'),
  'libata.force': msg('boot_forceSettingsSataPortsE'),
  'random.trust_cpu': msg('boot_trustCpuSRandomNumbers'),
  apparmor: msg('boot_apparmorSecurityModule'),
  lsm: msg('boot_activeSecurityModules'),
  selinux: 'SELinux',
  audit: msg('boot_auditLogKernel'),
  module_blacklist: msg('boot_neverLoadTheseKernelModules'),
  'modprobe.blacklist': msg('boot_neverLoadTheseKernelModules'),
  fbcon: msg('boot_consoleScreen'),
  nomodeset: msg('boot_noGraphicsModeSettingOnly'),
  init: msg('boot_programStartsFirstOtherwiseSystemd'),
  panic: (v) => msg('boot_rebootSAfterKernelPanic', { value: v ?? '?' }),
  'kvm.ignore_msrs': msg('boot_kvmIgnoreUnknownCpuRegisters'),
  split_lock_detect: msg('boot_splitLockDetectionOffSome'),
})

export function explainParam(name: string, value?: string): string | undefined {
  const p = params()[name]
  return typeof p === 'function' ? p(value) : p
}

// ---------- kernel flavours (Arch) ----------

export type KernelFlavor = 'linux' | 'linux-lts' | 'linux-zen' | 'linux-hardened'

const flavor = (pkg: KernelFlavor, label: MsgKey, text: MsgKey) => ({
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
  flavor('linux', 'boot_flavor_linux_label', 'boot_flavor_linux_text'),
  flavor('linux-lts', 'boot_flavor_linuxlts_label', 'boot_flavor_linuxlts_text'),
  flavor('linux-zen', 'boot_flavor_linuxzen_label', 'boot_flavor_linuxzen_text'),
  flavor('linux-hardened', 'boot_flavor_linuxhardened_label', 'boot_flavor_linuxhardened_text'),
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
  if (k.running) return msg('boot_runningRightNowBootAnother')
  if (k.isDefault) return msg('boot_defaultEntryMakeAnotherKernel')
  if (!all.some((x) => x.installed && x.pkg !== k.pkg)) return msg('boot_lastInstalledKernel')
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
