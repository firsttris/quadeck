// /etc/fstab: parser, writer, option catalogue and the checks that do not need
// the host. Shared by the disks page, the web app and the root helper.

import { tr } from './i18n'
import type { Diagnostic, Revision } from './quadlets'

export interface FstabEntry {
  /** 1-based line in the file. */
  line: number
  raw: string
  spec: string
  file: string
  vfstype: string
  options: string[]
  freq: number
  passno: number
}

/** What the form sends; written as one line. */
export interface EntryInput {
  spec: string
  file: string
  vfstype: string
  options: string[]
  freq: number
  passno: number
  /** Comment above the line (device name, label), without "#". */
  note?: string
}

export type FstabChange =
  | { kind: 'add'; entry: EntryInput }
  /** `original` is the line as it was read; a different line there means someone else changed the file. */
  | { kind: 'update'; line: number; original: string; entry: EntryInput }
  | { kind: 'remove'; line: number; original: string }
  | { kind: 'restore'; content: string }

export interface BlockDevice {
  path: string
  name: string
  /** Whole disk (sda, nvme0n1). */
  disk: string
  fstype: string
  uuid?: string
  partuuid?: string
  label?: string
  partlabel?: string
  size: number
  model?: string
  mountpoints: string[]
}

export interface MountView extends FstabEntry {
  /** Root's file system, /boot, swap and the like: shown, never changed. */
  system?: string
  device?: BlockDevice
  mounted: boolean
  /** Mounted somewhere else than in the file. */
  mountedAt?: string
  size?: number
  used?: number
  bootCritical: boolean
  /** Local block device that is not there. */
  missing: boolean
  /** SMB shares, NFS exports and Quadlet volumes under this path. */
  usedBy: string[]
}

export interface FstabState {
  path: string
  content: string
  entries: MountView[]
  /** File systems that are not in the file. */
  devices: BlockDevice[]
  history: Revision[]
}

export interface FstabCheck {
  ok: boolean
  diagnostics: Diagnostic[]
  before: string
  after: string
  /** Targets that would stop the boot if they fail – they need a confirmation. */
  bootCritical: string[]
  /** Path the change creates as mount point. */
  createDir?: string
  /** What happens to the mount right away. */
  actions: string[]
  usedBy: string[]
}

export const FSTAB_PATH = '/etc/fstab'

// ---------- parse & write ----------

/** fstab escapes: \040 space, \011 tab, \012 newline, \134 backslash. */
export const unescapeField = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
export const escapeField = (s: string) => s.replace(/[\\ \t\n]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))

export function parseFstab(text: string): { entries: FstabEntry[]; diagnostics: Diagnostic[] } {
  const entries: FstabEntry[] = []
  const diagnostics: Diagnostic[] = []
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim()
    if (!t || t.startsWith('#')) return
    const f = t.split(/\s+/)
    const line = i + 1
    if (f.length < 2) return void diagnostics.push({ line, severity: 'error', message: tr('Zu wenige Felder – mindestens Quelle und Einhängepunkt', 'Too few fields – at least source and mount point') })
    if (f.length > 6) return void diagnostics.push({ line, severity: 'error', message: tr(`${f.length} Felder – fstab hat höchstens 6 (Leerzeichen in Pfaden als \\040 schreiben)`, `${f.length} fields – fstab has at most 6 (write spaces in paths as \\040)`) })
    const num = (v: string | undefined, name: string) => {
      if (v === undefined) return 0
      if (!/^\d+$/.test(v)) diagnostics.push({ line, severity: 'error', message: name + tr(` muss eine Zahl sein, nicht „${v}“`, ` must be a number, not “${v}”`) })
      return Number(v) || 0
    }
    entries.push({
      line,
      raw,
      spec: unescapeField(f[0]!),
      file: unescapeField(f[1]!),
      vfstype: f[2] ?? 'auto',
      options: (f[3] ?? 'defaults').split(',').filter(Boolean),
      freq: num(f[4], tr('Feld 5 (dump)', 'Field 5 (dump)')),
      passno: num(f[5], tr('Feld 6 (Prüfreihenfolge)', 'Field 6 (check order)')),
    })
  })
  return { entries, diagnostics }
}

