// systemd unit editor: types, name/path rules and checks shared by the page,
// the web app and the root helper.

import { tr } from './i18n'
import { parseIni } from './ini'
import { k, type KeyDoc } from './quadlet-keys'
import type { Diagnostic, Revision } from './quadlets'

export type UnitOrigin = 'etc' | 'vendor' | 'runtime' | 'generated' | 'transient'

export interface UnitFilePart {
  path: string
  kind: 'fragment' | 'dropin'
  origin: UnitOrigin
  content: string
  editable: boolean
}

export interface UnitDetail {
  unit: string
  description?: string
  loadState: string
  activeState: string
  unitFileState?: string
  /** Fragment first, then drop-ins in the order systemd applies them. */
  parts: UnitFilePart[]
  /** Where a new override goes (`systemctl edit` style); absent when not allowed. */
  overridePath?: string
  /** Why nothing can be changed. */
  readonly?: string
  /** Quadlet file the unit is generated from. */
  quadlet?: string
  /** Timer/service created on the Timer page. */
  managedTimer?: boolean
  /** Instance of a template: the fragment is shared by all instances. */
  template?: boolean
  /** Own unit in /etc/systemd/system that may be deleted. */
  canDelete: boolean
}

export interface UnitValidateResult {
  ok: boolean
  diagnostics: Diagnostic[]
  /** Server check not possible (e.g. template instance). */
  skipped?: string
}

export interface UnitWriteResult {
  restarted: boolean
  warning?: string
}

export type { Revision }

export const UNIT_DIR = '/etc/systemd/system'
export const UNIT_TYPES = ['service', 'timer', 'socket', 'path', 'target', 'mount', 'automount', 'slice'] as const
export const EDITABLE_UNIT = /^[A-Za-z0-9:_.\\@-]{1,200}\.(service|timer|socket|path|target|mount|automount|slice)$/
/** New units: no templates, no escaping. */
export const NEW_UNIT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.(service|timer|socket|path|target)$/
export const DROPIN_NAME = /^[A-Za-z0-9_.@-]{1,100}\.conf$/
/** Quadeck itself: editing these could cut the branch it sits on. */
export const PROTECTED_UNIT = /^quadeck(-helper)?\.service$|^quadeck-job-/

export function assertUnit(name: string) {
  if (!EDITABLE_UNIT.test(name) || name.startsWith('-') || name.includes('..')) throw new Error(tr(`Ungültiger Unit-Name: ${name}`, `Invalid unit name: ${name}`))
}

export const unitType = (name: string) => name.slice(name.lastIndexOf('.') + 1)

/** Paths a write may touch for this unit: its own file or a drop-in in /etc. */
export function writablePath(unit: string, path: string, base = UNIT_DIR): 'fragment' | 'dropin' | undefined {
  if (path === `${base}/${unit}`) return 'fragment'
  const dir = `${base}/${unit}.d/`
  if (path.startsWith(dir) && DROPIN_NAME.test(path.slice(dir.length))) return 'dropin'
  return undefined
}

export function originOf(path: string): UnitOrigin {
  if (path.startsWith('/etc/')) return 'etc'
  if (path.startsWith('/run/systemd/transient')) return 'transient'
  if (/^\/run\/systemd\/generator/.test(path)) return 'generated'
  if (path.startsWith('/run/')) return 'runtime'
  return 'vendor'
}

const UNIT: Record<string, KeyDoc> = {
  Description: k('Beschreibung der Unit.', 'Description of the unit.', { form: true }),
  After: k('Erst nach diesen Units starten (z. B. network-online.target).', 'Start only after these units (e.g. network-online.target).', { multi: true, form: true }),
  Wants: k('Diese Units mitstarten (weiche Abhängigkeit).', 'Start these units too (weak dependency).', { multi: true, form: true }),
  Requires: k('Diese Units mitstarten; fällt eine aus, stoppt diese auch.', 'Start these units too; if one fails, this one stops as well.', { multi: true, form: true }),
  ConditionPathExists: k('Nur starten, wenn der Pfad existiert (z. B. eine eingehängte Platte).', 'Only start if the path exists (e.g. a mounted disk).', { form: true }),
}

