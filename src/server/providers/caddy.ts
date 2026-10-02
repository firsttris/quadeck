// Caddy provider: reads routes from the admin API (GET /config/). If the API
// is not reachable, falls back to `caddy adapt` and finally to a small
// built-in Caddyfile reader (covers Caddy running in a container, where
// neither the API nor the binary is available on the host).

import { existsSync, readFileSync } from 'node:fs'
import { run } from '../exec'
import type { DiscoveryProvider, ServiceCandidate } from './types'
import { tr } from '~/shared/i18n'

interface CaddyRoute {
  match?: { host?: string[]; path?: string[] }[]
  handle?: CaddyHandler[]
  terminal?: boolean
}

interface CaddyHandler {
  handler: string
  routes?: CaddyRoute[]
  upstreams?: { dial?: string }[]
}

interface CaddyServer {
  listen?: string[]
  routes?: CaddyRoute[]
  automatic_https?: { disable?: boolean }
  tls_connection_policies?: unknown[]
}

interface CaddyConfig {
  apps?: { http?: { servers?: Record<string, CaddyServer> } }
}

const isWildcardOrIp = (h: string) => h.includes('*') || /^[\d.]+$/.test(h) || h.includes(':')

function pathPrefix(paths: string[] | undefined): string {
  const p = paths?.[0]
  if (!p || p === '/*' || p === '*') return ''
  return p.replace(/\*+$/, '').replace(/\/$/, '')
}

/** Walks the JSON config, carrying host/path matchers down into subroutes. */
export function candidatesFromConfig(cfg: CaddyConfig): ServiceCandidate[] {
  const out = new Map<string, ServiceCandidate>()
  for (const server of Object.values(cfg.apps?.http?.servers ?? {})) {
    const listen = server.listen ?? []
    const https = (listen.some((l) => l.endsWith(':443')) || !!server.tls_connection_policies?.length) && !server.automatic_https?.disable
    const plainPort = listen.map((l) => l.split(':').pop()).find((p) => p && p !== '80' && p !== '443')
    const scheme = https ? 'https' : 'http'
    const portSuffix = plainPort ? `:${plainPort}` : ''

    const walk = (routes: CaddyRoute[] | undefined, hosts: string[], path: string) => {
      for (const r of routes ?? []) {
        const m = r.match?.[0]
        const rHosts = m?.host?.length ? m.host : hosts
        const rPath = m?.path ? pathPrefix(m.path) || path : path
        for (const h of r.handle ?? []) {
          if (h.handler === 'subroute') walk(h.routes, rHosts, rPath)
          if (h.handler === 'reverse_proxy') {
            const ups = (h.upstreams ?? []).map((u) => u.dial).filter((d): d is string => !!d)
            for (const host of rHosts) {
              if (isWildcardOrIp(host) || !ups.length) continue
              const url = `${scheme}://${host}${portSuffix}${rPath}`
              const prev = out.get(url)
              if (prev) prev.upstreams.push(...ups.filter((u) => !prev.upstreams.includes(u)))
              else out.set(url, { host, url, upstreams: ups, provider: 'caddy' })
            }
          }
        }
      }
    }
    walk(server.routes, [], '')
  }
  return [...out.values()]
}

// ---------- minimal Caddyfile reader ----------

