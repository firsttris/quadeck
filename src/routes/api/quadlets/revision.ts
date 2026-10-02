import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

export const Route = createFileRoute('/api/quadlets/revision')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const name = q.get('name')
        const id = q.get('id')
        if (!name || !id) throw new HttpError(400, 'name und id erforderlich')
        return Response.json({ content: await privileged().quadletRevision(name, id) })
      }),
    },
  },
})
