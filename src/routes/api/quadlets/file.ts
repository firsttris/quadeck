import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

const nameParam = (request: Request) => {
  const name = new URL(request.url).searchParams.get('name')
  if (!name) throw new HttpError(400, 'name fehlt')
  return name
}

// One Quadlet file. Names may contain one "/" (sub-directory), hence ?name=.
export const Route = createFileRoute('/api/quadlets/file')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const name = nameParam(request)
        const p = privileged()
        const [content, history] = await Promise.all([p.readQuadlet(name), p.quadletHistory(name)])
        return Response.json({ name, content, history })
      }),
      PUT: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ name?: unknown; content?: unknown; restart?: unknown }>(request)
        if (typeof b.name !== 'string' || typeof b.content !== 'string') throw new HttpError(400, 'name und content erforderlich')
        return Response.json(await privileged().writeQuadlet(unlockToken(session.id), b.name, b.content, b.restart === true))
      }),
      DELETE: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ name?: unknown }>(request)
        if (typeof b.name !== 'string') throw new HttpError(400, 'name erforderlich')
        await privileged().deleteQuadlet(unlockToken(session.id), b.name)
        return Response.json({ ok: true })
      }),
    },
  },
})