export function formatEntry(e: EntryInput): string {
  const opts = e.options.length ? e.options.join(',') : 'defaults'
  return [escapeField(e.spec), escapeField(e.file), e.vfstype, opts, String(e.freq), String(e.passno)].join('\t')
}

const NOTE = '# quadeck: '

/** The new file text. Comments and lines Quadeck does not touch stay as they are. */
export function applyChange(text: string, change: FstabChange): string {
  if (change.kind === 'restore') return change.content.endsWith('\n') ? change.content : change.content + '\n'
  const lines = text.replace(/\n$/, '').split('\n')
  if (text === '') lines.length = 0
  const note = (e: EntryInput) => (e.note?.trim() ? `${NOTE}${e.note.trim().replace(/[\r\n]+/g, ' ')}` : undefined)
  if (change.kind === 'add') {
    const n = note(change.entry)
    if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('')
    if (n) lines.push(n)
    lines.push(formatEntry(change.entry))
    return lines.join('\n') + '\n'
  }
  const idx = change.line - 1
  if (lines[idx] !== change.original) throw new FstabConflict()
  if (change.kind === 'update') {
    lines[idx] = formatEntry(change.entry)
    const n = note(change.entry)
    if (n && lines[idx - 1]?.startsWith(NOTE)) lines[idx - 1] = n
  } else {
    lines.splice(idx, 1)
    // Our own note above the line goes with it, and so does a blank line left alone.
    if (lines[idx - 1]?.startsWith(NOTE)) lines.splice(idx - 1, 1)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n'
}

export class FstabConflict extends Error {
  constructor() {
    super(tr('Die fstab wurde inzwischen geändert – bitte neu laden', 'The fstab has been changed in the meantime – please reload'))
  }
}

// ---------- what may be touched ----------

const SYSTEM_TARGETS = new Set(['/', '/boot', '/boot/efi', '/efi', '/usr', '/var', '/home', '/sysroot', '/nix', '/gnu'])
const PSEUDO_FS = new Set(['proc', 'sysfs', 'devpts', 'tmpfs', 'devtmpfs', 'efivarfs', 'securityfs', 'cgroup', 'cgroup2', 'debugfs', 'tracefs', 'hugetlbfs', 'mqueue', 'bpf', 'pstore', 'configfs', 'fusectl', 'ramfs', 'overlay', 'squashfs', 'iso9660', 'udf'])
export const NETWORK_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'sshfs', 'fuse.sshfs', 'glusterfs', 'ceph', 'davfs', '9p', 'virtiofs'])

/** Directories that must never become (or be hidden under) a mount point. */
const FORBIDDEN_TARGET = /^\/(?:$|(?:boot|efi|usr|etc|proc|sys|dev|run|tmp|bin|sbin|lib|lib32|lib64|root|var|home|opt|nix|sysroot)\/?$|(?:proc|sys|dev|run|boot|efi|etc|usr|bin|sbin|lib|lib64)\/)/

