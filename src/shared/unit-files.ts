// systemd unit editor: types, name/path rules and checks shared by the page,
// the web app and the root helper.

import { msg } from './i18n'
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
  if (!EDITABLE_UNIT.test(name) || name.startsWith('-') || name.includes('..')) throw new Error(msg('privileged_invalidUnitName', { name }))
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
  Description: k('unitKeys_UNIT_Description', { form: true }),
  After: k('unitKeys_UNIT_After', { multi: true, form: true }),
  Wants: k('unitKeys_UNIT_Wants', { multi: true, form: true }),
  Requires: k('unitKeys_UNIT_Requires', { multi: true, form: true }),
  ConditionPathExists: k('unitKeys_UNIT_ConditionPathExists', { form: true }),
}

const SERVICE: Record<string, KeyDoc> = {
  Type: k('unitKeys_SERVICE_Type', {
    form: true,
    options: ['', 'simple', 'exec', 'oneshot', 'notify', 'forking', 'idle'],
  }),
  ExecStart: k('unitKeys_SERVICE_ExecStart', {
    multi: true,
    form: true,
    placeholder: '/usr/local/bin/my-service --port 8080',
  }),
  ExecStartPre: k('unitKeys_SERVICE_ExecStartPre', { multi: true, form: true }),
  User: k('unitKeys_SERVICE_User', { form: true }),
  Group: k('unitKeys_SERVICE_Group', { form: true }),
  WorkingDirectory: k('unitKeys_SERVICE_WorkingDirectory', { form: true }),
  Environment: k('unitKeys_SERVICE_Environment', { multi: true, form: true, placeholder: 'TZ=Europe/Berlin' }),
  EnvironmentFile: k('unitKeys_SERVICE_EnvironmentFile', { multi: true, form: true }),
  Restart: k('unitKeys_SERVICE_Restart', { form: true, options: ['', 'no', 'on-failure', 'on-abnormal', 'always'] }),
  RestartSec: k('unitKeys_SERVICE_RestartSec', { form: true }),
  TimeoutStartSec: k('unitKeys_SERVICE_TimeoutStartSec', { form: true }),
  MemoryMax: k('unitKeys_SERVICE_MemoryMax', { form: true }),
  CPUQuota: k('unitKeys_SERVICE_CPUQuota', { form: true }),
  Nice: k('unitKeys_SERVICE_Nice', { form: true }),
  NoNewPrivileges: k('unitKeys_SERVICE_NoNewPrivileges', { form: true, options: ['', 'yes', 'no'] }),
  ProtectSystem: k('unitKeys_SERVICE_ProtectSystem', {
    form: true,
    options: ['', 'yes', 'full', 'strict'],
  }),
  ProtectHome: k('unitKeys_SERVICE_ProtectHome', { form: true, options: ['', 'yes', 'read-only', 'tmpfs'] }),
  PrivateTmp: k('unitKeys_SERVICE_PrivateTmp', { form: true, options: ['', 'yes', 'no'] }),
  ReadWritePaths: k('unitKeys_SERVICE_ReadWritePaths', { multi: true, form: true }),
}

const TIMER: Record<string, KeyDoc> = {
  OnCalendar: k('unitKeys_TIMER_OnCalendar', {
    multi: true,
    form: true,
  }),
  OnBootSec: k('unitKeys_TIMER_OnBootSec', { form: true }),
  OnUnitActiveSec: k('unitKeys_TIMER_OnUnitActiveSec', { form: true }),
  Persistent: k('unitKeys_TIMER_Persistent', { form: true, options: ['', 'true', 'false'] }),
  RandomizedDelaySec: k('unitKeys_TIMER_RandomizedDelaySec', { form: true }),
  Unit: k('unitKeys_TIMER_Unit', { form: true }),
}

const SOCKET: Record<string, KeyDoc> = {
  ListenStream: k('unitKeys_SOCKET_ListenStream', { multi: true, form: true }),
  Accept: k('unitKeys_SOCKET_Accept', { form: true, options: ['', 'yes', 'no'] }),
}

const INSTALL: Record<string, KeyDoc> = {
  WantedBy: k('unitKeys_INSTALL_WantedBy', {
    multi: true,
    form: true,
    options: ['', 'multi-user.target', 'timers.target', 'sockets.target', 'default.target'],
  }),
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
    if (e.kind === 'invalid') out.push({ line: e.start + 1, severity: 'error', message: msg('unitFiles_lineNeitherSectionNorKey') })
    if (e.kind !== 'kv') continue
    if (!e.section) {
      out.push({ line: e.start + 1, severity: 'error', message: msg('unitFiles_comesBeforeFirstSection', { key: e.key ?? '' }) })
      continue
    }
    const id = `${e.section}.${e.key}`
    if (!e.value) reset.add(id)
    else if (kind === 'dropin' && LIST_KEYS.has(e.key!) && !reset.has(id))
      out.push({
        line: e.start + 1,
        severity: 'warning',
        message: msg('unitFiles_onlyAddsOverrideReplaceInsert', { key: e.key ?? '' }),
      })
  }
  if (kind === 'fragment' && !parseIni(text).some((e) => e.kind === 'section')) out.push({ severity: 'error', message: msg('unitFiles_noSectionUnitNeedsAt') })
  return out
}

/** Starting points for new units (labels follow the viewer's language when read). */
export const UNIT_TEMPLATES: { id: string; readonly label: string; suffix: string; content: (name: string) => string }[] = [
  {
    id: 'daemon',
    get label() {
      return msg('unitFiles_longRunningService')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nRestart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'oneshot',
    get label() {
      return msg('unitFiles_oneShotScriptAtBoot')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=local-fs.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/local/bin/${n}.sh\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'hardened',
    get label() {
      return msg('unitFiles_hardenedService')
    },
    suffix: 'service',
    content: (n) =>
      `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nUser=nobody\nRestart=on-failure\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/var/lib/${n}\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'empty',
    get label() {
      return msg('timers_empty')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\n\n[Service]\nExecStart=\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
]

export function overrideTemplate(unit: string, fragmentPath?: string) {
  const t = unitType(unit)
  const section = t === 'service' ? 'Service' : t === 'timer' ? 'Timer' : t === 'socket' ? 'Socket' : 'Unit'
  // File content: always English, whatever language the UI is in.
  return `# Override for ${unit}${fragmentPath ? ` (original: ${fragmentPath})` : ''}\n# Only enter changed settings.\n[${section}]\n`
}
