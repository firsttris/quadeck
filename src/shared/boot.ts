// Boot: systemd-boot entries and settings from bootctl, the warnings worth
// knowing before the next kernel update, and the running kernel command line
// explained. Pure functions, shared by the page and the root helper.

export type BootLoader = 'systemd-boot' | 'grub' | 'unknown'

export interface BootEntry {
  id: string
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
  warnings: BootWarning[]
  error?: string
}

/** Entry ids bootctl accepts (file names of entries, auto-* ids). */
export const ENTRY_ID = /^[A-Za-z0-9@_.+~-]{1,200}$/

// ---------- bootctl list --json=short ----------

interface ListJson {
  type?: string
  id?: string
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

export const TIMEOUT_CHOICES: { value: string; label: string }[] = [
  { value: 'menu-hidden', label: 'Menü ausblenden (beim Start eine Taste drücken, um es zu sehen)' },
  { value: '1', label: '1 Sekunde' },
  { value: '3', label: '3 Sekunden' },
  { value: '5', label: '5 Sekunden' },
  { value: '10', label: '10 Sekunden' },
  { value: 'menu-force', label: 'Immer warten, bis jemand auswählt' },
]

export function describeTimeout(t: BootState['timeout']): string {
  if (t === undefined) return 'Standard (Menü ausgeblendet)'
  if (t === 'menu-force') return 'wartet auf eine Auswahl'
  if (t === 'menu-hidden' || t === 0) return 'Menü ausgeblendet'
  return `${t} s`
}

// ---------- warnings ----------

export function bootWarnings(s: Omit<BootState, 'warnings'>): BootWarning[] {
  const out: BootWarning[] = []
  if (s.loader !== 'systemd-boot') return out
  for (const e of s.entries)
    if (e.missing.length) out.push({ level: e.isDefault ? 'critical' : 'warning', text: `„${e.title}“ zeigt auf fehlende Dateien (${e.missing.join(', ')}) – mit diesem Eintrag startet der Server nicht${e.isDefault ? '. Es ist der Standard-Eintrag!' : ''}` })
  if (s.boot) {
    const biggest = Math.max(0, ...s.entries.map((e) => e.size ?? 0))
    if (biggest && s.boot.free < biggest)
      out.push({ level: 'critical', text: `Auf ${s.boot.path} sind nur noch ${mib(s.boot.free)} frei – ein Kernel mit initramfs braucht ${mib(biggest)}. Das nächste Kernel-Update kann scheitern und den Server unbootbar machen: alte Kernel oder Fallback-Images entfernen.` })
    else if (s.boot.size && s.boot.free / s.boot.size < 0.15) out.push({ level: 'warning', text: `${s.boot.path} ist zu ${Math.round(100 - (s.boot.free / s.boot.size) * 100)} % voll (${mib(s.boot.free)} frei).` })
  }
  if (s.espVersion && s.packageVersion && versionOlder(s.espVersion, s.packageVersion))
    out.push({ level: 'warning', text: `systemd-boot auf der ESP (${s.espVersion}) ist älter als das installierte systemd (${s.packageVersion}) – „Bootloader aktualisieren“ (bootctl update).` })
  const kernels = new Set(s.entries.filter((e) => e.type !== 'auto' && e.linux).map((e) => e.linux))
  const ukis = s.entries.filter((e) => e.type === 'type2').length
  if (kernels.size + ukis === 1)
    out.push({ level: 'info', text: 'Nur ein Kernel installiert. Ein zweiter (z. B. linux-lts) ist ein Rettungsweg, falls ein Kernel-Update Probleme macht – dann „einmalig mit linux-lts starten“.' })
  if (!s.entries.some((e) => e.isDefault)) out.push({ level: 'warning', text: 'Kein Standard-Eintrag erkannt – systemd-boot nimmt dann den ersten in der Liste.' })
  return out
}

const mib = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GiB` : `${Math.round(b / 1024 ** 2)} MiB`)

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

const PARAMS: Record<string, string | ((v?: string) => string)> = {
  root: 'Partition mit dem System (/)',
  rootflags: 'Optionen für das Einhängen von / (z. B. das btrfs-Subvolume)',
  rootfstype: 'Dateisystem von /',
  rw: 'System gleich beschreibbar einhängen',
  ro: 'System erst nur lesend einhängen (fsck prüft vorher)',
  resume: 'Partition für den Ruhezustand (Hibernate)',
  cryptdevice: 'Verschlüsselte Partition, die beim Start geöffnet wird',
  'rd.luks.uuid': 'Verschlüsselte Partition, die beim Start geöffnet wird',
  'rd.luks.name': 'Verschlüsselte Partition, die beim Start geöffnet wird',
  initrd: 'initramfs, das mitgeladen wird',
  quiet: 'Weniger Meldungen beim Start',
  splash: 'Grafischer Startbildschirm',
  loglevel: (v) => `Nur Kernel-Meldungen bis Stufe ${v ?? '?'} anzeigen`,
  nowatchdog: 'Hardware-Watchdog aus – etwas schneller, aber kein automatischer Neustart bei Hängern',
  nmi_watchdog: 'NMI-Watchdog (0 = aus)',
  mitigations: (v) => (v === 'off' ? 'Schutz gegen CPU-Lücken (Spectre & Co.) ausgeschaltet – schneller, aber unsicherer' : 'Schutz gegen CPU-Lücken (Spectre & Co.)'),
  'i915.enable_guc': 'Intel-GPU: GuC/HuC laden – nötig für Hardware-Transcoding (QuickSync) bei Jellyfin, Plex, Immich',
  'i915.enable_fbc': 'Intel-GPU: Bildspeicher-Komprimierung (Strom sparen)',
  'xe.force_probe': 'Intel-GPU (Arc/Xe): neuen xe-Treiber erzwingen',
  'i915.force_probe': 'Intel-GPU: Treiber für noch nicht offiziell unterstützte Karten erzwingen',
  'amdgpu.ppfeaturemask': 'AMD-GPU: Energie- und Übertaktungsfunktionen',
  'nvidia-drm.modeset': 'NVIDIA: Kernel-Modesetting (für Wayland und manche Container nötig)',
  'nvidia_drm.modeset': 'NVIDIA: Kernel-Modesetting (für Wayland und manche Container nötig)',
  'usbcore.autosuspend': (v) => (v === '-1' ? 'USB-Stromsparen aus – hilft gegen USB-Platten, die sich abmelden' : 'USB-Geräte nach so vielen Sekunden Ruhe schlafen legen'),
  'nvme_core.default_ps_max_latency_us': (v) => (v === '0' ? 'NVMe-Stromsparmodi aus – hilft gegen SSDs, die unter Last verschwinden' : 'NVMe: tiefste erlaubte Stromsparstufe'),
  pcie_aspm: (v) => (v === 'off' ? 'PCIe-Stromsparen aus' : v === 'force' ? 'PCIe-Stromsparen erzwingen (auch wo das BIOS es nicht meldet)' : 'PCIe-Stromsparen'),
  'pcie_aspm.policy': 'PCIe-Stromsparstufe (powersupersave spart am meisten)',
  intel_iommu: (v) => (v === 'on' ? 'IOMMU an – Geräte an VMs durchreichen (VFIO)' : 'Intel-IOMMU'),
  amd_iommu: 'AMD-IOMMU – Geräte an VMs durchreichen',
  iommu: (v) => (v === 'pt' ? 'IOMMU nur für durchgereichte Geräte (schneller)' : 'IOMMU-Modus'),
  'vfio-pci.ids': 'Diese PCI-Geräte für VMs reservieren',
  consoleblank: (v) => `Bildschirm der Konsole nach ${v ?? '?'} s abschalten`,
  console: 'Wohin Kernel-Meldungen gehen (Bildschirm, serielle Schnittstelle)',
  'zswap.enabled': (v) => (v === '1' ? 'Komprimierter Zwischenspeicher vor dem Swap an' : 'Komprimierter Swap-Zwischenspeicher (zswap)'),
  'zswap.compressor': 'Kompression für zswap',
  'systemd.unified_cgroup_hierarchy': 'cgroups-Version (1 = nur v2, wie Podman sie braucht)',
  'systemd.show_status': 'Status der Units beim Start anzeigen',
  'rd.udev.log_level': 'Meldungen von udev im initramfs',
  'rd.systemd.show_status': 'Status der Units im initramfs anzeigen',
  'udev.log_level': 'Meldungen von udev',
  ipv6: 'IPv6',
  'ipv6.disable': (v) => (v === '1' ? 'IPv6 ganz aus' : 'IPv6'),
  'transparent_hugepage': 'Große Speicherseiten (Hugepages) automatisch nutzen',
  hugepages: 'Feste Anzahl großer Speicherseiten reservieren',
  'amd_pstate': 'AMD-CPU: Taktsteuerung über CPPC (active spart meist mehr)',
  'intel_pstate': 'Intel-CPU: Taktsteuerung',
  'acpi_osi': 'Betriebssystem, das dem BIOS gemeldet wird (Workaround für Firmware-Fehler)',
  'acpi_enforce_resources': 'ACPI-Ressourcen (lax: Sensoren mancher Mainboards lesbar)',
  'libata.force': 'Einstellungen für SATA-Ports erzwingen (z. B. Geschwindigkeit)',
  'random.trust_cpu': 'Zufallszahlen der CPU für den Start vertrauen',
  apparmor: 'AppArmor (Sicherheitsmodul)',
  lsm: 'Aktive Sicherheitsmodule',
  selinux: 'SELinux',
  audit: 'Audit-Protokoll des Kernels',
  'module_blacklist': 'Diese Kernel-Module nie laden',
  'modprobe.blacklist': 'Diese Kernel-Module nie laden',
  fbcon: 'Konsole auf dem Bildschirm',
  nomodeset: 'Kein Grafik-Modesetting – nur zur Fehlersuche, schaltet Hardware-Beschleunigung ab',
  'init': 'Programm, das als erstes startet (sonst systemd)',
  panic: (v) => `Bei einem Kernel-Absturz nach ${v ?? '?'} s neu starten`,
  'kvm.ignore_msrs': 'KVM: unbekannte CPU-Register ignorieren (Windows-VMs)',
  'split_lock_detect': 'Erkennung von Split-Locks (off: manche Spiele, VMs schneller)',
}

export function explainParam(name: string, value?: string): string | undefined {
  const p = PARAMS[name]
  return typeof p === 'function' ? p(value) : p
}
