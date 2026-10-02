// Boot: systemd-boot entries and settings from bootctl, the warnings worth
// knowing before the next kernel update, and the running kernel command line
// explained. Pure functions, shared by the page and the root helper.

import { tr } from './i18n'

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
  { value: 'menu-hidden', label: tr('Menü ausblenden (beim Start eine Taste drücken, um es zu sehen)', 'Hide the menu (press a key at boot to see it)') },
  { value: '1', label: tr('1 Sekunde', '1 second') },
  { value: '3', label: tr('3 Sekunden', '3 seconds') },
  { value: '5', label: tr('5 Sekunden', '5 seconds') },
  { value: '10', label: tr('10 Sekunden', '10 seconds') },
  { value: 'menu-force', label: tr('Immer warten, bis jemand auswählt', 'Always wait until someone picks one') },
]

export function describeTimeout(t: BootState['timeout']): string {
  if (t === undefined) return tr('Standard (Menü ausgeblendet)', 'Default (menu hidden)')
  if (t === 'menu-force') return tr('wartet auf eine Auswahl', 'waits for a choice')
  if (t === 'menu-hidden' || t === 0) return tr('Menü ausgeblendet', 'menu hidden')
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
        text: tr(
          `„${e.title}“ zeigt auf fehlende Dateien (${e.missing.join(', ')}) – mit diesem Eintrag startet der Server nicht${e.isDefault ? '. Es ist der Standard-Eintrag!' : ' (z. B. nach dem Entfernen eines Kernels – Eintrag entfernen)'}`,
          `“${e.title}” points to missing files (${e.missing.join(', ')}) – the server will not boot with this entry${e.isDefault ? '. It is the default entry!' : ' (e.g. after removing a kernel – remove the entry)'}`,
        ),
      })
  for (const k of s.kernels ?? [])
    if (k.installed && !k.entries.length && s.canCreateEntries)
      out.push({ level: 'warning', text: tr(`${k.pkg} ist installiert, hat aber keinen Boot-Eintrag – „Boot-Eintrag anlegen“`, `${k.pkg} is installed but has no boot entry – “Create boot entry”`) })
  if (s.boot) {
    const biggest = Math.max(0, ...s.entries.map((e) => e.size ?? 0))
    if (biggest && s.boot.free < biggest)
      out.push({
        level: 'critical',
        text: tr(
          `Auf ${s.boot.path} sind nur noch ${mib(s.boot.free)} frei – ein Kernel mit initramfs braucht ${mib(biggest)}. Das nächste Kernel-Update kann scheitern und den Server unbootbar machen: alte Kernel oder Fallback-Images entfernen.`,
          `Only ${mib(s.boot.free, true)} left on ${s.boot.path} – a kernel with initramfs needs ${mib(biggest, true)}. The next kernel update can fail and leave the server unbootable: remove old kernels or fallback images.`,
        ),
      })
    else if (s.boot.size && s.boot.free / s.boot.size < 0.15)
      out.push({
        level: 'warning',
        text: tr(
          `${s.boot.path} ist zu ${Math.round(100 - (s.boot.free / s.boot.size) * 100)} % voll (${mib(s.boot.free)} frei).`,
          `${s.boot.path} is ${Math.round(100 - (s.boot.free / s.boot.size) * 100)} % full (${mib(s.boot.free, true)} free).`,
        ),
      })
  }
  if (s.espVersion && s.packageVersion && versionOlder(s.espVersion, s.packageVersion))
    out.push({
      level: 'warning',
      text: tr(
        `systemd-boot auf der ESP (${s.espVersion}) ist älter als das installierte systemd (${s.packageVersion}) – „Bootloader aktualisieren“ (bootctl update).`,
        `systemd-boot on the ESP (${s.espVersion}) is older than the installed systemd (${s.packageVersion}) – “Update boot loader” (bootctl update).`,
      ),
    })
  const kernels = new Set(s.entries.filter((e) => e.type !== 'auto' && e.linux).map((e) => e.linux))
  const ukis = s.entries.filter((e) => e.type === 'type2').length
  if (kernels.size + ukis === 1)
    out.push({
      level: 'info',
      text: tr(
        `Nur ein Kernel installiert. Ein zweiter (z. B. linux-lts) ist ein Rettungsweg, falls ein Kernel-Update Probleme macht – dann „einmalig mit linux-lts starten“.${s.kernels ? ' Unten unter „Kernel“ installieren.' : ''}`,
        `Only one kernel installed. A second one (e.g. linux-lts) is a way out if a kernel update causes trouble – then “boot linux-lts once”.${s.kernels ? ' Install it below under “Kernel”.' : ''}`,
      ),
    })
  if (!s.entries.some((e) => e.isDefault))
    out.push({ level: 'warning', text: tr('Kein Standard-Eintrag erkannt – systemd-boot nimmt dann den ersten in der Liste.', 'No default entry found – systemd-boot then takes the first one in the list.') })
  return out
}

