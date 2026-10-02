// Process entry for the single binary: CLI commands plus the HTTP server
// (static client assets + the TanStack Start handler).

import { PEER_HEADER, ensureSetupToken, resetPassword } from './server/auth'
import { config } from './server/config'
import { db } from './server/db'
import { selfUpdate } from './server/update'
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
  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 255, // SSE streams send a ping every 15–20 s
    async fetch(req, srv) {
      const url = new URL(req.url)
      const file = (req.method === 'GET' || req.method === 'HEAD') && opts.assets.get(url.pathname)
      if (file) {
        const ext = url.pathname.split('.').pop() ?? ''
        return withHeaders(
          new Response(Bun.file(file), {
            headers: {
              'content-type': MIME[ext] ?? 'application/octet-stream',
              'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
            },
          }),
        )
      }
      const headers = new Headers(req.headers)
      headers.delete(PEER_HEADER)
      headers.set(PEER_HEADER, srv.requestIP(req)?.address ?? 'unknown')
      const forwarded = new Request(req, { headers })
      try {
        return withHeaders(await opts.server.fetch(forwarded))
      } catch (e) {
        console.error('[quadeck]', e)
        return withHeaders(new Response('Interner Fehler', { status: 500 }))
      }
    },
  })
  console.log(`[quadeck] ${opts.version} läuft auf http://${cfg.host}:${server.port} (Daten: ${cfg.dataDir}${cfg.readonly ? ', read-only' : ''})`)
  // The token itself is not logged: the journal is readable by more than root.
  if (token) console.log(`[quadeck] Noch kein Passwort gesetzt. Setup-Link (als root): quadeck setup-token`)
  // Start the collectors right away instead of on the first page view.
  void opts.server.fetch(new Request(`http://127.0.0.1:${server.port}/api/health`, { headers: { [PEER_HEADER]: '127.0.0.1' } }))
  return server
}

const HELP = `quadeck – Dashboard für Podman-Server mit Quadlets

  quadeck [serve]        Server starten (Standard)
  quadeck setup-token    Token für die Ersteinrichtung ausgeben
  quadeck passwd         Passwort zurücksetzen (neue Einrichtung über /setup)
  quadeck helper         Root-Helfer starten (als root, Unix-Socket)
  quadeck print-unit web|helper   systemd-Unit ausgeben (für install.sh)
  quadeck update         Neueste Version von GitHub laden und Dienst neu starten
  quadeck version        Version ausgeben

Umgebung: QUADECK_HOST (0.0.0.0), QUADECK_PORT (8484), QUADECK_DATA_DIR (/var/lib/quadeck),
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
      console.log(t ?? 'Passwort ist bereits gesetzt (zurücksetzen mit: quadeck passwd)')
      return
    }
    case 'passwd': {
      dropToDataOwner()
      db()
      resetPassword()
      const t = ensureSetupToken()
      console.log(`Passwort zurückgesetzt, alle Sitzungen beendet.\nNeu einrichten: http://<host>:${config().port}/setup?token=${t}`)
      return
    }
    case 'print-unit':
      process.stdout.write(argv[1] === 'helper' ? HELPER_UNIT : WEB_UNIT)
      return
    case 'helper': {
      if (process.getuid?.() !== 0) {
        console.error('quadeck helper muss als root laufen')
        process.exit(1)
      }
      cleanupSudoers()
      serveHelper(config().helperSocket, new LocalPrivileged(createGate(true), config().podmanSocket, new SystemMaintenance(), new SystemPodmanAdmin(), new SystemShares(), new SystemSsh(), new SystemSmart(), new SystemFiles(), new SystemTimers(), new SystemUnitEditor(), new SystemNetwork(), new FstabManager(new SystemFstabHost()), new SystemBoot(), new SystemUsers(), new SystemHardware()))
      return
    }
    case 'job':
      // Started by the helper only (systemd-run or child process), as root.
      process.exit(await runJobCommand(argv[1]))
    case 'update':
      await selfUpdate(opts.version, argv.includes('--force'))
      return
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return
    default:
      console.error(`Unbekannter Befehl: ${cmd}\n\n${HELP}`)
      process.exit(2)
  }
}
