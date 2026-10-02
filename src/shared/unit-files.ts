// systemd unit editor: types, name/path rules and checks shared by the page,
// the web app and the root helper.

import { parseIni } from './ini'
import type { KeyDoc } from './quadlet-keys'
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
  if (!EDITABLE_UNIT.test(name) || name.startsWith('-') || name.includes('..')) throw new Error(`Ungültiger Unit-Name: ${name}`)
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

export const ORIGIN_LABEL: Record<UnitOrigin, string> = { etc: 'eigene', vendor: 'aus Paket', runtime: 'Laufzeit', generated: 'generiert', transient: 'temporär' }

const UNIT: Record<string, KeyDoc> = {
  Description: { help: 'Beschreibung der Unit.', form: true },
  After: { help: 'Erst nach diesen Units starten (z. B. network-online.target).', multi: true, form: true },
  Wants: { help: 'Diese Units mitstarten (weiche Abhängigkeit).', multi: true, form: true },
  Requires: { help: 'Diese Units mitstarten; fällt eine aus, stoppt diese auch.', multi: true, form: true },
  ConditionPathExists: { help: 'Nur starten, wenn der Pfad existiert (z. B. eine eingehängte Platte).', form: true },
}

const SERVICE: Record<string, KeyDoc> = {
  Type: { help: 'simple: läuft dauerhaft · oneshot: Skript, das sich beendet · notify/forking: wie vom Programm verlangt.', form: true, options: ['', 'simple', 'exec', 'oneshot', 'notify', 'forking', 'idle'] },
  ExecStart: { help: 'Befehl mit vollem Pfad. Im Override zuerst ein leeres ExecStart= setzen.', multi: true, form: true, placeholder: '/usr/local/bin/mein-dienst --port 8080' },
  ExecStartPre: { help: 'Befehle vor dem Start.', multi: true, form: true },
  User: { help: 'Als dieser Benutzer laufen (leer = root).', form: true },
  Group: { help: 'Gruppe.', form: true },
  WorkingDirectory: { help: 'Arbeitsverzeichnis.', form: true },
  Environment: { help: 'Umgebungsvariable NAME=wert.', multi: true, form: true, placeholder: 'TZ=Europe/Berlin' },
  EnvironmentFile: { help: 'Datei mit Variablen (- davor: darf fehlen).', multi: true, form: true },
  Restart: { help: 'Neustart, wenn der Prozess endet.', form: true, options: ['', 'no', 'on-failure', 'on-abnormal', 'always'] },
  RestartSec: { help: 'Wartezeit vor dem Neustart, z. B. 5s.', form: true },
  TimeoutStartSec: { help: 'Wie lange der Start dauern darf, z. B. 90s oder infinity.', form: true },
  MemoryMax: { help: 'Speicherlimit, z. B. 2G – darüber beendet der Kernel den Dienst.', form: true },
  CPUQuota: { help: 'CPU-Limit, z. B. 50% (eines Kerns) oder 200%.', form: true },
  Nice: { help: 'Priorität −20 (hoch) bis 19 (niedrig).', form: true },
  NoNewPrivileges: { help: 'Keine zusätzlichen Rechte (setuid/sudo) erlauben.', form: true, options: ['', 'yes', 'no'] },
  ProtectSystem: { help: 'System schreibgeschützt: full = /usr, /boot, /etc · strict = alles außer erlaubten Pfaden.', form: true, options: ['', 'yes', 'full', 'strict'] },
  ProtectHome: { help: 'Home-Verzeichnisse verbergen oder schreibschützen.', form: true, options: ['', 'yes', 'read-only', 'tmpfs'] },
  PrivateTmp: { help: 'Eigenes /tmp.', form: true, options: ['', 'yes', 'no'] },
  ReadWritePaths: { help: 'Trotz ProtectSystem beschreibbar.', multi: true, form: true },
}

const TIMER: Record<string, KeyDoc> = {
  OnCalendar: { help: 'Zeitplan, z. B. *-*-* 03:00:00 oder Mon..Fri 07:30. Im Override zuerst ein leeres OnCalendar= setzen.', multi: true, form: true },
  OnBootSec: { help: 'So lange nach dem Booten, z. B. 15min.', form: true },
  OnUnitActiveSec: { help: 'Wiederholen, so lange nach dem letzten Start, z. B. 1h.', form: true },
  Persistent: { help: 'Verpasste Läufe nachholen.', form: true, options: ['', 'true', 'false'] },
  RandomizedDelaySec: { help: 'Zufällige Verzögerung, z. B. 15min.', form: true },
  Unit: { help: 'Ausgelöste Unit (Standard: gleicher Name .service).', form: true },
}

const SOCKET: Record<string, KeyDoc> = {
  ListenStream: { help: 'TCP-Port oder Socket-Pfad.', multi: true, form: true },
  Accept: { help: 'Pro Verbindung eine Instanz.', form: true, options: ['', 'yes', 'no'] },
}

const INSTALL: Record<string, KeyDoc> = {
  WantedBy: { help: 'Beim Booten starten: multi-user.target (Dienste) oder timers.target (Timer).', multi: true, form: true, options: ['', 'multi-user.target', 'timers.target', 'sockets.target', 'default.target'] },
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
    if (e.kind === 'invalid') out.push({ line: e.start + 1, severity: 'error', message: 'Zeile ist weder [Abschnitt] noch Schlüssel=Wert' })
    if (e.kind !== 'kv') continue
    if (!e.section) {
      out.push({ line: e.start + 1, severity: 'error', message: `${e.key}= steht vor dem ersten [Abschnitt]` })
      continue
    }
    const id = `${e.section}.${e.key}`
    if (!e.value) reset.add(id)
    else if (kind === 'dropin' && LIST_KEYS.has(e.key!) && !reset.has(id)) out.push({ line: e.start + 1, severity: 'warning', message: `${e.key}= ergänzt im Override nur – zum Ersetzen davor eine leere Zeile ${e.key}= einfügen` })
  }
  if (kind === 'fragment' && !parseIni(text).some((e) => e.kind === 'section')) out.push({ severity: 'error', message: 'Kein [Abschnitt] – eine Unit braucht mindestens [Unit] oder [Service]' })
  return out
}

/** Starting points for new units. */
export const UNIT_TEMPLATES: { id: string; label: string; suffix: string; content: (name: string) => string }[] = [
  {
    id: 'daemon',
    label: 'Dauerhafter Dienst',
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nRestart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'oneshot',
    label: 'Einmaliges Skript beim Start',
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=local-fs.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/local/bin/${n}.sh\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'hardened',
    label: 'Abgesicherter Dienst',
    suffix: 'service',
    content: (n) =>
      `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nUser=nobody\nRestart=on-failure\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/var/lib/${n}\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  { id: 'empty', label: 'Leer', suffix: 'service', content: (n) => `[Unit]\nDescription=${n}\n\n[Service]\nExecStart=\n\n[Install]\nWantedBy=multi-user.target\n` },
]

export function overrideTemplate(unit: string, fragmentPath?: string) {
  const t = unitType(unit)
  const section = t === 'service' ? 'Service' : t === 'timer' ? 'Timer' : t === 'socket' ? 'Socket' : 'Unit'
  return `# Override für ${unit}${fragmentPath ? ` (Original: ${fragmentPath})` : ''}\n# Nur geänderte Einstellungen eintragen.\n[${section}]\n`
}
