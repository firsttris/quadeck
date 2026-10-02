// `quadeck helper`: the root half. Listens on a Unix socket that only the
// "quadeck" group can open, offers a fixed list of operations and enforces
// the unlock gate itself.

import { chmodSync, chownSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { HttpError } from '../auth'
import { PACKAGE_NAME } from '~/shared/packages'
import { parseJobSpec } from '../packages/job'
import type { PodmanConfigName } from '~/shared/quadlets'
import { parseShareChange } from '../shares/backend'
import { parseSshChange } from '../ssh/backend'
import { DISK_NAME } from '../smart/backend'
import { parseSave, parseTimerAction } from '../timers/backend'
import { parseFstabChange } from '../fstab/parse'
import { UNIT_ACTIONS, type Privileged, type UnitAction } from './actions'

type Handler = (body: Record<string, unknown>, p: Privileged) => Promise<unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const names = (v: unknown) => {
  if (!Array.isArray(v) || !v.length || v.length > 200 || !v.every((n) => typeof n === 'string' && PACKAGE_NAME.test(n))) throw new HttpError(400, 'Ungültige Paketnamen')
  return v as string[]
}
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
  '/pkg/overview': (_b, p) => p.overview(),
  '/pkg/installed': async (_b, p) => ({ data: await p.installed() }),
  '/pkg/detail': async (b, p) => ({ data: await p.detail(names([b.name])[0]!) }),
  '/pkg/updates': (b, p) => p.updates(b.refresh === true),
  '/pkg/remove-preview': (b, p) => p.removePreview(names(b.names)),
  '/images/updates': (b, p) => p.imageUpdates(b.refresh === true),
  '/jobs/list': async (_b, p) => ({ data: await p.jobs() }),
  '/jobs/get': async (b, p) => ({ data: await p.job(str(b.id) ?? '', Number(b.from) || 0) }),
  '/jobs/start': (b, p) => p.startJob(str(b.token), parseJobSpec(b.spec)),
  '/quadlets/list': async (_b, p) => ({ data: await p.quadlets() }),
  '/quadlets/read': async (b, p) => ({ data: await p.readQuadlet(str(b.name) ?? '') }),
  '/quadlets/validate': (b, p) => p.validateQuadlet(str(b.name) ?? '', str(b.content) ?? ''),
  '/quadlets/history': async (b, p) => ({ data: await p.quadletHistory(str(b.name) ?? '') }),
  '/quadlets/revision': async (b, p) => ({ data: await p.quadletRevision(str(b.name) ?? '', str(b.id) ?? '') }),
  '/quadlets/write': (b, p) => p.writeQuadlet(str(b.token), str(b.name) ?? '', str(b.content) ?? '', b.restart === true),
  '/quadlets/delete': async (b, p) => {
    await p.deleteQuadlet(str(b.token), str(b.name) ?? '')
    return { ok: true }
  },
  '/podman/settings': (_b, p) => p.podmanSettings(),
  '/podman/timer': async (b, p) => {
    await p.setAutoUpdateTimer(str(b.token), b.enabled === true, str(b.calendar) ?? '')
    return { ok: true }
  },
  '/podman/autoupdate-default': async (b, p) => {
    await p.setAutoUpdateDefault(str(b.token), b.enabled === true)
    return { ok: true }
  },
  '/shares/state': (_b, p) => p.sharesState(),
  '/shares/preview': (b, p) => p.previewShare(parseShareChange(b.change)),
  '/shares/apply': (b, p) => p.applyShare(str(b.token), parseShareChange(b.change)),
  '/shares/service': (b, p) => {
    if (b.kind !== 'smb' && b.kind !== 'nfs') throw new HttpError(400, 'kind muss smb oder nfs sein')
    if (!['start', 'stop', 'restart', 'enable'].includes(str(b.action) ?? '')) throw new HttpError(400, 'Ungültige Aktion')
    return p.shareService(str(b.token), b.kind, b.action as 'start')
  },
  '/ssh/state': (_b, p) => p.sshState(),
  '/ssh/preview': (b, p) => p.previewSsh(parseSshChange(b.change)),
  '/ssh/apply': (b, p) => p.applySsh(str(b.token), parseSshChange(b.change)),
  '/ssh/service': (b, p) => {
    if (!['start', 'restart', 'enable'].includes(str(b.action) ?? '')) throw new HttpError(400, 'Ungültige Aktion')
    return p.sshService(str(b.token), b.action as 'start')
  },
  '/smart/report': (b, p) => p.smartReport(b.refresh === true),
  '/smart/selftest': (b, p) => {
    if (!DISK_NAME.test(str(b.disk) ?? '') || (b.type !== 'short' && b.type !== 'long')) throw new HttpError(400, 'disk und type (short|long) erforderlich')
    return p.smartSelfTest(str(b.token), str(b.disk)!, b.type)
  },
  '/files/roots': async (_b, p) => ({ data: await p.fileRoots() }),
  '/files/list': (b, p) => p.listDir(str(b.path) ?? ''),
  '/files/mkdir': async (b, p) => {
    await p.makeDir(str(b.token), str(b.path) ?? '')
    return { ok: true }
  },
  '/files/rename': async (b, p) => {
    await p.renamePath(str(b.token), str(b.path) ?? '', str(b.newName) ?? '')
    return { ok: true }
  },
  '/timers/state': (_b, p) => p.timersState(),
  '/timers/preview': (b, p) => p.previewCalendar(str(b.calendar) ?? ''),
  '/timers/files': async (b, p) => ({ data: await p.timerFiles(str(b.name) ?? '') }),
  '/timers/save': (b, p) => {
    const s = parseSave(b)
    return p.saveTimer(str(b.token), s.spec, s.previous, s.enable)
  },
  '/timers/delete': (b, p) => p.deleteTimer(str(b.token), str(b.name) ?? ''),
  '/timers/schedule': (b, p) => p.setTimerSchedule(str(b.token), str(b.name) ?? '', str(b.calendar) ?? ''),
  '/timers/action': (b, p) => p.timerAction(str(b.token), str(b.name) ?? '', parseTimerAction(b.action)),
  '/network/state': (_b, p) => p.networkState(),
  '/fstab/state': (_b, p) => p.fstabState(),
  '/fstab/validate': (b, p) => p.validateFstab(parseFstabChange(b.change)),
  '/fstab/revision': async (b, p) => ({ data: await p.fstabRevision(str(b.id) ?? '') }),
  '/fstab/apply': (b, p) => p.applyFstab(str(b.token), parseFstabChange(b.change), b.confirm === true),
  '/fstab/mount': (b, p) => p.mountAction(str(b.token), str(b.target) ?? '', b.action === 'unmount' ? 'unmount' : 'mount'),
  '/units/detail': (b, p) => p.unitDetail(str(b.unit) ?? ''),
  '/units/validate': (b, p) => p.validateUnitFile(str(b.unit) ?? '', str(b.path) ?? '', str(b.content) ?? ''),
  '/units/history': async (b, p) => ({ data: await p.unitFileHistory(str(b.unit) ?? '', str(b.path) ?? '') }),
  '/units/revision': async (b, p) => ({ data: await p.unitFileRevision(str(b.unit) ?? '', str(b.path) ?? '', str(b.id) ?? '') }),
  '/units/write': (b, p) => p.writeUnitFile(str(b.token), str(b.unit) ?? '', str(b.path) ?? '', str(b.content) ?? '', b.restart === true),
  '/units/delete': async (b, p) => {
    await p.deleteUnitFile(str(b.token), str(b.unit) ?? '', str(b.path) ?? '')
    return { ok: true }
  },
  '/units/create': (b, p) => p.createUnit(str(b.token), str(b.unit) ?? '', str(b.content) ?? '', b.enable === true),
  '/units/enable': async (b, p) => {
    await p.setUnitEnabled(str(b.token), str(b.unit) ?? '', b.enabled === true)
    return { ok: true }
  },
  '/podman/config': async (b, p) => {
    await p.writePodmanConfig(str(b.token), str(b.name) as PodmanConfigName, str(b.content) ?? '')
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
