// Caddyfile: find the site blocks, recognise the simple "domain → upstream"
// ones, and change them without touching anything else in the file.
// Everything that is not a plain `reverse_proxy` block (global options,
// snippets, imports, matchers, headers …) is kept as written and only
// editable as text.

import { msg } from './i18n'
import { getValues } from './ini'
import type { Revision } from './quadlets'

export type CaddyBlockKind = 'proxy' | 'site' | 'global' | 'snippet' | 'import'

export interface CaddyBlock {
  kind: CaddyBlockKind
  /** Site addresses (proxy/site), snippet name, or the import line. */
  addresses: string[]
  /** proxy only. */
  upstreams?: string[]
  /** Character range in the file, end exclusive. */
  start: number
  end: number
  line: number
  text: string
}

export interface ParsedCaddyfile {
  blocks: CaddyBlock[]
  /** Text outside of blocks that is not a comment (e.g. a single site without braces): only text editing. */
  unstructured: boolean
}

/** Where the Caddyfile was found. */
export interface CaddySource {
  path: string
  how: 'env' | 'manual' | 'quadlet' | 'service' | 'default'
  /** quadlet: file, container name, image and the path inside the container. */
  quadlet?: string
  container?: string
  image?: string
  containerPath?: string
}

export interface CaddyState {
  source?: CaddySource
  /** Why nothing was found / why it cannot be edited. */
  problem?: string
  /** Not mounted into the container: changes would be lost with the next start. */
  readonly?: string
  content?: string
  /** Of the content, sent back with a change so an edit in between is noticed. */
  hash?: string
  blocks: CaddyBlock[]
  unstructured: boolean
  running: boolean
  /** How a change goes live. */
  reload: 'api' | 'container' | 'service' | 'none'
  history: Revision[]
  /** A path picked in the UI exists (shown with "back to automatic"). */
  manual?: string
}

export type CaddyChange = { kind: 'site'; /** First address of the block to replace; empty = new. */ previous?: string; addresses: string[]; upstreams: string[] } | { kind: 'delete'; address: string } | { kind: 'text'; content: string }

export interface CaddyResult {
  state: CaddyState
  /** api | container | service | none */
  reloaded: CaddyState['reload']
  /** Saved, but something was not checked or not reloaded. */
  warning?: string
}

/** Same hash in the browser and on the server (FNV-1a, enough to notice a change). */
export function contentHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0') + text.length.toString(16)
}

// ---------- parsing ----------

const lineOf = (text: string, pos: number) => text.slice(0, pos).split('\n').length

