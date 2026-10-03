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

/** What else a deleted .container leaves behind, offered for removal in the delete dialog. */
export interface RemovalPlan {
  /** Image= unless it points at an .image/.build file; shared: another Quadlet uses it too. */
  image?: { name: string; shared: boolean }
  /** Named volumes; file: the .volume Quadlet that creates it. Host directories are never in here. */
  volumes: { name: string; file?: string; shared: boolean }[]
  /** Host directories mounted into the container: always kept. */
  binds: string[]
}

const QUADLET_SECTION_OF: Partial<Record<QuadletType, string>> = { container: 'Container', pod: 'Pod' }
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/

function iniValues(text: string, section: string, key: string): string[] {
  let current = ''
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    const sec = /^\[([^\]]+)\]$/.exec(t)
    if (sec) current = sec[1]!
    else if (current === section) {
      const kv = /^([A-Za-z0-9_.-]+)\s*=\s?(.*)$/.exec(t)
      if (kv && kv[1] === key) out.push(kv[2]!.trim())
    }
  }
  return out
}

/** The volumes a Quadlet mounts: podman volume name (and .volume file) or the host directory. */
function mounts(content: string, section: string, files: { name: string; content: string }[]) {
  const named: { name: string; file?: string }[] = []
  const binds: string[] = []
  for (const v of iniValues(content, section, 'Volume')) {
    const parts = v.split(':')
    if (parts.length < 2) continue // anonymous volume
    const src = parts[0]!
    if (/^[/.~%]/.test(src)) binds.push(src)
    else if (src.endsWith('.volume')) {
      const file = files.find((f) => f.name.split('/').pop() === src)
      const name = (file && iniValues(file.content, 'Volume', 'VolumeName')[0]) || `systemd-${src.replace(/\.volume$/, '')}`
      named.push({ name, file: file?.name })
    } else named.push({ name: src })
  }
  return { named, binds }
}

/** files: every Quadlet file with its content, the one being deleted included. */
export function removalPlan(name: string, files: { name: string; content: string }[]): RemovalPlan {
  const self = files.find((f) => f.name === name)
  if (!self || quadletType(name) !== 'container') return { volumes: [], binds: [] }
  const others = files.filter((f) => f.name !== name && (quadletType(f.name) === 'container' || quadletType(f.name) === 'pod'))
  const otherImages = new Set(others.flatMap((f) => iniValues(f.content, 'Container', 'Image')))
  const otherVolumes = new Set(others.flatMap((f) => mounts(f.content, QUADLET_SECTION_OF[quadletType(f.name)]!, files).named.map((v) => v.name)))
  const image = iniValues(self.content, 'Container', 'Image')[0]
  const { named, binds } = mounts(self.content, 'Container', files)
  const seen = new Set<string>()
  return {
    image: image && IMAGE_NAME.test(image) && !/\.(image|build)$/.test(image) ? { name: image, shared: otherImages.has(image) } : undefined,
    volumes: named.filter((v) => VOLUME_NAME.test(v.name) && !seen.has(v.name) && seen.add(v.name)).map((v) => ({ ...v, shared: otherVolumes.has(v.name) })),
    binds: [...new Set(binds)],
  }
}
