import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { UNIT_ACTIONS, type UnitAction } from '~/server/privileged/actions'

export const Route = createFileRoute('/api/containers')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const body = await readJson<{ name?: unknown; action?: unknown }>(request)
        if (typeof body.name !== 'string' || !UNIT_ACTIONS.includes(body.action as UnitAction)) throw new HttpError(400, 'name und action (start|stop|restart) erforderlich')
        const hub = await hubReady()
        const via = await hub.containerAction(body.action as UnitAction, body.name)
        return Response.json({ ok: true, via })
      }),
    },
  },
})