/** Index after the closing brace that matches the one at `open`, or -1. Skips quotes, comments and heredocs. */
function matchBrace(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === '`') {
      const close = text.indexOf(c, i + 1)
      i = close < 0 ? text.length : close + 1
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (c === '<' && text[i + 1] === '<') {
      const m = /^<<([A-Za-z0-9_]+)/.exec(text.slice(i))
      if (m) {
        const end = new RegExp(`\\n\\s*${m[1]}(?=\\s|$)`).exec(text.slice(i))
        i = end ? i + end.index + end[0].length : text.length
        continue
      }
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/** Inner lines of a block without comments and blank lines. */
function bodyLines(block: string): string[] {
  const inner = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'))
  return inner
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
}

const UPSTREAM_TOKEN = /^(?:(?:https?|h2c):\/\/)?(?:\[[0-9a-f:]+\]|[A-Za-z0-9_.-]+)(?::\d{1,5})?$|^unix\/\/\S+$/

function proxyUpstreams(block: string): string[] | undefined {
  const lines = bodyLines(block)
  if (lines.length !== 1) return undefined
  const tokens = lines[0]!.split(/\s+/)
  if (tokens[0] !== 'reverse_proxy' || tokens.length < 2) return undefined
  const ups = tokens.slice(1)
  return ups.every((u) => UPSTREAM_TOKEN.test(u)) ? ups : undefined
}

export function parseCaddyfile(text: string): ParsedCaddyfile {
  const blocks: CaddyBlock[] = []
  let unstructured = false
  let i = 0
  while (i < text.length) {
    // Skip whitespace and comment lines between blocks.
    const ws = /^(?:\s+|#[^\n]*)/.exec(text.slice(i))
    if (ws) {
      i += ws[0].length
      continue
    }
    const nl = text.indexOf('\n', i)
    const lineEnd = nl < 0 ? text.length : nl
    const line = text.slice(i, lineEnd)
    const brace = line
      .replace(/\s#.*$/, '')
      .trimEnd()
      .endsWith('{')
      ? i + line.replace(/\s#.*$/, '').trimEnd().length - 1
      : -1
    if (brace < 0) {
      const head = line.replace(/\s#.*$/, '').trim()
      if (/^import\s+\S/.test(head)) blocks.push({ kind: 'import', addresses: [head], start: i, end: lineEnd, line: lineOf(text, i), text: line })
      else unstructured = true
      i = lineEnd
      continue
    }
    const end = matchBrace(text, brace)
    if (end < 0) {
      unstructured = true
      break
    }
    const header = text.slice(i, brace).trim()
    const blockText = text.slice(i, end)
    const base = { start: i, end, line: lineOf(text, i), text: blockText }
    if (!header) blocks.push({ ...base, kind: 'global', addresses: [] })
    else if (/^&?\(.+\)$/.test(header)) blocks.push({ ...base, kind: 'snippet', addresses: [header] })
    else {
      const addresses = header.split(/[\s,]+/).filter(Boolean)
      const upstreams = proxyUpstreams(blockText)
      blocks.push(upstreams ? { ...base, kind: 'proxy', addresses, upstreams } : { ...base, kind: 'site', addresses })
    }
    i = end
  }
  return { blocks, unstructured }
}

// ---------- changes ----------

const ADDRESS = /^(?:https?:\/\/)?(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$|^:\d{1,5}$/

export function addressProblem(a: string): string | undefined {
  if (!a) return msg('proxy_errors_domainMissing')
  if (!ADDRESS.test(a)) return msg('proxy_errors_badAddress', { a })
  return undefined
}

export function upstreamProblem(u: string): string | undefined {
  if (!u) return msg('proxy_errors_targetMissing')
  if (!UPSTREAM_TOKEN.test(u) || (!u.startsWith('unix//') && !/:\d{1,5}$/.test(u) && !/^https?:\/\//.test(u))) return msg('proxy_errors_badTarget', { u })
  return undefined
}

export const renderSite = (addresses: string[], upstreams: string[]) => `${addresses.join(', ')} {\n\treverse_proxy ${upstreams.join(' ')}\n}`

const tidy = (text: string) =>
  text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s*$/, '\n')

/** The file after a form change. Throws with a message the UI can show. */
export function applyCaddyChange(text: string, change: CaddyChange): string {
  if (change.kind === 'text') return change.content.endsWith('\n') ? change.content : change.content + '\n'
  const { blocks } = parseCaddyfile(text)
  const sites = blocks.filter((b) => b.kind === 'proxy' || b.kind === 'site')
  const find = (address: string) => sites.find((b) => b.addresses.includes(address))
  if (change.kind === 'delete') {
    const b = find(change.address)
    if (!b) throw new Error(msg('proxy_errors_notInFile', { a: change.address }))
    return tidy(text.slice(0, b.start) + text.slice(b.end))
  }
  const addresses = change.addresses.map((a) => a.trim()).filter(Boolean)
  const upstreams = change.upstreams.map((u) => u.trim()).filter(Boolean)
  if (!addresses.length) throw new Error(msg('proxy_errors_domainMissing'))
  if (!upstreams.length) throw new Error(msg('proxy_errors_targetMissing'))
  for (const a of addresses) {
    const p = addressProblem(a)
    if (p) throw new Error(p)
  }
  for (const u of upstreams) {
    const p = upstreamProblem(u)
    if (p) throw new Error(p)
  }
  const previous = change.previous ? find(change.previous) : undefined
  if (change.previous && !previous) throw new Error(msg('proxy_errors_notInFile', { a: change.previous! }))
  if (previous && previous.kind !== 'proxy') throw new Error(msg('proxy_errors_custom', { a: change.previous! }))
  for (const a of addresses) {
    const other = find(a)
    if (other && other !== previous) throw new Error(msg('proxy_errors_exists', { a, line: other.line }))
  }
  const block = renderSite(addresses, upstreams)
  if (previous) return text.slice(0, previous.start) + block + text.slice(previous.end)
  return tidy(`${text.replace(/\s*$/, '')}\n\n${block}\n`)
}

// ---------- finding the file ----------

export const DEFAULT_CADDYFILE = '/etc/caddy/Caddyfile'

/** Official image and common forks (caddy:2, caddy-cloudflare, …/caddy-docker-proxy is not a Caddyfile setup). */
export function isCaddyImage(image: string): boolean {
  const name = image.split('@')[0]!.split('/').pop()!.split(':')[0]!
  return /^caddy(?:-[a-z0-9-]+)?$/.test(name) && !/docker-proxy/.test(name)
}

/** `--config <path>` / `--config=<path>` from a caddy command line; adapter must be the Caddyfile one. */
export function configFromCommand(cmd: string): { path?: string; json?: boolean } {
  const m = /(?:^|\s)--config(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(cmd)
  const adapter = /(?:^|\s)--adapter(?:=|\s+)(\S+)/.exec(cmd)?.[1]
  const path = m?.[1]?.replace(/^["']|["']$/g, '')
  return { path, json: (!!path && path.endsWith('.json') && !adapter) || (!!adapter && adapter !== 'caddyfile') }
}

export interface QuadletCaddy {
  quadlet: string
  image: string
  container: string
  containerPath: string
  /** Host path; undefined when the file is not mounted. */
  hostPath?: string
  /** Named volume holding it (resolved on the host with podman). */
  volume?: { name: string; rest: string }
  /** Volume mounts as written, for checking with the same layout. */
  volumes: string[]
  json?: boolean
}

/** Splits a Quadlet Volume= value: source:destination[:options]. */
function splitVolume(v: string): { src: string; dst: string } | undefined {
  const parts = v.split(':')
  if (parts.length < 2) return undefined
  return { src: parts[0]!, dst: parts[1]! }
}

/** The Caddyfile of a Caddy Quadlet: path inside the container, mapped to the host through Volume=. */
export function caddyFromQuadlet(name: string, content: string): QuadletCaddy | undefined {
  const image = getValues(content, 'Container', 'Image').at(-1)
  if (!image || !isCaddyImage(image)) return undefined
  const exec = getValues(content, 'Container', 'Exec').at(-1) ?? ''
  const fromExec = configFromCommand(exec)
  const containerPath = fromExec.path ?? DEFAULT_CADDYFILE
  const container = getValues(content, 'Container', 'ContainerName').at(-1) || `systemd-${name.replace(/\.container$/, '')}`
  const volumes = getValues(content, 'Container', 'Volume')
  const out: QuadletCaddy = { quadlet: name, image, container, containerPath, volumes, json: fromExec.json }
  // The most specific mount wins (a file mount over a directory mount).
  let best = -1
  for (const v of volumes) {
    const s = splitVolume(v)
    if (!s) continue
    const dst = s.dst.replace(/\/+$/, '')
    const rest = containerPath === dst ? '' : containerPath.startsWith(`${dst}/`) ? containerPath.slice(dst.length) : undefined
    if (rest === undefined || dst.length <= best) continue
    best = dst.length
    if (s.src.startsWith('/')) {
      out.hostPath = s.src.replace(/\/+$/, '') + rest
      out.volume = undefined
    } else {
      out.hostPath = undefined
      out.volume = { name: s.src, rest }
    }
  }
  return out
}

/** A path picked by hand: absolute, plausible as a Caddyfile, not in a system directory. */
export function manualPathProblem(path: string): string | undefined {
  if (!path.startsWith('/') || path.includes('\0') || /(^|\/)\.\.(\/|$)/.test(path)) return msg('proxy_errors_absolute')
  if (/^\/(proc|sys|dev|run|boot)(\/|$)/.test(path)) return msg('proxy_errors_systemDir')
  const base = path.split('/').pop() ?? ''
  if (!/caddy/i.test(base)) return msg('proxy_errors_fileName')
  return undefined
}

/** A change as it arrives over HTTP / the helper socket. */
export function parseCaddyChange(v: unknown): CaddyChange {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const strs = (x: unknown) => (Array.isArray(x) && x.length <= 20 && x.every((s) => typeof s === 'string' && s.length <= 300) ? (x as string[]) : undefined)
  if (o.kind === 'text' && typeof o.content === 'string') return { kind: 'text', content: o.content }
  if (o.kind === 'delete' && typeof o.address === 'string') return { kind: 'delete', address: o.address }
  if (o.kind === 'site') {
    const addresses = strs(o.addresses)
    const upstreams = strs(o.upstreams)
    if (addresses && upstreams && (o.previous === undefined || typeof o.previous === 'string')) return { kind: 'site', previous: (o.previous as string | undefined) || undefined, addresses, upstreams }
  }
  throw new Error(msg('proxy_errors_invalidChange'))
}
