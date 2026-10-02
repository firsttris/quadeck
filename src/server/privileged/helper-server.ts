// `quadeck helper`: the root half. Listens on a Unix socket that only the
// "quadeck" group can open, offers a fixed list of operations and enforces
// the unlock gate itself.

import { chmodSync, chownSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { HttpError } from '../auth'
import { UNIT_ACTIONS, type Privileged, type UnitAction } from './actions'

type Handler = (body: Record<string, unknown>, p: Privileged) => Promise<unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const action = (v: unknown): UnitAction => {
  if (!UNIT_ACTIONS.includes(v as UnitAction)) throw new HttpError(400, 'action muss start, stop oder restart sein')
  return v as UnitAction
}

export const HELPER_ROUTES: Record<string, Handler> = {
  '/info': (_b, p) => p.info(),
  '/unlock': (b, p) => p.unlock(str(b.user) ?? 'root', str(b.password) ?? ''),
  '/lock': async (b, p) => {
    await p.lock(str(b.token))
    return { ok: true }
  },
  '/unlocked': async (b, p) => ({ until: await p.unlockedUntil(str(b.token)) }),
  '/check': async (b, p) => {
    await p.check(str(b.token))
    return { ok: true }
  },
  '/unit': async (b, p) => {
    await p.unit(str(b.token), action(b.action), str(b.name) ?? '')
    return { ok: true }
  },
  '/daemon-reload': async (b, p) => {
    await p.daemonReload(str(b.token))
    return { ok: true }
  },
  '/podman/get': async (b, p) => ({ data: await p.podmanGet(str(b.path) ?? '') }),
  '/podman/container': async (b, p) => {
    await p.podmanContainer(str(b.token), str(b.id) ?? '', action(b.action))
    return { ok: true }
  },
}

export async function handleHelperRequest(req: Request, p: Privileged, routes = HELPER_ROUTES): Promise<Response> {
  const path = new URL(req.url).pathname
  const route = routes[path]
  if (!route) return Response.json({ error: 'unbekannt' }, { status: 404 })
  try {
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
    return Response.json(await route(body, p))
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error('[quadeck-helper]', e)
    return Response.json({ error: (e as Error).message }, { status })
  }
}

function groupId(name: string): number | undefined {
  try {
    const line = readFileSync('/etc/group', 'utf8')
      .split('\n')
      .find((l) => l.startsWith(name + ':'))
    return line ? Number(line.split(':')[2]) : undefined
  } catch {
    return undefined
  }
}

export function serveHelper(socket: string, p: Privileged, routes = HELPER_ROUTES) {
  if (existsSync(socket)) rmSync(socket)
  const server = Bun.serve({ unix: socket, fetch: (req) => handleHelperRequest(req, p, routes) })
  // Only root and the "quadeck" group may connect.
  const gid = groupId(process.env.QUADECK_HELPER_GROUP || 'quadeck')
  if (gid !== undefined && process.getuid?.() === 0) chownSync(socket, 0, gid)
  chmodSync(socket, 0o660)
  console.log(`[quadeck-helper] lauscht auf ${socket}`)
  return server
}
