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
  /** proxy only: the options the dialog shows (everything else is kept in `extra`). */
  options?: SiteOptions
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

/** What the site dialog edits besides domains and targets. */
export interface SiteOptions {
  /** Only from private addresses (LAN, VPN); everyone else gets 403. */
  lanOnly: boolean
  /** encode zstd gzip */
  compress: boolean
  /** The target speaks HTTPS with a self-signed certificate (Proxmox, UniFi …). */
  insecureTls: boolean
  /** Certificate from Caddy's own CA, for names that do not exist on the internet. */
  tlsInternal: boolean
  /** basic_auth with one user; `password` is turned into `hash` on the server, never written. */
  auth?: { user: string; hash?: string; password?: string }
  /** Lines inside reverse_proxy { } the dialog does not know (header_up …). */
  proxyExtra: string
  /** Other directives of the block, as written. */
  extra: string
}

export const NO_OPTIONS: SiteOptions = { lanOnly: false, compress: false, insecureTls: false, tlsInternal: false, proxyExtra: '', extra: '' }

export type CaddyChange = { kind: 'site'; /** First address of the block to replace; empty = new. */ previous?: string; addresses: string[]; upstreams: string[]; options?: SiteOptions } | { kind: 'delete'; address: string } | { kind: 'text'; content: string } | { kind: 'block'; /** A domain of the block to replace. */ address: string; text: string }

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

/** Top-level directives of a block body: a line, or a line ending in "{" with everything up to its "}". Indentation removed. */
export function directives(body: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let depth = 0
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line && !depth) continue
    cur.push(line)
    const code = line.replace(/(^|\s)#.*$/, '').replace(/"[^"]*"|`[^`]*`/g, '')
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length
    if (depth <= 0) {
      out.push(indentLines(cur))
      cur = []
      depth = 0
    }
  }
  if (cur.length) out.push(indentLines(cur))
  return out
}

/** Lines of a directive with nested blocks indented by tabs again. */
function indentLines(lines: string[]): string {
  let depth = 0
  return lines
    .map((l) => {
      if (/^\}/.test(l)) depth = Math.max(0, depth - 1)
      const out = `${'\t'.repeat(depth)}${l}`
      const code = l.replace(/(^|\s)#.*$/, '').replace(/"[^"]*"|`[^`]*`/g, '')
      depth = Math.max(0, depth + (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length + (/^\}/.test(l) ? 1 : 0))
      return out
    })
    .join('\n')
}

