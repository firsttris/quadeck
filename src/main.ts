// Process entry for the single binary: CLI commands plus the HTTP server
// (static client assets + the TanStack Start handler).

import { PEER_HEADER, ensureSetupToken, resetPassword } from './server/auth'
import { config } from './server/config'
import { db } from './server/db'
import { selfUpdate } from './server/update'
import { checkExpectations, doctorReport, formatReport } from './server/doctor'
import { installNoLang, installRequestLang, withRequestLang } from './server/lang'
import { HELPER_UNIT, WEB_UNIT } from './unit-file'
import { serveHelper } from './server/privileged/helper-server'
import { LocalPrivileged } from './server/privileged/local'
import { createGate } from './server/privileged'
import { statSync } from 'node:fs'
import { cleanupSudoers } from './server/packages/aur'
import { runJobCommand } from './server/packages/job'
import { SystemMaintenance } from './server/packages/maintenance'
import { FstabManager, SystemFstabHost } from './server/fstab/backend'
import { SystemBoot } from './server/boot/backend'
import { SystemUsers } from './server/users/backend'
import { SystemHardware } from './server/hardware/collect'
import { SystemPodmanAdmin } from './server/quadlets/backend'
import { SystemShares } from './server/shares/backend'
import { SystemSsh } from './server/ssh/backend'
import { SystemSmart } from './server/smart/backend'
import { SystemFiles } from './server/files/backend'
import { SystemTimers } from './server/timers/backend'
import { SystemUnitEditor } from './server/systemd/editor'
import { SystemNetwork } from './server/network/collect'
import { CaddyManager, SystemCaddyHost } from './server/caddy/backend'
import { SystemBackup, quadletContents } from './server/backup/backend'
import { SystemPower } from './server/smart/power'
import { selfArgv } from './server/packages/jobs'

export interface StartServer {
  fetch(request: Request): Response | Promise<Response>
}

export interface MainOptions {
  server: StartServer
  /** URL path (e.g. "/assets/index-abc.js") → file path (embedded or on disk). */
  assets: Map<string, string>
  version: string
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  // Inline scripts are TanStack's hydration/scroll-restoration bootstrap.
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
}

const MIME: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  png: 'image/png',
  ico: 'image/x-icon',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
}

/** Encodings of the precompressed copies (vite.config.ts), best first. */
const PRECOMPRESSED = [
  ['br', '.br'],
  ['gzip', '.gz'],
] as const

/** Content codings the client accepts (q=0 excluded). */
function acceptedEncodings(req: Request): Set<string> {
  const out = new Set<string>()
  for (const part of (req.headers.get('accept-encoding') ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined)
    if (name && (q === undefined || Number(q) > 0)) out.add(name)
  }
  return out
}

/** A static asset, precompressed if the client takes it; plain otherwise. */
function staticAsset(req: Request, pathname: string, assets: Map<string, string>): Response {
  const ext = pathname.split('.').pop() ?? ''
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  }
  let file = assets.get(pathname)!
  const variants = PRECOMPRESSED.filter(([, suffix]) => assets.has(pathname + suffix))
  if (variants.length) {
    headers.vary = 'accept-encoding'
    const accepted = acceptedEncodings(req)
    const hit = variants.find(([enc]) => accepted.has(enc))
    if (hit) {
      headers['content-encoding'] = hit[0]
      file = assets.get(pathname + hit[1])!
    }
  }
  // Security headers set here directly: rebuilt by withHeaders(), the file would lose its length.
  return new Response(Bun.file(file), { headers: { ...SECURITY_HEADERS, ...headers } })
}

/**
 * Server-rendered pages are gzipped when the client takes it. Only complete
 * HTML documents: event streams and other streamed or binary bodies pass as they are.
 */
async function compressHtml(req: Request, res: Response): Promise<Response> {
  const type = res.headers.get('content-type') ?? ''
  if (res.status !== 200 || !res.body || !type.startsWith('text/html') || res.headers.has('content-encoding') || req.method !== 'GET') return res
  const h = new Headers(res.headers)
  h.append('vary', 'accept-encoding')
  if (!acceptedEncodings(req).has('gzip')) return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  const body = new Uint8Array(await res.arrayBuffer())
  if (body.length < 1024) return new Response(body, { status: res.status, statusText: res.statusText, headers: h })
  h.set('content-encoding', 'gzip')
  h.delete('content-length')
  return new Response(Bun.gzipSync(body), { status: res.status, statusText: res.statusText, headers: h })
}

function withHeaders(res: Response): Response {
  // Responses from fetch()/static files may have immutable headers.
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

export function serve(opts: MainOptions) {
  const cfg = config()
  db() // open + migrate before the first request
  const token = ensureSetupToken()
  installRequestLang()
  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 255, // SSE streams send a ping every 15–20 s
    async fetch(req, srv) {
      const url = new URL(req.url)
      if ((req.method === 'GET' || req.method === 'HEAD') && opts.assets.has(url.pathname)) return staticAsset(req, url.pathname, opts.assets)
      const headers = new Headers(req.headers)
      headers.delete(PEER_HEADER)
      headers.set(PEER_HEADER, srv.requestIP(req)?.address ?? 'unknown')
      const forwarded = new Request(req, { headers })
      try {
        return withHeaders(await compressHtml(req, await withRequestLang(req, () => opts.server.fetch(forwarded))))
      } catch (e) {
        console.error('[quadeck]', e)
        return withHeaders(new Response('Internal error', { status: 500 }))
      }
    },
  })
  console.log(`[quadeck] ${opts.version} listening on http://${cfg.host}:${server.port} (data: ${cfg.dataDir}${cfg.readonly ? ', read-only' : ''})`)
  // The token itself is not logged: the journal is readable by more than root.
  if (token) console.log(`[quadeck] No password set yet. Setup link (as root): quadeck setup-token`)
  // Start the collectors right away instead of on the first page view.
  void opts.server.fetch(new Request(`http://127.0.0.1:${server.port}/api/health`, { headers: { [PEER_HEADER]: '127.0.0.1' } }))
  return server
}

