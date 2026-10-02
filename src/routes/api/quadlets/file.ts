import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { tr } from '~/shared/i18n'

const nameParam = (request: Request) => {
  const name = new URL(request.url).searchParams.get('name')
  if (!name) throw new HttpError(400, tr('name fehlt', 'name missing'))
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
        if (typeof b.name !== 'string' || typeof b.content !== 'string') throw new HttpError(400, tr('name und content erforderlich', 'name and content required'))
        return Response.json(await privileged().writeQuadlet(unlockToken(session.id), b.name, b.content, b.restart === true))
      }),
      DELETE: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ name?: unknown }>(request)
        if (typeof b.name !== 'string') throw new HttpError(400, tr('name erforderlich', 'name required'))
        await privileged().deleteQuadlet(unlockToken(session.id), b.name)
        return Response.json({ ok: true })
      }),
    },
  },
})
