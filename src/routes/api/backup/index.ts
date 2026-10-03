import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { CLIENT_NAME, parseBackupPlan, parseClientChange, parseSecrets, parseTargetConfig, parseWarnDays } from '~/shared/backup'
import { msg } from '~/shared/i18n'

// GET: the state (?refresh: read the snapshot list from the repository again), ?suggest: what the
// Quadlets suggest, ?snapshot=…&dir=… a folder of a snapshot, ?snapshot=…&path=… a file (a folder as
// zip) for download (unlock).
// POST (unlock): { save: { plan, secrets } } | { disable: true } | { start: 'backup'|'check' } |
// { password: true } | { target: { setup: config } | { remove: true } } |
// { client: { add: { name, warnDays } } | { update: { name, change } } | { renew: name } | { remove: { name, deleteData } } };
// restoring is a job (/api/jobs, kind backup-restore);
// { sizes: { paths, excludes } } needs no unlock (du, reads only).
export const Route = createFileRoute('/api/backup/')({
  server: {
    handlers: {
      GET: authed(async ({ request }, session) => {
        const q = new URL(request.url).searchParams
        const p = privileged()
        const snapshot = q.get('snapshot')
        if (snapshot !== null) {
          const path = q.get('path')
          if (path !== null) return p.backupDump(unlockToken(session.id), snapshot, path)
          return Response.json({ entries: await p.backupLs(snapshot, q.get('dir') ?? '/') })
        }
        if (q.has('suggest')) return Response.json(await p.backupSuggest())
        if (q.has('target')) return Response.json(await p.targetState(q.has('refresh')))
        return Response.json(await p.backupState(q.has('refresh')))
      }),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{
          save?: { plan?: unknown; secrets?: unknown }
          disable?: unknown
          start?: unknown
          password?: unknown
          sizes?: { paths?: unknown; excludes?: unknown }
          target?: { setup?: unknown; remove?: unknown }
          client?: { add?: { name?: unknown; warnDays?: unknown }; update?: { name?: unknown; change?: unknown }; renew?: unknown; remove?: { name?: unknown; deleteData?: unknown } }
        }>(request)
        const p = privileged()
        const token = unlockToken(session.id)
        if (b.sizes) {
          const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [])
          return Response.json(await p.backupSizes(list(b.sizes.paths), list(b.sizes.excludes)))
        }
        assertWritable()
        if (b.save) {
          const { plan, error } = parseBackupPlan(b.save.plan)
          if (!plan) throw new HttpError(400, error!)
          const s = parseSecrets(plan.repo.kind, b.save.secrets)
          if (!s.secrets) throw new HttpError(400, s.error!)
          return Response.json(await p.saveBackupPlan(token, plan, s.secrets))
        }
        if (b.disable === true) return Response.json(await p.disableBackup(token))
        if (b.start === 'backup' || b.start === 'check') {
          await p.startBackup(token, b.start)
          return Response.json({ ok: true })
        }
        if (b.password === true) return Response.json({ password: await p.backupPassword(token) })
        if (b.target?.setup) {
          const { config, error } = parseTargetConfig(b.target.setup)
          if (!config) throw new HttpError(400, error!)
          return Response.json(await p.setupTarget(token, config))
        }
        if (b.target?.remove === true) return Response.json(await p.removeTarget(token))
        const c = b.client
        const name = (v: unknown) => {
          if (typeof v !== 'string' || !CLIENT_NAME.test(v)) throw new HttpError(400, msg('backup_error_clientName'))
          return v
        }
        if (c?.add) return Response.json(await p.addBackupClient(token, name(c.add.name), parseWarnDays(c.add.warnDays) ?? undefined))
        if (c?.update) return Response.json(await p.updateBackupClient(token, name(c.update.name), parseClientChange(c.update.change)))
        if (c?.renew) return Response.json(await p.renewBackupClient(token, name(c.renew)))
        if (c?.remove) return Response.json(await p.removeBackupClient(token, name(c.remove.name), c.remove.deleteData === true))
        throw new HttpError(400, msg('common_errors_unknownRequest'))
      }),
    },
  },
})
