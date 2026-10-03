import { msg } from '~/shared/i18n'
import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { unlockToken } from '~/server/unlock-sessions'
import { UNIT_ACTIONS, type UnitAction } from '~/server/privileged/actions'

export const Route = createFileRoute('/api/containers')({
  server: {
    handlers: {
      POST: authed(async ({ request }, session) => {
        const body = await readJson<{ name?: unknown; action?: unknown }>(request)
        if (typeof body.name !== 'string' || !UNIT_ACTIONS.includes(body.action as UnitAction)) throw new HttpError(400, msg('api_units_nameActionRequired'))
        const hub = await hubReady()
        const via = await hub.containerAction(body.action as UnitAction, body.name, unlockToken(session.id))
        return Response.json({ ok: true, via })
      }),
    },
  },
})
