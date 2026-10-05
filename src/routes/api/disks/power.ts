import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { db } from '~/server/db'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { querySmartHistory } from '~/server/metrics'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { parsePowerSetting, wakeRate } from '~/shared/power'

// GET: hard disks with standby state, Quadeck's setting and spin-ups per day (from the SMART
// history); ?users=<disk>: what has files open on it now; ?history: the rules file's versions.
// POST { serial, setting: { minutes, apm } | null } (unlock).
export const Route = createFileRoute('/api/disks/power')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const p = privileged()
        const users = q.get('users')
        if (users !== null) return Response.json({ users: await p.diskUsers(users) })
        if (q.has('history')) return Response.json({ history: await p.powerHistory() })
        const [state, smart] = await Promise.all([p.diskPower(), p.smartReport(false).catch(() => undefined)])
        const wakes: Record<string, number> = {}
        for (const d of state.disks) {
          const id = smart?.disks.find((s) => s.name === d.name)?.id
          const rate = id ? wakeRate(querySmartHistory(db(), id, 8).startstop ?? []) : undefined
          if (rate !== undefined) wakes[d.name] = rate
        }
        return Response.json({ ...state, wakes })
      }),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ serial?: unknown; setting?: unknown }>(request)
        if (typeof b.serial !== 'string') throw new HttpError(400, msg(m.power_error_setting))
        const setting = b.setting === null ? null : parsePowerSetting(b.setting)
        if (setting === undefined) throw new HttpError(400, msg(m.power_error_setting))
        return Response.json(await privileged().setDiskPower(unlockToken(session.id), b.serial, setting))
      }),
    },
  },
})
