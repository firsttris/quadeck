// File explorer: types and checks shared by the page, the web app, the
// root helper and the `quadeck job` runner.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'

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
  if (!name || name === '.' || name === '..') return msg(m.files_check_nameMissing)
  if (name.includes('/')) return msg(m.files_check_nameSlash)
  if (CONTROL.test(name)) return msg(m.files_check_nameControlChars)
  if (new TextEncoder().encode(name).length > 255) return msg(m.files_check_nameTooLong)
  return undefined
}

/** Absolute, normalised path without "..", "." or control characters. */
export function validatePath(path: string): string | undefined {
  if (!path.startsWith('/')) return msg(m.files_check_pathNotAbsolute)
  if (CONTROL.test(path)) return msg(m.files_check_pathControlChars)
  if (path.length > 4096) return msg(m.files_check_pathTooLong)
  if (path.split('/').some((p) => p === '..' || p === '.')) return msg(m.files_check_pathDotDot)
  return undefined
}

export const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`)
export const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/'
export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

// ---------- opening files ----------

/** Larger files are not loaded into the editor. */
export const TEXT_MAX = 2 * 1024 * 1024

const TEXT_EXT =
  /\.(txt|text|md|markdown|rst|log|sh|bash|zsh|fish|py|js|mjs|cjs|ts|tsx|jsx|json|jsonc|yml|yaml|toml|ini|cfg|conf|config|env|properties|xml|html?|svg|css|scss|csv|tsv|patch|diff|sql|nfo|srt|ass|vtt|sub|m3u8?|pls|cue|service|timer|socket|mount|container|pod|network|volume|kube|image|build|rules|desktop|go|rs|c|h|cpp|hpp|java|kt|rb|php|pl|lua|r|ps1|bat|cmd|nix|tf|hcl|gitignore|dockerignore|editorconfig|lock)$/i
const TEXT_NAMES = /^(dockerfile|containerfile|makefile|readme|license|changelog|authors|caddyfile|vagrantfile|procfile|crontab|hosts|fstab|exports|\.[a-z0-9_-]+rc|\.profile|\.bash_\w+)$/i
/** Shown by the browser itself (new tab); HTML and SVG are not – they could run scripts on Quadeck's address. */
const BROWSER_EXT = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|ico|mp4|m4v|webm|mov|ogv|mp3|m4a|aac|flac|wav|ogg|oga|opus)$/i
const BINARY_EXT = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|zst|iso|img|qcow2|vmdk|vdi|mkv|avi|wmv|flv|mpg|mpeg|exe|dll|so|bin|deb|rpm|apk|jar|class|o|a|db|sqlite3?|heic|raw|cr2|nef|dng|psd|docx?|xlsx?|pptx?|odt|ods|odp|ttf|otf|woff2?)$/i

export type FileKind = 'text' | 'browser' | 'binary' | 'unknown'

/** What a click on a file does: text opens in the editor, the rest in the browser or as a download. Unknown ones are sniffed. */
export function fileKind(name: string): FileKind {
  if (BROWSER_EXT.test(name)) return 'browser'
  if (TEXT_EXT.test(name) || TEXT_NAMES.test(name)) return 'text'
  if (BINARY_EXT.test(name)) return 'binary'
  return 'unknown'
}

/** Keys, credentials and secrets: reading them needs an unlock, like every change. */
export function isSensitivePath(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  if (parts.some((p) => /^\.(ssh|gnupg|password-store|aws|kube|azure|docker|pki|cert)$/.test(p))) return true
  return /^(\.env(\..+)?|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|authorized_keys|known_hosts|.*\.(key|pem|p12|pfx|kdbx|keystore|jks|asc|gpg))$/i.test(name)
}

/** First bytes of a file: text if there is no NUL and it is valid UTF-8 (a character cut off at the end is fine). */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  const dec = new TextDecoder('utf-8', { fatal: true })
  for (let cut = 0; cut <= 3 && cut < bytes.length + 1; cut++) {
    try {
      dec.decode(bytes.subarray(0, bytes.length - cut))
      return true
    } catch {
      // try without the last bytes
    }
  }
  return false
}

export interface TextFile {
  path: string
  /** Line endings as \n; `crlf` says the file uses \r\n and gets it back on saving. */
  content: string
  crlf: boolean
  hash: string
  size: number
  mtime: number
  owner: string
  mode: string
  /** Not shown: binary, or larger than TEXT_MAX. */
  refused?: 'binary' | 'tooLarge'
}
