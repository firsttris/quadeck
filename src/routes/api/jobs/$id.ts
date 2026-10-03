import { msg } from '~/shared/i18n'
import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

export const Route = createFileRoute('/api/jobs/$id')({
  server: {
    handlers: {
      GET: authed(async ({ request, params }: { request: Request; params: { id: string } }) => {
        if (!/^[a-z0-9-]{1,40}$/.test(params.id)) throw new HttpError(400, msg('api_jobs_invalidJobId'))
        const from = Number(new URL(request.url).searchParams.get('from')) || 0
        const job = await privileged().job(params.id, from)
        if (!job) throw new HttpError(404, msg('api_jobs_jobNotFoundQuadeckRestarted'))
        return Response.json(job)
      }),
    },
  },
})
