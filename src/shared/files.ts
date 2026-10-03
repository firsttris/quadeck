// File explorer: types and checks shared by the page, the web app, the
// root helper and the `quadeck job` runner.

import { msg } from './i18n'

export interface FileRoot {
  path: string
  label: string
  /** Free / total bytes of the filesystem. */
  free?: number
  size?: number
}

export interface FileEntry {
  name: string
  type: 'dir' | 'file' | 'link' | 'other'
  size: number
  mtime: number
  /** Octal permissions, e.g. "755". */
  mode: string
  owner: string
  group: string
  /** Target of a symlink. */
  target?: string
}

export interface DirListing {
  path: string
  root: string
  entries: FileEntry[]
  /** More entries than shown. */
  truncated: boolean
}

export const MAX_ENTRIES = 5000

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

/** A single new file or folder name (rename, mkdir). */
export function validateName(name: string): string | undefined {
  if (!name || name === '.' || name === '..') return msg('files_nameMissing')
  if (name.includes('/')) return msg('files_nameMustNotContain')
  if (CONTROL.test(name)) return msg('files_controlCharactersName')
  if (new TextEncoder().encode(name).length > 255) return msg('files_nameTooLong')
  return undefined
}

/** Absolute, normalised path without "..", "." or control characters. */
export function validatePath(path: string): string | undefined {
  if (!path.startsWith('/')) return msg('files_pathMustAbsolute')
  if (CONTROL.test(path)) return msg('files_controlCharactersPath')
  if (path.length > 4096) return msg('files_pathTooLong')
  if (path.split('/').some((p) => p === '..' || p === '.')) return msg('files_pathMustNotContain')
  return undefined
}

export const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`)
export const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/'
export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p
