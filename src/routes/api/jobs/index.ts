import { tr } from '~/shared/i18n'
import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { config } from '~/server/config'
import { authed, readJson } from '~/server/http'
import { parseJobSpec } from '~/server/packages/job'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

export const Route = createFileRoute('/api/jobs/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json({ jobs: await privileged().jobs() })),
      POST: authed(async ({ request }, session) => {
        if (config().readonly) throw new HttpError(403, tr('Read-only-Modus: Aktionen sind deaktiviert (QUADECK_READONLY)', 'Read-only mode: actions are disabled (QUADECK_READONLY)'))
        const spec = parseJobSpec((await readJson<{ spec?: unknown }>(request)).spec)
        return Response.json(await privileged().startJob(unlockToken(session.id), spec))
      }),
    },
  },
})
