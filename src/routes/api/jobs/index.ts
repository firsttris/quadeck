import { createFileRoute } from '@tanstack/react-router'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { parseJobSpec } from '~/server/packages/job'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

export const Route = createFileRoute('/api/jobs/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json({ jobs: await privileged().jobs() })),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const spec = parseJobSpec((await readJson<{ spec?: unknown }>(request)).spec)
        return Response.json(await privileged().startJob(unlockToken(session.id), spec))
      }),
    },
  },
})