// Both languages are built at once (the helper has no viewer), so no localeOf() here.
const mib = (b: number, en = false) => (b >= 1024 ** 3 ? `${en ? (b / 1024 ** 3).toFixed(1) : (b / 1024 ** 3).toFixed(1).replace('.', ',')} GiB` : `${Math.round(b / 1024 ** 2)} MiB`)

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
  root: tr('Partition mit dem System (/)', 'Partition with the system (/)'),
  rootflags: tr('Optionen für das Einhängen von / (z. B. das btrfs-Subvolume)', 'Options for mounting / (e.g. the btrfs subvolume)'),
  rootfstype: tr('Dateisystem von /', 'File system of /'),
  rw: tr('System gleich beschreibbar einhängen', 'Mount the system writable right away'),
  ro: tr('System erst nur lesend einhängen (fsck prüft vorher)', 'Mount the system read-only first (fsck checks it before)'),
  resume: tr('Partition für den Ruhezustand (Hibernate)', 'Partition for hibernation'),
  cryptdevice: tr('Verschlüsselte Partition, die beim Start geöffnet wird', 'Encrypted partition that is unlocked at boot'),
  'rd.luks.uuid': tr('Verschlüsselte Partition, die beim Start geöffnet wird', 'Encrypted partition that is unlocked at boot'),
  'rd.luks.name': tr('Verschlüsselte Partition, die beim Start geöffnet wird', 'Encrypted partition that is unlocked at boot'),
  initrd: tr('initramfs, das mitgeladen wird', 'initramfs loaded along with the kernel'),
  quiet: tr('Weniger Meldungen beim Start', 'Fewer messages at boot'),
  splash: tr('Grafischer Startbildschirm', 'Graphical boot screen'),
  loglevel: (v) => tr(`Nur Kernel-Meldungen bis Stufe ${v ?? '?'} anzeigen`, `Only show kernel messages up to level ${v ?? '?'}`),
  nowatchdog: tr('Hardware-Watchdog aus – etwas schneller, aber kein automatischer Neustart bei Hängern', 'Hardware watchdog off – a bit faster, but no automatic restart on hangs'),
  nmi_watchdog: tr('NMI-Watchdog (0 = aus)', 'NMI watchdog (0 = off)'),
  mitigations: (v) =>
    v === 'off'
      ? tr('Schutz gegen CPU-Lücken (Spectre & Co.) ausgeschaltet – schneller, aber unsicherer', 'Protection against CPU vulnerabilities (Spectre & co.) turned off – faster, but less secure')
      : tr('Schutz gegen CPU-Lücken (Spectre & Co.)', 'Protection against CPU vulnerabilities (Spectre & co.)'),
  'i915.enable_guc': tr('Intel-GPU: GuC/HuC laden – nötig für Hardware-Transcoding (QuickSync) bei Jellyfin, Plex, Immich', 'Intel GPU: load GuC/HuC – needed for hardware transcoding (QuickSync) in Jellyfin, Plex, Immich'),
  'i915.enable_fbc': tr('Intel-GPU: Bildspeicher-Komprimierung (Strom sparen)', 'Intel GPU: framebuffer compression (saves power)'),
  'xe.force_probe': tr('Intel-GPU (Arc/Xe): neuen xe-Treiber erzwingen', 'Intel GPU (Arc/Xe): force the new xe driver'),
  'i915.force_probe': tr('Intel-GPU: Treiber für noch nicht offiziell unterstützte Karten erzwingen', 'Intel GPU: force the driver for cards not yet officially supported'),
  'amdgpu.ppfeaturemask': tr('AMD-GPU: Energie- und Übertaktungsfunktionen', 'AMD GPU: power and overclocking features'),
  'nvidia-drm.modeset': tr('NVIDIA: Kernel-Modesetting (für Wayland und manche Container nötig)', 'NVIDIA: kernel mode setting (needed for Wayland and some containers)'),
  'nvidia_drm.modeset': tr('NVIDIA: Kernel-Modesetting (für Wayland und manche Container nötig)', 'NVIDIA: kernel mode setting (needed for Wayland and some containers)'),
  'usbcore.autosuspend': (v) =>
    v === '-1'
      ? tr('USB-Stromsparen aus – hilft gegen USB-Platten, die sich abmelden', 'USB power saving off – helps against USB disks that drop off')
      : tr('USB-Geräte nach so vielen Sekunden Ruhe schlafen legen', 'Suspend USB devices after this many idle seconds'),
  'nvme_core.default_ps_max_latency_us': (v) =>
    v === '0'
      ? tr('NVMe-Stromsparmodi aus – hilft gegen SSDs, die unter Last verschwinden', 'NVMe power saving states off – helps against SSDs that vanish under load')
      : tr('NVMe: tiefste erlaubte Stromsparstufe', 'NVMe: deepest allowed power saving state'),
  pcie_aspm: (v) =>
    v === 'off'
      ? tr('PCIe-Stromsparen aus', 'PCIe power saving off')
      : v === 'force'
        ? tr('PCIe-Stromsparen erzwingen (auch wo das BIOS es nicht meldet)', 'Force PCIe power saving (even where the BIOS does not report it)')
        : tr('PCIe-Stromsparen', 'PCIe power saving'),
  'pcie_aspm.policy': tr('PCIe-Stromsparstufe (powersupersave spart am meisten)', 'PCIe power saving level (powersupersave saves the most)'),
  intel_iommu: (v) => (v === 'on' ? tr('IOMMU an – Geräte an VMs durchreichen (VFIO)', 'IOMMU on – pass devices through to VMs (VFIO)') : tr('Intel-IOMMU', 'Intel IOMMU')),
  amd_iommu: tr('AMD-IOMMU – Geräte an VMs durchreichen', 'AMD IOMMU – pass devices through to VMs'),
  iommu: (v) => (v === 'pt' ? tr('IOMMU nur für durchgereichte Geräte (schneller)', 'IOMMU only for passed-through devices (faster)') : tr('IOMMU-Modus', 'IOMMU mode')),
  'vfio-pci.ids': tr('Diese PCI-Geräte für VMs reservieren', 'Reserve these PCI devices for VMs'),
  consoleblank: (v) => tr(`Bildschirm der Konsole nach ${v ?? '?'} s abschalten`, `Blank the console screen after ${v ?? '?'} s`),
  console: tr('Wohin Kernel-Meldungen gehen (Bildschirm, serielle Schnittstelle)', 'Where kernel messages go (screen, serial port)'),
  'zswap.enabled': (v) => (v === '1' ? tr('Komprimierter Zwischenspeicher vor dem Swap an', 'Compressed cache in front of swap on') : tr('Komprimierter Swap-Zwischenspeicher (zswap)', 'Compressed swap cache (zswap)')),
  'zswap.compressor': tr('Kompression für zswap', 'Compression for zswap'),
  'systemd.unified_cgroup_hierarchy': tr('cgroups-Version (1 = nur v2, wie Podman sie braucht)', 'cgroups version (1 = v2 only, as Podman needs it)'),
  'systemd.show_status': tr('Status der Units beim Start anzeigen', 'Show the status of units at boot'),
  'rd.udev.log_level': tr('Meldungen von udev im initramfs', 'Messages of udev in the initramfs'),
  'rd.systemd.show_status': tr('Status der Units im initramfs anzeigen', 'Show the status of units in the initramfs'),
  'udev.log_level': tr('Meldungen von udev', 'Messages of udev'),
  ipv6: 'IPv6',
  'ipv6.disable': (v) => (v === '1' ? tr('IPv6 ganz aus', 'IPv6 off entirely') : 'IPv6'),
  transparent_hugepage: tr('Große Speicherseiten (Hugepages) automatisch nutzen', 'Use huge pages automatically'),
  hugepages: tr('Feste Anzahl großer Speicherseiten reservieren', 'Reserve a fixed number of huge pages'),
  amd_pstate: tr('AMD-CPU: Taktsteuerung über CPPC (active spart meist mehr)', 'AMD CPU: frequency scaling via CPPC (active usually saves more)'),
  intel_pstate: tr('Intel-CPU: Taktsteuerung', 'Intel CPU: frequency scaling'),
  acpi_osi: tr('Betriebssystem, das dem BIOS gemeldet wird (Workaround für Firmware-Fehler)', 'Operating system reported to the BIOS (workaround for firmware bugs)'),
  acpi_enforce_resources: tr('ACPI-Ressourcen (lax: Sensoren mancher Mainboards lesbar)', 'ACPI resources (lax: sensors of some mainboards become readable)'),
  'libata.force': tr('Einstellungen für SATA-Ports erzwingen (z. B. Geschwindigkeit)', 'Force settings for SATA ports (e.g. speed)'),
  'random.trust_cpu': tr('Zufallszahlen der CPU für den Start vertrauen', 'Trust the CPU’s random numbers at boot'),
  apparmor: tr('AppArmor (Sicherheitsmodul)', 'AppArmor (security module)'),
  lsm: tr('Aktive Sicherheitsmodule', 'Active security modules'),
  selinux: 'SELinux',
  audit: tr('Audit-Protokoll des Kernels', 'Audit log of the kernel'),
  module_blacklist: tr('Diese Kernel-Module nie laden', 'Never load these kernel modules'),
  'modprobe.blacklist': tr('Diese Kernel-Module nie laden', 'Never load these kernel modules'),
  fbcon: tr('Konsole auf dem Bildschirm', 'Console on the screen'),
  nomodeset: tr('Kein Grafik-Modesetting – nur zur Fehlersuche, schaltet Hardware-Beschleunigung ab', 'No graphics mode setting – only for troubleshooting, turns off hardware acceleration'),
  init: tr('Programm, das als erstes startet (sonst systemd)', 'Program that starts first (otherwise systemd)'),
  panic: (v) => tr(`Bei einem Kernel-Absturz nach ${v ?? '?'} s neu starten`, `Reboot ${v ?? '?'} s after a kernel panic`),
  'kvm.ignore_msrs': tr('KVM: unbekannte CPU-Register ignorieren (Windows-VMs)', 'KVM: ignore unknown CPU registers (Windows VMs)'),
  split_lock_detect: tr('Erkennung von Split-Locks (off: manche Spiele, VMs schneller)', 'Split lock detection (off: some games, VMs faster)'),
})