const innerOf = (directive: string) => directive.slice(directive.indexOf('{') + 1, directive.lastIndexOf('}'))
const headOf = (directive: string) =>
  directive
    .split('\n')[0]!
    .replace(/(^|\s)#.*$/, '')
    .replace(/\s*\{\s*$/, '')
    .trim()
const BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/

/** Domains → targets with the options the dialog knows; undefined when the block is more than that (then: text). */
export function siteForm(block: string): { upstreams: string[]; options: SiteOptions } | undefined {
  const dirs = directives(innerOf(block))
  const opts: SiteOptions = { ...NO_OPTIONS }
  const extra: string[] = []
  let upstreams: string[] | undefined
  const matchers = new Map<string, number>()
  for (const [i, d] of dirs.entries()) {
    const tokens = headOf(d).split(/\s+/)
    const hasBlock = d.includes('\n') || /\{\s*$/.test(d.split('\n')[0]!.replace(/(^|\s)#.*$/, ''))
    if (tokens[0] === 'reverse_proxy') {
      const ups = tokens.slice(1)
      // a second one, or one with a matcher: more than the dialog can show
      if (upstreams || !ups.length || !ups.every((u) => UPSTREAM_TOKEN.test(u))) return undefined
      upstreams = ups
      if (hasBlock) {
        const rest: string[] = []
        for (const sub of directives(innerOf(d))) {
          const t = headOf(sub).split(/\s+/)
          const inner = sub.includes('{') ? directives(innerOf(sub)) : []
          if (t[0] === 'transport' && t[1] === 'http' && t.length === 2 && inner.length === 1 && inner[0] === 'tls_insecure_skip_verify') opts.insecureTls = true
          else rest.push(sub)
        }
        opts.proxyExtra = rest.join('\n')
      }
    } else if (tokens[0] === 'encode' && !hasBlock && tokens.length > 1 && tokens.slice(1).every((t) => t === 'zstd' || t === 'gzip')) opts.compress = true
    else if (tokens.join(' ') === 'tls internal' && !hasBlock) opts.tlsInternal = true
    else if ((tokens[0] === 'basic_auth' || tokens[0] === 'basicauth') && tokens.length === 1 && hasBlock && !opts.auth) {
      const users = directives(innerOf(d))
      const u = users.length === 1 ? users[0]!.split(/\s+/) : []
      if (u.length === 2 && BCRYPT.test(u[1]!)) opts.auth = { user: u[0]!, hash: u[1]! }
      else extra.push(d)
    } else if (/^@\S+$/.test(tokens[0] ?? '') && tokens.slice(1).join(' ') === 'not remote_ip private_ranges' && !hasBlock) matchers.set(tokens[0]!, i)
    else extra.push(d)
  }
  if (!upstreams) return undefined
  // LAN only: the matcher and the 403 for it, as the dialog writes them.
  for (const [name] of matchers) {
    const r = extra.findIndex((d) => d === `respond ${name} 403` || d === `abort ${name}`)
    if (r >= 0 && !opts.lanOnly) {
      extra.splice(r, 1)
      opts.lanOnly = true
    } else extra.push(`${name} not remote_ip private_ranges`)
  }
  opts.extra = extra.join('\n')
  return { upstreams, options: opts }
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
      const form = siteForm(blockText)
      blocks.push(form ? { ...base, kind: 'proxy', addresses, upstreams: form.upstreams, options: form.options } : { ...base, kind: 'site', addresses })
    }
    i = end
  }
  return { blocks, unstructured }
}

// ---------- changes ----------

const ADDRESS = /^(?:https?:\/\/)?(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$|^:\d{1,5}$/

export function addressProblem(a: string): string | undefined {
  if (!a) return msg('proxy_errors_domainMissing')
  if (!ADDRESS.test(a)) return msg('proxy_errors_badAddress', { address: a })
  return undefined
}

export function upstreamProblem(u: string): string | undefined {
  if (!u) return msg('proxy_errors_targetMissing')
  if (!UPSTREAM_TOKEN.test(u) || (!u.startsWith('unix//') && !/:\d{1,5}$/.test(u) && !/^https?:\/\//.test(u))) return msg('proxy_errors_badTarget', { u })
  return undefined
}

const tabbed = (text: string, depth: number) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => '\t'.repeat(depth) + l)

/** A site block from the dialog; the order does not matter to Caddy (it sorts directives itself). */
export function renderSite(addresses: string[], upstreams: string[], o: SiteOptions = NO_OPTIONS): string {
  const lines: string[] = []
  if (o.tlsInternal) lines.push('\ttls internal')
  if (o.lanOnly) lines.push('\t@outside not remote_ip private_ranges', '\trespond @outside 403')
  if (o.auth) lines.push('\tbasic_auth {', `\t\t${o.auth.user} ${o.auth.hash ?? '<bcrypt hash of the new password>'}`, '\t}')
  if (o.compress) lines.push('\tencode zstd gzip')
  const inner = [...(o.insecureTls ? ['transport http {', '\ttls_insecure_skip_verify', '}'] : []), ...tabbed(o.proxyExtra, 0)]
  if (inner.length) lines.push(`\treverse_proxy ${upstreams.join(' ')} {`, ...inner.map((l) => `\t\t${l}`), '\t}')
  else lines.push(`\treverse_proxy ${upstreams.join(' ')}`)
  lines.push(...tabbed(o.extra, 1))
  return `${addresses.join(', ')} {\n${lines.join('\n')}\n}`
}

/** Why the dialog's options cannot be written, or undefined. */
export function optionsProblem(o: SiteOptions): string | undefined {
  if (o.auth) {
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(o.auth.user)) return msg('proxy_errors_authUser')
    if (!o.auth.hash && !o.auth.password) return msg('proxy_errors_authPassword')
    if (o.auth.password !== undefined && o.auth.password.length < 8) return msg('proxy_errors_authShort')
    if (o.auth.hash && !BCRYPT.test(o.auth.hash)) return msg('proxy_errors_authHash')
  }
  for (const t of [o.extra, o.proxyExtra]) {
    const code = t.replace(/(^|\s)#.*$/gm, '').replace(/"[^"]*"|`[^`]*`/g, '')
    if ((code.match(/\{/g) ?? []).length !== (code.match(/\}/g) ?? []).length) return msg('proxy_errors_braces')
  }
  return undefined
}

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
  if (change.kind === 'block') {
    const b = find(change.address)
    if (!b) throw new Error(msg('proxy_errors_notInFile', { address: change.address }))
    const parsed = parseCaddyfile(change.text)
    if (parsed.unstructured || parsed.blocks.length !== 1 || (parsed.blocks[0]!.kind !== 'proxy' && parsed.blocks[0]!.kind !== 'site')) throw new Error(msg('proxy_errors_oneBlock'))
    for (const a of parsed.blocks[0]!.addresses) {
      const other = find(a)
      if (other && other !== b) throw new Error(msg('proxy_errors_exists', { address: a, line: other.line }))
    }
    return text.slice(0, b.start) + change.text.trim() + text.slice(b.end)
  }
  if (change.kind === 'delete') {
    const b = find(change.address)
    if (!b) throw new Error(msg('proxy_errors_notInFile', { address: change.address }))
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
  const options = change.options ?? NO_OPTIONS
  const op = optionsProblem(options)
  if (op) throw new Error(op)
  const previous = change.previous ? find(change.previous) : undefined
  if (change.previous && !previous) throw new Error(msg('proxy_errors_notInFile', { address: change.previous! }))
  if (previous && previous.kind !== 'proxy') throw new Error(msg('proxy_errors_custom', { address: change.previous! }))
  for (const a of addresses) {
    const other = find(a)
    if (other && other !== previous) throw new Error(msg('proxy_errors_exists', { address: a, line: other.line }))
  }
  const block = renderSite(addresses, upstreams, options)
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
  if (o.kind === 'block' && typeof o.address === 'string' && typeof o.text === 'string' && o.text.length <= 64_000) return { kind: 'block', address: o.address, text: o.text }
  if (o.kind === 'site') {
    const addresses = strs(o.addresses)
    const upstreams = strs(o.upstreams)
    if (addresses && upstreams && (o.previous === undefined || typeof o.previous === 'string')) {
      const options = parseOptions(o.options)
      return { kind: 'site', previous: (o.previous as string | undefined) || undefined, addresses, upstreams, ...(options ? { options } : {}) }
    }
  }
  throw new Error(msg('proxy_errors_invalidChange'))
}

function parseOptions(v: unknown): SiteOptions | undefined {
  if (v === undefined) return undefined
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const text = (x: unknown) => (typeof x === 'string' && x.length <= 8000 ? x : '')
  const a = o.auth && typeof o.auth === 'object' ? (o.auth as Record<string, unknown>) : undefined
  const str = (x: unknown) => (typeof x === 'string' && x.length <= 300 ? x : undefined)
  return {
    lanOnly: o.lanOnly === true,
    compress: o.compress === true,
    insecureTls: o.insecureTls === true,
    tlsInternal: o.tlsInternal === true,
    auth: a ? { user: str(a.user) ?? '', hash: str(a.hash), password: str(a.password) } : undefined,
    proxyExtra: text(o.proxyExtra),
    extra: text(o.extra),
  }
}