/** Why an entry is read-only, or undefined when Quadeck may change it. `rootSpecs` are the sources of `/`. */
export function systemReason(e: Pick<FstabEntry, 'spec' | 'file' | 'vfstype'>, rootSpecs: string[] = []): string | undefined {
  if (e.vfstype === 'swap' || e.file === 'none' || e.file === 'swap') return tr('Auslagerungsspeicher', 'Swap')
  if (SYSTEM_TARGETS.has(e.file)) return tr('Systempartition', 'System partition')
  if (PSEUDO_FS.has(e.vfstype)) return tr('Systemdateisystem', 'System file system')
  if (e.file !== '/' && rootSpecs.includes(e.spec)) return tr('Teil der Systempartition (Subvolume)', 'Part of the system partition (subvolume)')
  if (/^\/(boot|efi|usr|var|etc)\//.test(e.file)) return tr('Systemverzeichnis', 'System directory')
  return undefined
}

/** A failed mount of this entry stops the boot in emergency mode. */
export function isBootCritical(e: Pick<FstabEntry, 'vfstype' | 'options' | 'file'>): boolean {
  if (e.vfstype === 'swap' || e.file === 'none') return false
  const o = e.options
  if (o.includes('nofail') || o.includes('noauto') || o.includes('x-systemd.automount')) return false
  if (o.includes('_netdev') || NETWORK_FS.has(e.vfstype)) return false // remote-fs.target does not stop the boot
  return true
}

export const isNetworkSpec = (spec: string) => /^[^/=\s]+:\//.test(spec) || spec.startsWith('//')

/** Names a block device (as opposed to mergerfs branches, a bind mount or tmpfs). */
export const isBlockSpec = (spec: string) => /^(UUID|PARTUUID|LABEL|PARTLABEL|ID)=|^\/dev\//.test(spec)

// ---------- options ----------

export interface OptionDoc {
  name: string
  /** Has a value (name=value). */
  value?: 'number' | 'text' | 'seconds'
  /** File systems it belongs to; none = every file system. */
  fs?: string[]
  text: string
}

const FAT_LIKE = ['vfat', 'exfat', 'ntfs3', 'ntfs', 'ntfs-3g']

/** The text follows the viewer's language: it is read when needed, not when the module loads. */
const doc = (d: Omit<OptionDoc, 'text'>, de: string, en: string): OptionDoc => ({
  ...d,
  get text() {
    return tr(de, en)
  },
})

export const OPTION_DOCS: OptionDoc[] = [
  doc({ name: 'defaults' }, 'Standardeinstellungen (rw, suid, dev, exec, auto, nouser, async).', 'Default settings (rw, suid, dev, exec, auto, nouser, async).'),
  doc({ name: 'nofail' }, 'Fehlt die Platte beim Start, bootet der Server trotzdem – ohne diese Option landet er im Notfallmodus.', 'If the disk is missing at boot, the server boots anyway – without this option it ends up in emergency mode.'),
  doc({ name: 'x-systemd.device-timeout', value: 'seconds' }, 'So lange wartet systemd beim Start auf die Platte (Standard 90 s).', 'How long systemd waits for the disk at boot (default 90 s).'),
  doc({ name: 'noauto' }, 'Beim Start nicht einhängen, nur von Hand oder bei Bedarf.', 'Do not mount at boot, only by hand or on demand.'),
  doc({ name: 'x-systemd.automount' }, 'Erst beim ersten Zugriff einhängen – der Start wartet nicht auf die Platte.', 'Mount on first access only – the boot does not wait for the disk.'),
  doc({ name: 'x-systemd.idle-timeout', value: 'seconds' }, 'Mit Automount: nach so langer Ruhe wieder aushängen (Platte darf schlafen).', 'With automount: unmount again after this much idle time (the disk may sleep).'),
  doc({ name: 'x-systemd.mount-timeout', value: 'seconds' }, 'Höchstdauer für das Einhängen selbst.', 'Maximum time for the mount itself.'),
  doc({ name: 'x-systemd.requires', value: 'text' }, 'Erst einhängen, wenn diese Unit läuft.', 'Mount only once this unit is running.'),
  doc({ name: 'x-systemd.after', value: 'text' }, 'Nach dieser Unit einhängen.', 'Mount after this unit.'),
  doc({ name: 'x-systemd.before', value: 'text' }, 'Vor dieser Unit einhängen.', 'Mount before this unit.'),
  doc({ name: 'x-systemd.makefs' }, 'Leeres Gerät beim Start formatieren – Vorsicht.', 'Format an empty device at boot – careful.'),
  doc({ name: 'x-mount.mkdir' }, 'Einhängepunkt anlegen, falls er fehlt.', 'Create the mount point if it is missing.'),
  doc({ name: 'x-gvfs-show' }, 'Im Dateimanager des Desktops anzeigen.', 'Show in the desktop file manager.'),
  doc({ name: '_netdev' }, 'Braucht das Netzwerk – erst danach einhängen.', 'Needs the network – mount only after it is up.'),
  doc({ name: 'noatime' }, 'Keine Zugriffszeiten schreiben – weniger Schreibzugriffe, Platten schlafen länger.', 'Do not write access times – fewer writes, disks sleep longer.'),
  doc({ name: 'relatime' }, 'Zugriffszeit nur selten aktualisieren (Standard).', 'Update the access time only rarely (default).'),
  doc({ name: 'nodiratime' }, 'Keine Zugriffszeiten für Ordner.', 'No access times for directories.'),
  doc({ name: 'lazytime' }, 'Zeitstempel nur im Speicher halten und gesammelt schreiben.', 'Keep timestamps in memory only and write them in batches.'),
  doc({ name: 'ro' }, 'Nur lesen.', 'Read-only.'),
  doc({ name: 'rw' }, 'Lesen und schreiben.', 'Read and write.'),
  doc({ name: 'auto' }, 'Beim Start einhängen (Standard).', 'Mount at boot (default).'),
  doc({ name: 'user' }, 'Normale Benutzer dürfen einhängen.', 'Normal users may mount.'),
  doc({ name: 'users' }, 'Jeder Benutzer darf ein- und aushängen.', 'Any user may mount and unmount.'),
  doc({ name: 'nouser' }, 'Nur root darf einhängen (Standard).', 'Only root may mount (default).'),
  doc({ name: 'owner' }, 'Der Besitzer des Geräts darf einhängen.', 'The owner of the device may mount.'),
  doc({ name: 'group' }, 'Die Gruppe des Geräts darf einhängen.', 'The group of the device may mount.'),
  doc({ name: 'exec' }, 'Programme auf der Platte dürfen laufen (Standard).', 'Programs on the disk may run (default).'),
  doc({ name: 'noexec' }, 'Keine Programme von dieser Platte starten.', 'Do not run programs from this disk.'),
  doc({ name: 'suid' }, 'Setuid-Bits gelten (Standard).', 'Setuid bits apply (default).'),
  doc({ name: 'nosuid' }, 'Setuid-Bits werden ignoriert – sicherer für Datenplatten.', 'Setuid bits are ignored – safer for data disks.'),
  doc({ name: 'dev' }, 'Gerätedateien gelten (Standard).', 'Device files apply (default).'),
  doc({ name: 'nodev' }, 'Gerätedateien werden ignoriert – sicherer für Datenplatten.', 'Device files are ignored – safer for data disks.'),
  doc({ name: 'sync' }, 'Sofort schreiben, ohne Puffer – langsam.', 'Write immediately, without buffering – slow.'),
  doc({ name: 'async' }, 'Gepuffert schreiben (Standard).', 'Buffered writes (default).'),
  doc({ name: 'discard' }, 'TRIM bei jedem Löschen – bei SSDs meist besser den wöchentlichen fstrim.timer nutzen.', 'TRIM on every delete – for SSDs the weekly fstrim.timer is usually better.'),
  doc({ name: 'comment', value: 'text' }, 'Kommentar für andere Programme.', 'Comment for other programs.'),
  doc({ name: 'errors', value: 'text', fs: ['ext2', 'ext3', 'ext4', 'vfat'] }, 'Bei Fehlern: continue, remount-ro oder panic.', 'On errors: continue, remount-ro or panic.'),
  doc({ name: 'commit', value: 'number', fs: ['ext3', 'ext4', 'btrfs'] }, 'Alle so viele Sekunden auf die Platte schreiben.', 'Write to the disk every this many seconds.'),
  doc({ name: 'data', value: 'text', fs: ['ext3', 'ext4'] }, 'Journal-Modus: ordered, writeback oder journal.', 'Journal mode: ordered, writeback or journal.'),
  doc({ name: 'barrier', value: 'number', fs: ['ext4'] }, 'Schreibbarrieren (1 an, 0 aus).', 'Write barriers (1 on, 0 off).'),
  doc({ name: 'nobarrier', fs: ['ext4'] }, 'Ohne Schreibbarrieren – nur mit Batterie-Cache.', 'Without write barriers – only with a battery-backed cache.'),
  doc({ name: 'user_xattr', fs: ['ext4'] }, 'Erweiterte Attribute für Benutzer.', 'Extended attributes for users.'),
  doc({ name: 'acl', fs: ['ext4'] }, 'Zugriffslisten (ACL).', 'Access control lists (ACL).'),
  doc({ name: 'inode64', fs: ['xfs'] }, 'Inodes überall auf der Platte anlegen (Standard).', 'Create inodes anywhere on the disk (default).'),
  doc({ name: 'logbufs', value: 'number', fs: ['xfs'] }, 'Anzahl der Log-Puffer.', 'Number of log buffers.'),
  doc({ name: 'allocsize', value: 'text', fs: ['xfs'] }, 'Vorab reservierte Größe beim Schreiben.', 'Size reserved in advance when writing.'),
  doc({ name: 'largeio', fs: ['xfs'] }, 'Große I/O-Größe melden.', 'Report a large I/O size.'),
  doc({ name: 'usrquota', fs: ['xfs', 'ext4'] }, 'Kontingente pro Benutzer.', 'Quotas per user.'),
  doc({ name: 'grpquota', fs: ['xfs', 'ext4'] }, 'Kontingente pro Gruppe.', 'Quotas per group.'),
  doc({ name: 'subvol', value: 'text', fs: ['btrfs'] }, 'Dieses Subvolume einhängen.', 'Mount this subvolume.'),
  doc({ name: 'subvolid', value: 'number', fs: ['btrfs'] }, 'Subvolume über seine Nummer.', 'Subvolume by its number.'),
  doc({ name: 'compress', value: 'text', fs: ['btrfs'] }, 'Neue Dateien komprimieren, z. B. zstd oder zstd:3.', 'Compress new files, e.g. zstd or zstd:3.'),
  doc({ name: 'compress-force', value: 'text', fs: ['btrfs'] }, 'Immer komprimieren, auch schlecht komprimierbare Dateien.', 'Always compress, even poorly compressible files.'),
  doc({ name: 'space_cache', value: 'text', fs: ['btrfs'] }, 'Freiraum-Cache, v2 ist Standard.', 'Free space cache, v2 is the default.'),
  doc({ name: 'autodefrag', fs: ['btrfs'] }, 'Kleine Schreibzugriffe automatisch defragmentieren.', 'Defragment small writes automatically.'),
  doc({ name: 'ssd', fs: ['btrfs'] }, 'Für SSDs optimieren (wird meist erkannt).', 'Optimize for SSDs (usually detected).'),
  doc({ name: 'nossd', fs: ['btrfs'] }, 'Nicht für SSDs optimieren.', 'Do not optimize for SSDs.'),
  doc({ name: 'degraded', fs: ['btrfs'] }, 'Auch mit fehlender Platte im RAID einhängen.', 'Mount even with a disk missing from the RAID.'),
  doc({ name: 'uid', value: 'number', fs: FAT_LIKE }, 'Besitzer aller Dateien (Benutzer-ID) – dieses Dateisystem kennt keine Linux-Rechte.', 'Owner of all files (user ID) – this file system has no Linux permissions.'),
  doc({ name: 'gid', value: 'number', fs: FAT_LIKE }, 'Gruppe aller Dateien (Gruppen-ID).', 'Group of all files (group ID).'),
  doc({ name: 'umask', value: 'text', fs: FAT_LIKE }, 'Rechte, die entzogen werden, z. B. 022 (andere dürfen nur lesen) oder 002.', 'Permissions that are removed, e.g. 022 (others may only read) or 002.'),
  doc({ name: 'fmask', value: 'text', fs: FAT_LIKE }, 'Wie umask, nur für Dateien.', 'Like umask, for files only.'),
  doc({ name: 'dmask', value: 'text', fs: FAT_LIKE }, 'Wie umask, nur für Ordner.', 'Like umask, for directories only.'),
  doc({ name: 'iocharset', value: 'text', fs: ['vfat', 'exfat', 'ntfs3', 'ntfs', 'ntfs-3g', 'cifs'] }, 'Zeichensatz der Dateinamen, z. B. utf8.', 'Character set of the file names, e.g. utf8.'),
  doc({ name: 'utf8', fs: ['vfat'] }, 'Dateinamen als UTF-8.', 'File names as UTF-8.'),
  doc({ name: 'shortname', value: 'text', fs: ['vfat'] }, 'Umgang mit kurzen 8.3-Namen.', 'Handling of short 8.3 names.'),
  doc({ name: 'flush', fs: ['vfat', 'exfat'] }, 'Früher schreiben – sicherer bei Wechseldatenträgern.', 'Write earlier – safer for removable media.'),
  doc({ name: 'windows_names', fs: ['ntfs3', 'ntfs', 'ntfs-3g'] }, 'Keine Namen anlegen, die Windows nicht öffnen kann.', 'Do not create names Windows cannot open.'),
  doc({ name: 'prealloc', fs: ['ntfs3'] }, 'Platz beim Schreiben vorab reservieren – weniger Fragmentierung.', 'Reserve space in advance when writing – less fragmentation.'),
  doc({ name: 'force', fs: ['ntfs3'] }, 'Auch einhängen, wenn Windows die Platte als „dirty“ markiert hat.', 'Mount even if Windows marked the disk as “dirty”.'),
  doc({ name: 'permissions', fs: ['ntfs', 'ntfs-3g'] }, 'Linux-Rechte auf NTFS speichern.', 'Store Linux permissions on NTFS.'),
  doc({ name: 'big_writes', fs: ['ntfs', 'ntfs-3g'] }, 'Größere Schreibblöcke (schneller).', 'Larger write blocks (faster).'),
  doc({ name: 'nfsvers', value: 'text', fs: ['nfs', 'nfs4'] }, 'NFS-Version, z. B. 4.2.', 'NFS version, e.g. 4.2.'),
  doc({ name: 'vers', value: 'text', fs: ['nfs', 'nfs4', 'cifs'] }, 'Protokollversion.', 'Protocol version.'),
  doc({ name: 'credentials', value: 'text', fs: ['cifs', 'smb3'] }, 'Datei mit Benutzer und Passwort.', 'File with user name and password.'),
  doc({ name: 'soft', fs: ['nfs', 'nfs4'] }, 'Bei Serverausfall Fehler statt warten.', 'If the server fails, return an error instead of waiting.'),
  doc({ name: 'hard', fs: ['nfs', 'nfs4'] }, 'Bei Serverausfall warten (Standard).', 'If the server fails, wait (default).'),
]

const DOC = new Map(OPTION_DOCS.map((d) => [d.name, d]))

export const optionName = (o: string) => o.split('=')[0]!
export const optionValue = (o: string) => (o.includes('=') ? o.slice(o.indexOf('=') + 1) : undefined)

export function optionDoc(o: string): OptionDoc | undefined {
  const n = optionName(o)
  return DOC.get(n) ?? (n.startsWith('x-systemd.') || n.startsWith('x-') ? doc({ name: n }, 'Option für systemd oder andere Programme (wird vom Kernel ignoriert).', 'Option for systemd or other programs (ignored by the kernel).') : undefined)
}

/** Options that need no driver: mount(8) and systemd handle them. */
export const USERSPACE_OPTION = (o: string) => {
  const n = optionName(o)
  return n.startsWith('x-') || ['nofail', 'noauto', 'auto', '_netdev', 'user', 'users', 'nouser', 'owner', 'group', 'comment', 'defaults'].includes(n)
}

export function knownOption(o: string, fstype: string): boolean {
  const d = optionDoc(o)
  if (!d) return false
  return !d.fs || d.fs.includes(fstype) || fstype === 'auto'
}

// ---------- checks without the host ----------

const OPTION_RE = /^[A-Za-z0-9_.:@%+/=~-]+$/
const SPEC_RE = /^(?:(?:UUID|PARTUUID|LABEL|PARTLABEL|ID)=.+|\/\S+|[A-Za-z0-9_.-]+:\/.*|\/\/\S+|[a-z0-9]+)$/
const FSTYPE_RE = /^[a-z0-9][a-z0-9_.+-]{0,39}$/

/** Mount point a new entry may use. */
export function targetProblem(path: string): string | undefined {
  if (!path.startsWith('/')) return tr('Der Einhängepunkt muss ein absoluter Pfad sein (/mnt/…)', 'The mount point must be an absolute path (/mnt/…)')
  if (/\/\.\.?(\/|$)/.test(path) || /\/\//.test(path) || (path.length > 1 && path.endsWith('/'))) return tr('Pfad ohne „.“, „..“, doppelte oder abschließende „/“ angeben', 'Give the path without “.”, “..”, double or trailing “/”')
  if (/[\x00-\x1f#]/.test(path)) return tr('Steuerzeichen und „#“ sind im Pfad nicht erlaubt', 'Control characters and “#” are not allowed in the path')
  if (FORBIDDEN_TARGET.test(path)) return tr(`${path} ist ein Systemverzeichnis – z. B. /mnt/name oder /srv/name verwenden`, `${path} is a system directory – use e.g. /mnt/name or /srv/name`)
  if (path.length > 240) return tr('Pfad zu lang', 'Path too long')
  return undefined
}

/** Checks of the form values. */
export function checkInput(e: EntryInput): Diagnostic[] {
  const d: Diagnostic[] = []
  const err = (message: string) => d.push({ severity: 'error', message })
  if (!e.spec.trim() || /[\x00-\x1f]/.test(e.spec) || !SPEC_RE.test(e.spec)) err(tr('Quelle: UUID=…, LABEL=…, PARTUUID=… oder /dev/… angeben', 'Source: give UUID=…, LABEL=…, PARTUUID=… or /dev/…'))
  const t = targetProblem(e.file)
  if (t) err(t)
  if (!FSTYPE_RE.test(e.vfstype)) err(tr('Dateisystem: z. B. ext4, xfs, btrfs', 'File system: e.g. ext4, xfs, btrfs'))
  for (const o of e.options) {
    if (!OPTION_RE.test(o)) err(tr(`Option „${o}“ enthält unerlaubte Zeichen`, `Option “${o}” contains invalid characters`))
    else if (!knownOption(o, e.vfstype)) d.push({ severity: 'warning', message: tr(`Option „${o}“ kennt Quadeck für ${e.vfstype} nicht – der Probemount zeigt, ob der Treiber sie annimmt`, `Quadeck does not know option “${o}” for ${e.vfstype} – the test mount shows whether the driver accepts it`) })
  }
  const names = e.options.map(optionName)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) err(tr(`Option „${dup}“ steht doppelt`, `Option “${dup}” appears twice`))
  if (names.includes('ro') && names.includes('rw')) err(tr('ro und rw zugleich', 'ro and rw at the same time'))
  if (names.includes('noauto') && names.includes('x-systemd.automount')) d.push({ severity: 'warning', message: tr('noauto mit Automount: eingehängt wird nur beim Zugriff', 'noauto with automount: mounted on access only') })
  if (!Number.isInteger(e.freq) || e.freq < 0 || e.freq > 1) err(tr('Feld 5 (dump) ist 0 oder 1', 'Field 5 (dump) is 0 or 1'))
  if (!Number.isInteger(e.passno) || e.passno < 0 || e.passno > 2) err(tr('Feld 6 (Prüfreihenfolge) ist 0, 1 oder 2', 'Field 6 (check order) is 0, 1 or 2'))
  if (e.passno === 1 && e.file !== '/') d.push({ severity: 'warning', message: tr('Prüfreihenfolge 1 ist für / gedacht – Datenplatten 2 oder 0', 'Check order 1 is meant for / – data disks 2 or 0') })
  if (e.passno > 0 && ['xfs', 'btrfs', 'ntfs3', 'ntfs', 'exfat', 'zfs'].includes(e.vfstype)) d.push({ severity: 'warning', message: tr(`${e.vfstype} wird beim Start nicht mit fsck geprüft – Feld 6 auf 0 setzen`, `${e.vfstype} is not checked with fsck at boot – set field 6 to 0`) })
  for (const o of e.options) {
    const v = optionValue(o)
    const doc = optionDoc(o)
    if (doc?.value && (v === undefined || v === '')) err(tr(`Option ${doc.name} braucht einen Wert (${doc.name}=…)`, `Option ${doc.name} needs a value (${doc.name}=…)`))
    if (doc?.value === 'number' && v !== undefined && !/^\d+$/.test(v)) err(tr(`${doc.name}= erwartet eine Zahl`, `${doc.name}= expects a number`))
    if (doc?.value === 'seconds' && v !== undefined && !/^\d+(ms|s|min|h)?$/.test(v)) err(tr(`${doc.name}= erwartet eine Dauer wie 10s`, `${doc.name}= expects a duration like 10s`))
  }
  return d
}

/** Checks of the whole file (all entries). Line numbers refer to the new text. */
export function checkFile(text: string, rootSpecs: string[] = []): Diagnostic[] {
  const { entries, diagnostics } = parseFstab(text)
  const seen = new Map<string, number>()
  for (const e of entries) {
    if (e.vfstype === 'swap' || e.file === 'none') continue
    const prev = seen.get(e.file)
    if (prev) diagnostics.push({ line: e.line, severity: 'error', message: tr(`${e.file} steht schon in Zeile ${prev} – ein Einhängepunkt darf nur einmal vorkommen`, `${e.file} is already in line ${prev} – a mount point may appear only once`) })
    else seen.set(e.file, e.line)
  }
  if (!entries.some((e) => e.file === '/') && rootSpecs.length) diagnostics.push({ severity: 'warning', message: tr('Kein Eintrag für / – das ist unüblich', 'No entry for / – that is unusual') })
  return diagnostics
}

/** Protected lines must stay exactly as they are; no new ones may appear. */
export function protectedLinesChanged(before: string, after: string, rootSpecs: string[]): string | undefined {
  const sys = (t: string) =>
    parseFstab(t)
      .entries.filter((e) => systemReason(e, rootSpecs))
      .map((e) => e.raw.trim().split(/\s+/).join(' '))
      .sort()
  const a = sys(before)
  const b = sys(after)
  const gone = a.find((l) => !b.includes(l))
  if (gone) return tr(`Systemeintrag würde geändert oder entfernt: ${gone}`, `A system entry would be changed or removed: ${gone}`)
  const added = b.find((l) => !a.includes(l))
  if (added) return tr(`Neuer Systemeintrag ist nicht erlaubt: ${added}`, `A new system entry is not allowed: ${added}`)
  return undefined
}

/** Targets that are boot critical after the change but were not before (or did not exist). */
export function newlyCritical(before: string, after: string): string[] {
  const crit = (t: string) => new Set(parseFstab(t).entries.filter(isBootCritical).map((e) => `${e.file}\t${e.spec}`))
  const a = crit(before)
  return [...crit(after)].filter((k) => !a.has(k)).map((k) => k.split('\t')[0]!)
}

// ---------- form helpers ----------

/** How a new entry should name the device: UUID, then PARTUUID, then the label. */
export function specFor(d: BlockDevice, by: 'uuid' | 'label' | 'partuuid' = 'uuid'): string {
  if (by === 'label' && d.label) return `LABEL=${d.label}`
  if (by === 'partuuid' && d.partuuid) return `PARTUUID=${d.partuuid}`
  if (d.uuid) return `UUID=${d.uuid}`
  if (d.partuuid) return `PARTUUID=${d.partuuid}`
  return d.path
}

/** Does `spec` name this device? */
export function specMatches(spec: string, d: BlockDevice): boolean {
  const [k, ...rest] = spec.split('=')
  const v = rest.join('=')
  switch (k) {
    case 'UUID':
      return !!d.uuid && d.uuid.toLowerCase() === v.toLowerCase()
    case 'PARTUUID':
      return !!d.partuuid && d.partuuid.toLowerCase() === v.toLowerCase()
    case 'LABEL':
      return d.label === v
    case 'PARTLABEL':
      return d.partlabel === v
  }
  if (spec === d.path || spec === `/dev/${d.name}`) return true
  return spec === `/dev/disk/by-uuid/${d.uuid}` || spec === `/dev/disk/by-label/${d.label}` || spec === `/dev/disk/by-partuuid/${d.partuuid}`
}

export function suggestTarget(d: BlockDevice, taken: string[]): string {
  const base = (d.label || d.partlabel || d.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || d.name
  let p = `/mnt/${base}`
  for (let i = 2; taken.includes(p); i++) p = `/mnt/${base}-${i}`
  return p
}

/** Sensible options for a data disk of this file system. */
export function defaultOptions(fstype: string): string[] {
  const o = ['nofail', 'x-systemd.device-timeout=10s', 'noatime']
  if (fstype === 'btrfs') o.push('compress=zstd')
  if (FAT_LIKE.includes(fstype)) o.push('uid=1000', 'gid=1000', 'umask=022')
  return o
}

export const defaultPassno = (fstype: string) => (['ext2', 'ext3', 'ext4'].includes(fstype) ? 2 : 0)

/** Driver/helper a file system needs, for the install hint. */
export const FS_PACKAGE: Record<string, string> = { 'ntfs-3g': 'ntfs-3g', ntfs: 'ntfs-3g', exfat: 'exfatprogs', btrfs: 'btrfs-progs', xfs: 'xfsprogs', f2fs: 'f2fs-tools', cifs: 'cifs-utils', nfs: 'nfs-utils', nfs4: 'nfs-utils' }

/** systemd unit name of a mount point (`systemd-escape --path --suffix=mount`). */
export function mountUnit(path: string, suffix: 'mount' | 'automount' = 'mount'): string {
  if (path === '/') return `-.${suffix}`
  const p = path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '/') out += '-'
    else if (/[A-Za-z0-9:_]/.test(c) || (c === '.' && i > 0)) out += c
    else for (const b of new TextEncoder().encode(c)) out += `\\x${b.toString(16).padStart(2, '0')}`
  }
  return `${out}.${suffix}`
}