export function explainParam(name: string, value?: string): string | undefined {
  const p = params()[name]
  return typeof p === 'function' ? p(value) : p
}

// ---------- kernel flavours (Arch) ----------

export type KernelFlavor = 'linux' | 'linux-lts' | 'linux-zen' | 'linux-hardened'

const flavor = (pkg: KernelFlavor, label: [string, string], text: [string, string]) => ({
  pkg,
  get label() {
    return tr(...label)
  },
  get text() {
    return tr(...text)
  },
})

/** `label` and `text` are getters: read in the viewer's language. */
export const KERNEL_FLAVORS: { pkg: KernelFlavor; readonly label: string; readonly text: string }[] = [
  flavor('linux', ['Aktuell', 'Current'], ['Neueste stabile Version – der Standard-Kernel von Arch.', 'Latest stable version – the default kernel of Arch.']),
  flavor(
    'linux-lts',
    ['LTS', 'LTS'],
    ['Langzeit-Kernel, ändert sich selten – der klassische Rückweg, wenn ein Update von linux Probleme macht.', 'Long-term kernel, rarely changes – the classic way back when an update of linux causes trouble.'],
  ),
  flavor('linux-zen', ['Zen', 'Zen'], ['Auf kurze Reaktionszeiten getrimmt – eher für Desktop und Spiele.', 'Tuned for short response times – more for desktops and gaming.']),
  flavor('linux-hardened', ['Hardened', 'Hardened'], ['Mit zusätzlicher Absicherung; manche Programme laufen damit nicht.', 'With extra hardening; some programs do not run with it.']),
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
  if (k.running) return tr('Läuft gerade – erst mit einem anderen Kernel starten', 'Running right now – boot another kernel first')
  if (k.isDefault) return tr('Ist der Standard-Eintrag – erst einen anderen Kernel als Standard setzen', 'Is the default entry – make another kernel the default first')
  if (!all.some((x) => x.installed && x.pkg !== k.pkg)) return tr('Der letzte installierte Kernel', 'The last installed kernel')
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
  return ['# Angelegt von Quadeck', `title   Arch Linux (${pkg})`, `linux   /vmlinuz-${pkg}`, ...ucode, `initrd  /initramfs-${pkg}.img`, ...rest].join('\n') + '\n'
}

/** File name of the new entry. */
export const kernelEntryId = (pkg: KernelFlavor) => `${pkg === 'linux' ? 'arch' : `arch-${pkg.replace(/^linux-/, '')}`}.conf`
