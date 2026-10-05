import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { setCardHidden } from '~/server/layout'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/api/layout/hidden')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const body = await readJson<{ id?: unknown; hidden?: unknown }>(request)
        if (typeof body.id !== 'string' || typeof body.hidden !== 'boolean') throw new HttpError(400, msg(m.api_layout_idHiddenRequired))
        setCardHidden(body.id, body.hidden)
        return Response.json({ ok: true })
      }),
    },
  },
})