const SERVICE: Record<string, KeyDoc> = {
  Type: k('simple: läuft dauerhaft · oneshot: Skript, das sich beendet · notify/forking: wie vom Programm verlangt.', 'simple: runs permanently · oneshot: script that exits · notify/forking: as the program requires.', { form: true, options: ['', 'simple', 'exec', 'oneshot', 'notify', 'forking', 'idle'] }),
  ExecStart: k('Befehl mit vollem Pfad. Im Override zuerst ein leeres ExecStart= setzen.', 'Command with full path. In an override, set an empty ExecStart= first.', { multi: true, form: true, placeholder: '/usr/local/bin/mein-dienst --port 8080' }),
  ExecStartPre: k('Befehle vor dem Start.', 'Commands before the start.', { multi: true, form: true }),
  User: k('Als dieser Benutzer laufen (leer = root).', 'Run as this user (empty = root).', { form: true }),
  Group: k('Gruppe.', 'Group.', { form: true }),
  WorkingDirectory: k('Arbeitsverzeichnis.', 'Working directory.', { form: true }),
  Environment: k('Umgebungsvariable NAME=wert.', 'Environment variable NAME=value.', { multi: true, form: true, placeholder: 'TZ=Europe/Berlin' }),
  EnvironmentFile: k('Datei mit Variablen (- davor: darf fehlen).', 'File with variables (leading -: may be missing).', { multi: true, form: true }),
  Restart: k('Neustart, wenn der Prozess endet.', 'Restart when the process exits.', { form: true, options: ['', 'no', 'on-failure', 'on-abnormal', 'always'] }),
  RestartSec: k('Wartezeit vor dem Neustart, z. B. 5s.', 'Delay before the restart, e.g. 5s.', { form: true }),
  TimeoutStartSec: k('Wie lange der Start dauern darf, z. B. 90s oder infinity.', 'How long the start may take, e.g. 90s or infinity.', { form: true }),
  MemoryMax: k('Speicherlimit, z. B. 2G – darüber beendet der Kernel den Dienst.', 'Memory limit, e.g. 2G – above it the kernel kills the service.', { form: true }),
  CPUQuota: k('CPU-Limit, z. B. 50% (eines Kerns) oder 200%.', 'CPU limit, e.g. 50% (of one core) or 200%.', { form: true }),
  Nice: k('Priorität −20 (hoch) bis 19 (niedrig).', 'Priority −20 (high) to 19 (low).', { form: true }),
  NoNewPrivileges: k('Keine zusätzlichen Rechte (setuid/sudo) erlauben.', 'Do not allow additional privileges (setuid/sudo).', { form: true, options: ['', 'yes', 'no'] }),
  ProtectSystem: k('System schreibgeschützt: full = /usr, /boot, /etc · strict = alles außer erlaubten Pfaden.', 'Read-only system: full = /usr, /boot, /etc · strict = everything except allowed paths.', { form: true, options: ['', 'yes', 'full', 'strict'] }),
  ProtectHome: k('Home-Verzeichnisse verbergen oder schreibschützen.', 'Hide home directories or make them read-only.', { form: true, options: ['', 'yes', 'read-only', 'tmpfs'] }),
  PrivateTmp: k('Eigenes /tmp.', 'Private /tmp.', { form: true, options: ['', 'yes', 'no'] }),
  ReadWritePaths: k('Trotz ProtectSystem beschreibbar.', 'Writable despite ProtectSystem.', { multi: true, form: true }),
}

const TIMER: Record<string, KeyDoc> = {
  OnCalendar: k('Zeitplan, z. B. *-*-* 03:00:00 oder Mon..Fri 07:30. Im Override zuerst ein leeres OnCalendar= setzen.', 'Schedule, e.g. *-*-* 03:00:00 or Mon..Fri 07:30. In an override, set an empty OnCalendar= first.', { multi: true, form: true }),
  OnBootSec: k('So lange nach dem Booten, z. B. 15min.', 'This long after boot, e.g. 15min.', { form: true }),
  OnUnitActiveSec: k('Wiederholen, so lange nach dem letzten Start, z. B. 1h.', 'Repeat this long after the last start, e.g. 1h.', { form: true }),
  Persistent: k('Verpasste Läufe nachholen.', 'Catch up on missed runs.', { form: true, options: ['', 'true', 'false'] }),
  RandomizedDelaySec: k('Zufällige Verzögerung, z. B. 15min.', 'Random delay, e.g. 15min.', { form: true }),
  Unit: k('Ausgelöste Unit (Standard: gleicher Name .service).', 'Unit to trigger (default: same name .service).', { form: true }),
}