const HELP = `quadeck – dashboard for Podman servers with Quadlets

  quadeck [serve]        start the server (default)
  quadeck setup-token    print the token for the first setup
  quadeck passwd         reset the password (set it up again via /setup)
  quadeck helper         start the root helper (as root, Unix socket)
  quadeck print-unit web|helper   print a systemd unit (for install.sh)
  quadeck backup run|check   run the backup or check its repository (started by its timer)
  quadeck doctor [--json]   show what Quadeck finds on this system (distribution, package manager, Podman …)
  quadeck update         download the latest version from GitHub and restart the service
  quadeck version        print the version

Environment: QUADECK_HOST (0.0.0.0), QUADECK_PORT (8484), QUADECK_DATA_DIR (/var/lib/quadeck),
          QUADECK_READONLY, QUADECK_PODMAN_SOCKET, QUADECK_CADDY_ADMIN, QUADECK_CADDYFILE,
          QUADECK_UNLOCK, QUADECK_PACKAGE_MANAGER, QUADECK_AUR_USER, QUADECK_QUADLET_DIR`

/**
 * CLI commands that touch the database run as the owner of the data
 * directory (user "quadeck"), so root never creates files the web app
 * cannot open (database, WAL, setup token).
 */
function dropToDataOwner() {
  if (process.getuid?.() !== 0) return
  try {
    const st = statSync(config().dataDir)
    if (st.uid !== 0) {
      process.setgid?.(st.gid)
      process.setuid?.(st.uid)
    }
  } catch {
    // no data directory yet: stay root (first start creates it)
  }
}

export async function main(argv: string[], opts: MainOptions) {
  process.umask(0o077) // database, WAL files, tokens and icon cache: root only
  const cmd = argv[0] ?? 'serve'
  switch (cmd) {
    case 'serve':
      serve(opts)
      return
    case 'version':
    case '--version':
    case '-v':
      console.log(opts.version)
      return
    case 'setup-token': {
      dropToDataOwner()
      db()
      const t = ensureSetupToken()
      console.log(t ?? 'Password is already set (reset it with: quadeck passwd)')
      return
    }
    case 'passwd': {
      dropToDataOwner()
      db()
      resetPassword()
      const t = ensureSetupToken()
      console.log(`Password reset, all sessions ended.\nSet it up again: http://<host>:${config().port}/setup?token=${t}`)
      return
    }
    case 'print-unit':
      process.stdout.write(argv[1] === 'helper' ? HELPER_UNIT : WEB_UNIT)
      return
    case 'helper': {
      if (process.getuid?.() !== 0) {
        console.error('quadeck helper must run as root')
        process.exit(1)
      }
      cleanupSudoers()
      installNoLang()
      const podman = new SystemPodmanAdmin()
      serveHelper(
        config().helperSocket,
        new LocalPrivileged(
          createGate(true),
          config().podmanSocket,
          new SystemMaintenance(),
          podman,
          new SystemShares(),
          new SystemSsh(),
          new SystemSmart(),
          new SystemFiles(),
          new SystemTimers(),
          new SystemUnitEditor(),
          new SystemNetwork(),
          new FstabManager(new SystemFstabHost()),
          new SystemBoot(),
          new SystemUsers(),
          new SystemHardware(),
          new CaddyManager(new SystemCaddyHost()),
          new SystemBackup({ self: selfArgv(), quadlets: quadletContents(podman) }),
          new SystemPower(),
        ),
      )
      return
    }
    case 'backup': {
      // Started by quadeck-backup(-check).service, as root.
      installNoLang()
      if (process.getuid?.() !== 0) {
        console.error('quadeck backup: needs root')
        process.exit(1)
      }
      if (argv[1] !== 'run' && argv[1] !== 'check') {
        console.error('Usage: quadeck backup run|check')
        process.exit(2)
      }
      const b = new SystemBackup({ self: selfArgv() })
      const r = argv[1] === 'run' ? await b.runBackup() : await b.runCheck()
      process.exit(r.status === 'failed' ? 1 : 0)
    }
    case 'job':
      // Started by the helper only (systemd-run or child process), as root.
      installNoLang()
      process.exit(await runJobCommand(argv[1]))
    case 'doctor': {
      // --json for scripts, --expect key=value (repeatable) for CI
      installNoLang()
      const r = await doctorReport()
      console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r))
      const failed = checkExpectations(
        r,
        argv.flatMap((a, i) => (a === '--expect' && argv[i + 1] ? [argv[i + 1]!] : a.startsWith('--expect=') ? [a.slice(9)] : [])),
      )
      for (const f of failed) console.error(`doctor: ${f}`)
      process.exit(failed.length ? 1 : 0)
    }
    case 'update':
      await selfUpdate(opts.version, argv.includes('--force'))
      return
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`)
      process.exit(2)
  }
}
