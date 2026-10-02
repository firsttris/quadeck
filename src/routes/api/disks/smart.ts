import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { db } from '~/server/db'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { querySmartHistory, smartBaselines } from '~/server/metrics'
import { privileged } from '~/server/privileged'
import { DISK_NAME } from '~/server/smart/backend'
import { unlockToken } from '~/server/unlock-sessions'
import type { SmartReport } from '~/shared/smart'

// GET: SMART of all disks (cached 15 min); ?history=<disk id>&days=90 → trends.
// POST {}: read again now. POST { selftest: { disk, type } }: start a self-test (unlock).
const withBaselines = (r: SmartReport): SmartReport => ({ ...r, baselines: smartBaselines(db(), r.disks.map((d) => d.id)) })

export const Route = createFileRoute('/api/disks/smart')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const id = q.get('history')
        if (id !== null) {
          if (!/^[A-Za-z0-9_.-]{1,160}$/.test(id)) throw new HttpError(400, 'Ungültige Platte')
          const days = Math.min(365, Math.max(1, Number(q.get('days')) || 90))
          return Response.json({ series: querySmartHistory(db(), id, days) })
        }
        return Response.json(withBaselines(await privileged().smartReport(false)))
      }),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ selftest?: { disk?: unknown; type?: unknown } }>(request)
        const p = privileged()
        let report
        if (b.selftest) {
          assertWritable()
          const { disk, type } = b.selftest
          if (typeof disk !== 'string' || !DISK_NAME.test(disk) || (type !== 'short' && type !== 'long')) throw new HttpError(400, 'disk und type (short|long) erforderlich')
          report = await p.smartSelfTest(unlockToken(session.id), disk, type)
        } else report = await p.smartReport(true)
        void (await hubReady()).collectSmart().then(async () => (await hubReady()).publish())
        return Response.json(withBaselines(report))
      }),
    },
  },
})