/** Tokens incl. "{", "}" and "\n" (statement ends). Comments stripped, quotes removed. */
function tokenize(src: string): string[] {
  const out: string[] = []
  for (const raw of src.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    for (const t of line.match(/"[^"]*"|\{\$[^}]*\}|\{|\}|[^\s{}]+(?:\{[^}\s]*\}[^\s{}]*)*/g) ?? []) out.push(t.replace(/^"|"$/g, ''))
    out.push('\n')
  }
  return out
}

function normaliseUpstream(u: string): string {
  return u.replace(/^(h2c|https?):\/\//, '').replace(/\/.*$/, '')
}

/** Expands {$ENV} / {$ENV:default} placeholders like Caddy does at parse time. */
function expandEnv(t: string): string | undefined {
  let missing = false
  const v = t.replace(/\{\$([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (_, k: string, d?: string) => {
    const e = process.env[k] ?? d
    if (e === undefined) missing = true
    return e ?? ''
  })
  return missing ? undefined : v
}

function siteHost(addr: string): { host: string; scheme: string; port?: string } | undefined {
  let a = addr.replace(/,$/, '')
  let scheme = 'https'
  const m = a.match(/^(https?):\/\//)
  if (m) {
    scheme = m[1]!
    a = a.slice(m[0].length)
  }
  a = a.replace(/\/.*$/, '')
  const [host, port] = a.split(/:(?=\d+$)/)
  if (!host) return undefined
  if (port === '80') scheme = 'http'
  return { host, scheme, port: port && port !== '80' && port !== '443' ? port : undefined }
}

const cleanPath = (p: string) => p.replace(/\*+$/, '').replace(/\/$/, '')

/**
 * Small Caddyfile reader for the common cases: site blocks, `reverse_proxy`
 * (with optional path matcher and option block), `handle`/`handle_path`/`route`
 * with a path, named host matchers (`@x host a.example` + `handle @x`), and
 * {$ENV} placeholders. Anything else is ignored.
 */
export function candidatesFromCaddyfile(src: string): ServiceCandidate[] {
  const out: ServiceCandidate[] = []
  let depth = 0
  let site: { addrs: NonNullable<ReturnType<typeof siteHost>>[]; matchers: Map<string, string[]> } | undefined
  // Per block depth: path prefix and host override from the enclosing handle/route.
  const pathAt: string[] = []
  const hostsAt: (string[] | undefined)[] = []

  const emit = (upstreams: string[], inlinePath?: string) => {
    if (!site || !upstreams.length) return
    const path = inlinePath ?? pathAt.slice(1, depth + 1).filter(Boolean).pop() ?? ''
    const override = hostsAt.slice(1, depth + 1).filter(Boolean).pop()
    const targets = override ? override.map((h) => ({ host: h, scheme: site!.addrs[0]?.scheme ?? 'https', port: site!.addrs[0]?.port })) : site.addrs
    for (const a of targets) {
      if (isWildcardOrIp(a.host)) continue
      out.push({ host: a.host, url: `${a.scheme}://${a.host}${a.port ? ':' + a.port : ''}${path}`, upstreams, provider: 'caddy' })
    }
  }

  const statement = (toks: string[], opensBlock: boolean) => {
    if (!toks.length) return
    if (depth === 0) {
      if (!opensBlock) return
      if (toks[0]!.startsWith('(')) {
        site = undefined // snippet
        return
      }
      const addrs = toks
        .flatMap((t) => t.split(','))
        .filter(Boolean)
        .map((t) => expandEnv(t))
        .map((t) => (t ? siteHost(t) : undefined))
        .filter((x): x is NonNullable<typeof x> => !!x)
      site = addrs.length ? { addrs, matchers: new Map() } : undefined
      return
    }
    if (!site) return
    const [dir, ...args] = toks
    if (dir!.startsWith('@') && args[0] === 'host') site.matchers.set(dir!, args.slice(1))
    if (opensBlock && (dir === 'handle' || dir === 'handle_path' || dir === 'route')) {
      if (args[0]?.startsWith('/')) pathAt[depth + 1] = cleanPath(args[0])
      if (args[0]?.startsWith('@') && site.matchers.has(args[0])) hostsAt[depth + 1] = site.matchers.get(args[0])
    }
    if (dir === 'reverse_proxy') {
      let rest = args
      let inlinePath: string | undefined
      if (rest[0]?.startsWith('/') || rest[0]?.startsWith('@') || rest[0] === '*') {
        if (rest[0]!.startsWith('/')) inlinePath = cleanPath(rest[0]!)
        rest = rest.slice(1)
      }
      emit(rest.map(normaliseUpstream).filter(Boolean), inlinePath)
    }
  }

  let stmt: string[] = []
  for (const t of tokenize(src)) {
    if (t === '{') {
      statement(stmt, true)
      stmt = []
      depth++
    } else if (t === '}') {
      statement(stmt, false)
      stmt = []
      pathAt[depth] = ''
      hostsAt[depth] = undefined
      depth = Math.max(0, depth - 1)
      if (depth === 0) site = undefined
    } else if (t === '\n') {
      statement(stmt, false)
      stmt = []
    } else {
      stmt.push(t)
    }
  }

  const merged = new Map<string, ServiceCandidate>()
  for (const c of out) {
    const prev = merged.get(c.url)
    if (prev) prev.upstreams.push(...c.upstreams.filter((u) => !prev.upstreams.includes(u)))
    else merged.set(c.url, { ...c, upstreams: [...c.upstreams] })
  }
  return [...merged.values()]
}

export class CaddyProvider implements DiscoveryProvider {
  name = 'caddy'
  /** Which source produced the last result, for the status line in the UI. */
  lastSource: 'api' | 'adapt' | 'caddyfile' | undefined

  constructor(
    private adminUrl: string,
    private caddyfile: string,
  ) {}

  async discover(): Promise<ServiceCandidate[]> {
    const errors: string[] = []
    try {
      const res = await fetch(`${this.adminUrl.replace(/\/$/, '')}/config/`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.lastSource = 'api'
      return candidatesFromConfig((await res.json()) as CaddyConfig)
    } catch (e) {
      errors.push(`Admin-API ${this.adminUrl}: ${(e as Error).message}`)
    }
    if (existsSync(this.caddyfile)) {
      const adapted = await run(['caddy', 'adapt', '--config', this.caddyfile, '--adapter', 'caddyfile'])
      if (adapted.code === 0) {
        this.lastSource = 'adapt'
        return candidatesFromConfig(JSON.parse(adapted.stdout) as CaddyConfig)
      }
      this.lastSource = 'caddyfile'
      return candidatesFromCaddyfile(readFileSync(this.caddyfile, 'utf8'))
    }
    errors.push(tr(`kein Caddyfile unter ${this.caddyfile}`, `no Caddyfile at ${this.caddyfile}`))
    this.lastSource = undefined
    throw new Error(errors.join('; '))
  }
}
