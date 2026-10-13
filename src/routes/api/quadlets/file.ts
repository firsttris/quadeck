import { createFileRoute } from '@tanstack/react-router'
import { m } from '~/paraglide/messages'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { hub } from '~/server/hub'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { quadletUnit } from '~/shared/quadlets'

const nameParam = (request: Request) => {
  const name = new URL(request.url).searchParams.get('name')
  if (!name) throw new HttpError(400, msg(m.api_quadlets_nameMissing))
  return name
}

// One Quadlet file. Names may contain one "/" (sub-directory), hence ?name=.
export const Route = createFileRoute('/api/quadlets/file')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const name = nameParam(request)
        const p = privileged()
        // What the delete dialog offers to remove as well.
        if (new URL(request.url).searchParams.has('removal')) return Response.json(await p.removalPlan(name))
        const [content, history] = await Promise.all([p.readQuadlet(name), p.quadletHistory(name)])
        return Response.json({ name, content, history })
      }),
      PUT: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ name?: unknown; content?: unknown; restart?: unknown; expected?: unknown }>(request)
        if (typeof b.name !== 'string' || typeof b.content !== 'string') throw new HttpError(400, msg(m.api_quadlets_nameContentRequired))
        return Response.json(await privileged().writeQuadlet(unlockToken(session.id), b.name, b.content, b.restart === true, typeof b.expected === 'string' ? b.expected : undefined))
      }),
      // Start at boot: { name, boot } adds or removes the [Install] lines.
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ name?: unknown; boot?: unknown }>(request)
        if (typeof b.name !== 'string' || typeof b.boot !== 'boolean') throw new HttpError(400, msg(m.common_errors_unknownRequest))
        const r = await privileged().setQuadletBoot(unlockToken(session.id), b.name, b.boot)
        await hub().quadletBootChanged(r.unit, b.boot)
        return Response.json(r)
      }),
      DELETE: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ name?: unknown; image?: unknown; volumes?: unknown }>(request)
        if (typeof b.name !== 'string') throw new HttpError(400, msg(m.api_quadlets_nameRequired))
        const r = await privileged().deleteQuadlet(unlockToken(session.id), b.name, { image: b.image === true, volumes: b.volumes === true })
        await hub().quadletDeleted(quadletUnit(b.name))
        return Response.json({ ok: true, ...r })
      }),
    },
  },
})
