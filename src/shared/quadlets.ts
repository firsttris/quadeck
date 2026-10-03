// Quadlet files and Podman settings: types shared by the editor UI, the web
// app and the root helper.

import { msg } from './i18n'

export const QUADLET_TYPES = ['container', 'pod', 'network', 'volume', 'kube', 'image', 'build'] as const
export type QuadletType = (typeof QUADLET_TYPES)[number]

/** File name inside the Quadlet directory, optionally one sub-directory deep. */
export const QUADLET_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.(container|pod|network|volume|kube|image|build)$/

export function assertQuadletName(name: string) {
  if (!QUADLET_NAME.test(name) || name.includes('..')) throw new Error(msg('quadlets_error_invalidFileName', { name }))
}

export function quadletType(name: string): QuadletType {
  return name.split('.').pop() as QuadletType
}

/** systemd unit Quadlet generates for a file (without ServiceName=). */
export function quadletUnit(name: string): string {
  const base = name
    .split('/')
    .pop()!
    .replace(/\.[^.]+$/, '')
  const t = quadletType(name)
  return t === 'container' || t === 'kube' ? `${base}.service` : `${base}-${t}.service`
}

export interface QuadletFile {
  name: string
  type: QuadletType
  unit: string
  size: number
  mtime: number
}

export interface Diagnostic {
  line?: number
  severity: 'error' | 'warning'
  message: string
}

export interface ValidateResult {
  ok: boolean
  diagnostics: Diagnostic[]
  /** Generated systemd unit (podman-system-generator --dryrun), if available. */
  generated?: string
}

export interface Revision {
  id: string
  date: number
  message: string
}

export type PodmanConfigName = 'containers.conf' | 'registries.conf' | 'storage.conf'
export const EDITABLE_CONFIGS: PodmanConfigName[] = ['containers.conf', 'registries.conf']

export interface PodmanConfigFile {
  name: PodmanConfigName
  path: string
  exists: boolean
  content: string
  editable: boolean
}

export interface PodmanSettings {
  version?: string
  quadletDir: string
  /** git keeps the history of the Quadlet directory. */
  history: boolean
  timer: { exists: boolean; enabled: boolean; active: boolean; calendar: string; custom: boolean; next?: number }
  autoUpdateDefault: { supported: boolean; enabled: boolean; path: string }
  files: PodmanConfigFile[]
}

export interface ComposeResult {
  files: { name: string; content: string }[]
  warnings: string[]
}
