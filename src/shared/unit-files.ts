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
  if (!EDITABLE_UNIT.test(name) || name.startsWith('-') || name.includes('..')) throw new Error(msg('helper_error_invalidUnitName', { unit: name }))
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
  Description: k('unitHelp_unit_Description', { form: true }),
  After: k('unitHelp_unit_After', { multi: true, form: true }),
  Wants: k('unitHelp_unit_Wants', { multi: true, form: true }),
  Requires: k('unitHelp_unit_Requires', { multi: true, form: true }),
  ConditionPathExists: k('unitHelp_unit_ConditionPathExists', { form: true }),
}

const SERVICE: Record<string, KeyDoc> = {
  Type: k('unitHelp_service_Type', {
    form: true,
    options: ['', 'simple', 'exec', 'oneshot', 'notify', 'forking', 'idle'],
  }),
  ExecStart: k('unitHelp_service_ExecStart', {
    multi: true,
    form: true,
    placeholder: '/usr/local/bin/my-service --port 8080',
  }),
  ExecStartPre: k('unitHelp_service_ExecStartPre', { multi: true, form: true }),
  User: k('unitHelp_service_User', { form: true }),
  Group: k('unitHelp_service_Group', { form: true }),
  WorkingDirectory: k('unitHelp_service_WorkingDirectory', { form: true }),
  Environment: k('unitHelp_service_Environment', { multi: true, form: true, placeholder: 'TZ=Europe/Berlin' }),
  EnvironmentFile: k('unitHelp_service_EnvironmentFile', { multi: true, form: true }),
  Restart: k('unitHelp_service_Restart', { form: true, options: ['', 'no', 'on-failure', 'on-abnormal', 'always'] }),
  RestartSec: k('unitHelp_service_RestartSec', { form: true }),
  TimeoutStartSec: k('unitHelp_service_TimeoutStartSec', { form: true }),
  MemoryMax: k('unitHelp_service_MemoryMax', { form: true }),
  CPUQuota: k('unitHelp_service_CPUQuota', { form: true }),
  Nice: k('unitHelp_service_Nice', { form: true }),
  NoNewPrivileges: k('unitHelp_service_NoNewPrivileges', { form: true, options: ['', 'yes', 'no'] }),
  ProtectSystem: k('unitHelp_service_ProtectSystem', {
    form: true,
    options: ['', 'yes', 'full', 'strict'],
  }),
  ProtectHome: k('unitHelp_service_ProtectHome', { form: true, options: ['', 'yes', 'read-only', 'tmpfs'] }),
  PrivateTmp: k('unitHelp_service_PrivateTmp', { form: true, options: ['', 'yes', 'no'] }),
  ReadWritePaths: k('unitHelp_service_ReadWritePaths', { multi: true, form: true }),
}

const TIMER: Record<string, KeyDoc> = {
  OnCalendar: k('unitHelp_timer_OnCalendar', {
    multi: true,
    form: true,
  }),
  OnBootSec: k('unitHelp_timer_OnBootSec', { form: true }),
  OnUnitActiveSec: k('unitHelp_timer_OnUnitActiveSec', { form: true }),
  Persistent: k('unitHelp_timer_Persistent', { form: true, options: ['', 'true', 'false'] }),
  RandomizedDelaySec: k('unitHelp_timer_RandomizedDelaySec', { form: true }),
  Unit: k('unitHelp_timer_Unit', { form: true }),
}

const SOCKET: Record<string, KeyDoc> = {
  ListenStream: k('unitHelp_socket_ListenStream', { multi: true, form: true }),
  Accept: k('unitHelp_socket_Accept', { form: true, options: ['', 'yes', 'no'] }),
}

const INSTALL: Record<string, KeyDoc> = {
  WantedBy: k('unitHelp_install_WantedBy', {
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
    if (e.kind === 'invalid') out.push({ line: e.start + 1, severity: 'error', message: msg('unitFiles_check_invalidLine') })
    if (e.kind !== 'kv') continue
    if (!e.section) {
      out.push({ line: e.start + 1, severity: 'error', message: msg('unitFiles_check_keyBeforeSection', { key: e.key ?? '' }) })
      continue
    }
    const id = `${e.section}.${e.key}`
    if (!e.value) reset.add(id)
    else if (kind === 'dropin' && LIST_KEYS.has(e.key!) && !reset.has(id))
      out.push({
        line: e.start + 1,
        severity: 'warning',
        message: msg('unitFiles_check_overrideAppends', { key: e.key ?? '' }),
      })
  }
  if (kind === 'fragment' && !parseIni(text).some((e) => e.kind === 'section')) out.push({ severity: 'error', message: msg('unitFiles_check_noSection') })
  return out
}

/** Starting points for new units (labels follow the viewer's language when read). */
export const UNIT_TEMPLATES: { id: string; readonly label: string; suffix: string; content: (name: string) => string }[] = [
  {
    id: 'daemon',
    get label() {
      return msg('unitFiles_template_service')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nRestart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'oneshot',
    get label() {
      return msg('unitFiles_template_oneshot')
    },
    suffix: 'service',
    content: (n) => `[Unit]\nDescription=${n}\nAfter=local-fs.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/local/bin/${n}.sh\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'hardened',
    get label() {
      return msg('unitFiles_template_hardened')
    },
    suffix: 'service',
    content: (n) =>
      `[Unit]\nDescription=${n}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/${n}\nUser=nobody\nRestart=on-failure\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/var/lib/${n}\n\n[Install]\nWantedBy=multi-user.target\n`,
  },
  {
    id: 'empty',
    get label() {
      return msg('timers_cron_empty')
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
