import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'
import { tr } from '~/shared/i18n'

export const Route = createFileRoute('/api/quadlets/revision')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const name = q.get('name')
        const id = q.get('id')
        if (!name || !id) throw new HttpError(400, tr('name und id erforderlich', 'name and id required'))
        return Response.json({ content: await privileged().quadletRevision(name, id) })
      }),
    },
  },
})
