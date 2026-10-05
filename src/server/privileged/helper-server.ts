// `quadeck helper`: the root half. Listens on a Unix socket that only the
// "quadeck" group can open, offers a fixed list of operations and enforces
// the unlock gate itself.

import { parseItems } from '~/shared/podman-storage'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
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
import { parseCaddyChange } from '~/shared/caddy'
import { QUADECK_URL, parseClientPlan } from '~/shared/backup-client'
import { parsePowerSetting } from '~/shared/power'
import { parseBackupPlan, parseClientChange, parseSecrets, parseTargetConfig, parseWarnDays } from '~/shared/backup'
import { parseBootEntryChange } from '~/shared/boot'
import { parseUserChange } from '../users/parse'
import { UNIT_ACTIONS, type Privileged, type UnitAction } from './actions'

type Handler = (body: Record<string, unknown>, p: Privileged) => Promise<unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const strs = (v: unknown) => (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string') ? (v as string[]) : [])
const names = (v: unknown) => {
  if (!Array.isArray(v) || !v.length || v.length > 200 || !v.every((n) => typeof n === 'string' && PACKAGE_NAME.test(n))) throw new HttpError(400, msg(m.api_packages_invalidNames))
  return v as string[]
}
const action = (v: unknown): UnitAction => {
  if (!UNIT_ACTIONS.includes(v as UnitAction)) throw new HttpError(400, msg(m.helper_error_invalidUnitAction))
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
  '/pkg/config-file': (b, p) => p.configFile(str(b.path) ?? ''),
  '/pkg/config-apply': (b, p) => {
    const a = b.action
    if (a !== 'replace' && a !== 'keep' && a !== 'merge') throw new HttpError(400, msg(m.helper_error_invalidConfigAction))
    return p.applyConfigFile(str(b.token), str(b.path) ?? '', a, str(b.content))
  },
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
  '/quadlets/plan': (b, p) => p.removalPlan(str(b.name) ?? ''),
  '/quadlets/delete': (b, p) => p.deleteQuadlet(str(b.token), str(b.name) ?? '', { image: b.image === true, volumes: b.volumes === true }),
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
    if (b.kind !== 'smb' && b.kind !== 'nfs') throw new HttpError(400, msg(m.helper_error_invalidShareKind))
    if (!['start', 'stop', 'restart', 'enable'].includes(str(b.action) ?? '')) throw new HttpError(400, msg(m.helper_error_invalidServiceAction))
    return p.shareService(str(b.token), b.kind, b.action as 'start')
  },
  '/ssh/state': (_b, p) => p.sshState(),
  '/ssh/preview': (b, p) => p.previewSsh(parseSshChange(b.change)),
  '/ssh/apply': (b, p) => p.applySsh(str(b.token), parseSshChange(b.change)),
  '/ssh/service': (b, p) => {
    if (!['start', 'restart', 'enable'].includes(str(b.action) ?? '')) throw new HttpError(400, msg(m.helper_error_invalidServiceAction))
    return p.sshService(str(b.token), b.action as 'start')
  },
  '/smart/report': (b, p) => p.smartReport(b.refresh === true),
  '/smart/selftest': (b, p) => {
    if (!DISK_NAME.test(str(b.disk) ?? '') || (b.type !== 'short' && b.type !== 'long')) throw new HttpError(400, msg(m.api_disks_diskTypeRequired))
    return p.smartSelfTest(str(b.token), str(b.disk)!, b.type)
  },
  '/files/roots': async (_b, p) => ({ data: await p.fileRoots() }),
  '/files/list': (b, p) => p.listDir(str(b.path) ?? ''),
  '/files/read': (b, p) => p.readTextFile(str(b.token), str(b.path) ?? ''),
  '/files/archive': (b, p) => p.archivePreview(str(b.token), str(b.archive) ?? '', str(b.toDir) ?? ''),
  '/files/archive-tools': (_b, p) => p.archiveTools(),
  // A Response: streamed as it is (see handleHelperRequest).
  '/files/raw': (b, p) => p.fileResponse(str(b.token), str(b.path) ?? '', { range: str(b.range), download: b.download === true }),
  '/files/write': (b, p) => p.writeTextFile(str(b.token), str(b.path) ?? '', str(b.content) ?? '', str(b.expected) ?? ''),
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
  '/podman/storage': (_b, p) => p.podmanStorage(),
  '/terminal/open': (b, p) => {
    const t = (b.target ?? {}) as Record<string, unknown>
    return p.terminalOpen(str(b.token), t.kind === 'container' ? { kind: 'container', name: str(t.name) ?? '' } : { kind: 'shell' }, Number(b.cols), Number(b.rows), Number(b.idleMinutes) || 15)
  },
  '/terminal/stream': async (b, p) => p.terminalStream(str(b.id) ?? ''),
  '/terminal/input': async (b, p) => {
    await p.terminalInput(str(b.id) ?? '', str(b.data) ?? '')
    return { ok: true }
  },
  '/terminal/resize': async (b, p) => {
    await p.terminalResize(str(b.id) ?? '', Number(b.cols), Number(b.rows))
    return { ok: true }
  },
  '/terminal/close': async (b, p) => {
    await p.terminalClose(str(b.id) ?? '')
    return { ok: true }
  },
  '/secrets/state': (_b, p) => p.secretsState(),
  '/secrets/create': (b, p) => p.createSecret(str(b.token), str(b.name) ?? '', typeof b.value === 'string' ? b.value : '', b.replace === true),
  '/secrets/remove': (b, p) => p.removeSecret(str(b.token), str(b.name) ?? ''),
  '/secrets/move': (b, p) => p.moveSecret(str(b.token), str(b.file) ?? '', str(b.key) ?? '', str(b.name) ?? '', b.restart !== false),
  '/podman/clean': (b, p) => p.cleanPodman(str(b.token), parseItems(b.items)),
  '/podman/prune': (b, p) => p.setPodmanPrune(str(b.token), b.every === 'weekly' || b.every === 'monthly' ? b.every : null),
  '/network/devices': (b, p) => p.scanDevices(b.active === true),
  '/fstab/state': (_b, p) => p.fstabState(),
  '/boot/state': (_b, p) => p.bootState(),
  '/boot/entry-preview': (b, p) => p.kernelEntryPreview(str(b.pkg) ?? ''),
  '/boot/entry-create': (b, p) => p.createKernelEntry(str(b.token), str(b.pkg) ?? ''),
  '/boot/entry-remove': (b, p) => p.removeBootEntry(str(b.token), str(b.id) ?? ''),
  '/boot/entry-file': (b, p) => p.bootEntryFile(str(b.id) ?? ''),
  '/boot/entry-revision': async (b, p) => ({ data: await p.bootEntryRevision(str(b.id) ?? '', str(b.revision) ?? '') }),
  '/boot/files': (_b, p) => p.bootFiles(),
  '/boot/entry-check': (b, p) => p.checkBootEntry(str(b.content) ?? ''),
  '/boot/entry-write': async (b, p) => {
    const change = parseBootEntryChange(b.change)
    if (!change) throw new HttpError(400, msg(m.common_errors_unknownRequest))
    return p.writeBootEntry(str(b.token), change)
  },
  '/users/state': (_b, p) => p.usersState(),
  '/hardware': (_b, p) => p.hardware(),
  '/caddy/state': (_b, p) => p.caddyState(),
  '/caddy/revision': async (b, p) => ({ data: await p.caddyRevision(str(b.id) ?? '') }),
  '/caddy/apply': (b, p) => p.applyCaddy(str(b.token), parseCaddyChange(b.change), str(b.expected)),
  '/power/state': (_b, p) => p.diskPower(),
  '/power/sample': (_b, p) => p.powerSample(),
  '/power/users': async (b, p) => ({ data: await p.diskUsers(str(b.name) ?? '') }),
  '/power/history': async (_b, p) => ({ data: await p.powerHistory() }),
  '/power/set': (b, p) => {
    const setting = b.setting === null ? null : parsePowerSetting(b.setting)
    if (setting === undefined) throw new HttpError(400, msg(m.power_error_setting))
    return p.setDiskPower(str(b.token), str(b.serial) ?? '', setting)
  },
  '/backup/state': (b, p) => p.backupState(b.refresh === true),
  '/backup/suggest': (_b, p) => p.backupSuggest(),
  '/backup/sizes': (b, p) => p.backupSizes(strs(b.paths), strs(b.excludes)),
  '/backup/ls': async (b, p) => ({ data: await p.backupLs(str(b.snapshot) ?? '', str(b.dir) ?? '') }),
  '/backup/save': (b, p) => {
    // Checked again here, where root writes it.
    const { plan, error } = parseBackupPlan(b.plan)
    if (!plan) throw new HttpError(400, error!)
    const s = parseSecrets(plan.repo.kind, b.secrets)
    if (!s.secrets) throw new HttpError(400, s.error!)
    return p.saveBackupPlan(str(b.token), plan, s.secrets)
  },
  '/backup/disable': (b, p) => p.disableBackup(str(b.token)),
  '/backup/password': async (b, p) => ({ data: await p.backupPassword(str(b.token)) }),
  '/backup/start': async (b, p) => {
    await p.startBackup(str(b.token), b.kind === 'check' ? 'check' : 'backup')
    return { ok: true }
  },
  '/backup/dump': (b, p) => p.backupDump(str(b.token), str(b.snapshot) ?? '', str(b.path) ?? ''),
  '/backup/target/state': (b, p) => p.targetState(b.refresh === true),
  '/backup/target/setup': (b, p) => {
    const { config, error } = parseTargetConfig(b.config)
    if (!config) throw new HttpError(400, error!)
    return p.setupTarget(str(b.token), config)
  },
  '/backup/target/remove': (b, p) => p.removeTarget(str(b.token)),
  '/backup/client/add': (b, p) => p.addBackupClient(str(b.token), str(b.name) ?? '', parseWarnDays(b.warnDays) ?? undefined),
  '/backup/client/update': (b, p) => p.updateBackupClient(str(b.token), str(b.name) ?? '', parseClientChange(b.change)),
  '/backup/client/renew': (b, p) => p.renewBackupClient(str(b.token), str(b.name) ?? ''),
  '/backup/client/plan': (b, p) => {
    const { plan, error } = parseClientPlan(b.plan)
    if (!plan) throw new HttpError(400, error!)
    return p.setBackupClientPlan(str(b.token), str(b.name) ?? '', plan)
  },
  '/backup/client/link': (b, p) => {
    const url = str(b.url) ?? ''
    if (!QUADECK_URL.test(url)) throw new HttpError(400, msg(m.backup_error_url))
    return p.backupClientLink(str(b.token), str(b.name) ?? '', url)
  },
  '/backup/client/redeem': async (b, p) => ({ script: await p.redeemBackupClientLink(str(b.link) ?? '') }),
  '/backup/client/remove': (b, p) => p.removeBackupClient(str(b.token), str(b.name) ?? '', b.deleteData === true),
  '/caddy/path': (b, p) => p.setCaddyPath(str(b.token), b.path === null ? null : (str(b.path) ?? '')),
  '/users/apply': (b, p) => p.applyUser(str(b.token), parseUserChange(b.change)),
  '/boot/default': (b, p) => p.setBootDefault(str(b.token), str(b.id) ?? ''),
  '/boot/timeout': (b, p) => p.setBootTimeout(str(b.token), str(b.value) ?? ''),
  '/boot/oneshot-cancel': (b, p) => p.cancelOneshot(str(b.token)),
  '/boot/update': (b, p) => p.updateBootLoader(str(b.token)),
  '/boot/reboot': (b, p) => p.reboot(str(b.token), { entry: str(b.entry) || undefined, firmware: b.firmware === true }),
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
  if (!route) return Response.json({ error: msg(m.podman_all_unknownVersion) }, { status: 404 })
  try {
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
    const result = await route(body, p)
    return result instanceof Response ? result : Response.json(result)
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
  console.log(`[quadeck-helper] listening on ${socket}`)
  return server
}
