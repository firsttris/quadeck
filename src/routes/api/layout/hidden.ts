import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { setCardHidden } from '~/server/layout'
import { tr } from '~/shared/i18n'

export const Route = createFileRoute('/api/layout/hidden')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const body = await readJson<{ id?: unknown; hidden?: unknown }>(request)
        if (typeof body.id !== 'string' || typeof body.hidden !== 'boolean') throw new HttpError(400, tr('id und hidden erforderlich', 'id and hidden required'))
        setCardHidden(body.id, body.hidden)
        return Response.json({ ok: true })
      }),
    },
  },
})