const SOCKET: Record<string, KeyDoc> = {
  ListenStream: k('TCP-Port oder Socket-Pfad.', 'TCP port or socket path.', { multi: true, form: true }),
  Accept: k('Pro Verbindung eine Instanz.', 'One instance per connection.', { form: true, options: ['', 'yes', 'no'] }),
}

const INSTALL: Record<string, KeyDoc> = {
  WantedBy: k('Beim Booten starten: multi-user.target (Dienste) oder timers.target (Timer).', 'Start at boot: multi-user.target (services) or timers.target (timers).', { multi: true, form: true, options: ['', 'multi-user.target', 'timers.target', 'sockets.target', 'default.target'] }),
}

/** Form sections per unit type (the rest is edited as text). */
export function formSections(unit: string): [string, Record<string, KeyDoc>][] {
  const t = unitType(unit)
  const main: [string, Record<string, KeyDoc>][] = t === 'service' ? [['Service', SERVICE]] : t === 'timer' ? [['Timer', TIMER]] : t === 'socket' ? [['Socket', SOCKET]] : []
  return [['Unit', UNIT], ...main, ['Install', INSTALL]]
}

/** Keys that add up (an override must reset them with an empty assignment first). */
const LIST_KEYS = new Set(['ExecStart', 'OnCalendar', 'ListenStream'])

/** Checks without systemd: structure, and list keys in overrides that only add. */
export function lintUnit(text: string, kind: 'fragment' | 'dropin'): Diagnostic[] {
  const out: Diagnostic[] = []
  const reset = new Set<string>()
  for (const e of parseIni(text)) {
    if (e.kind === 'invalid') out.push({ line: e.start + 1, severity: 'error', message: tr('Zeile ist weder [Abschnitt] noch Schlüssel=Wert', 'Line is neither [Section] nor Key=Value') })
    if (e.kind !== 'kv') continue
    if (!e.section) {
      out.push({ line: e.start + 1, severity: 'error', message: tr(`${e.key}= steht vor dem ersten [Abschnitt]`, `${e.key}= comes before the first [Section]`) })
      continue
    }
    const id = `${e.section}.${e.key}`
    if (!e.value) reset.add(id)
    else if (kind === 'dropin' && LIST_KEYS.has(e.key!) && !reset.has(id)) out.push({ line: e.start + 1, severity: 'warning', message: tr(`${e.key}= ergänzt im Override nur – zum Ersetzen davor eine leere Zeile ${e.key}= einfügen`, `${e.key}= only adds in an override – to replace, insert an empty ${e.key}= line before it`) })
  }
  if (kind === 'fragment' && !parseIni(text).some((e) => e.kind === 'section')) out.push({ severity: 'error', message: tr('Kein [Abschnitt] – eine Unit braucht mindestens [Unit] oder [Service]', 'No [Section] – a unit needs at least [Unit] or [Service]') })
  return out
}

/** Starting points for new units (labels follow the viewer's language when read). */
export const UNIT_TEMPLATES: { id: string; readonly label: string; suffix: string; content: (name: string) => string }[] = [
  {
    id: 'daemon',
    get label() {
      return tr('Dauerhafter Dienst', 'Long-running service')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nRestart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'oneshot',
    get label() {
      return tr('Einmaliges Skript beim Start', 'One-shot script at boot')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=local-fs.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/local/bin/${n}.sh\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'hardened',
    get label() {
      return tr('Abgesicherter Dienst', 'Hardened service')
    },
    suffix: 'service',
    content: (n) =>
      `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nUser=nobody\nRestart=on-failure\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/var/lib/${n}\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'empty',
    get label() {
      return tr('Leer', 'Empty')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\n\n[Service]\nExecStart=\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
]

export function overrideTemplate(unit: string, fragmentPath?: string) {
  const t = unitType(unit)
  const section = t === 'service' ? 'Service' : t === 'timer' ? 'Timer' : t === 'socket' ? 'Socket' : 'Unit'
  return tr(
    `# Override für ${unit}${fragmentPath ? ` (Original: ${fragmentPath})` : ''}\n# Nur geänderte Einstellungen eintragen.\n[${section}]\n`,
    `# Override for ${unit}${fragmentPath ? ` (original: ${fragmentPath})` : ''}\n# Only enter changed settings.\n[${section}]\n`,
  )
}
