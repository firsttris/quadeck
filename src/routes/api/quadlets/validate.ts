import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

// Lint + Quadlet generator dry run; changes nothing.
export const Route = createFileRoute('/api/quadlets/validate')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const b = await readJson<{ name?: unknown; content?: unknown }>(request)
        if (typeof b.name !== 'string' || typeof b.content !== 'string') throw new HttpError(400, msg(m.api_quadlets_nameContentRequired))
        return Response.json(await privileged().validateQuadlet(b.name, b.content))
      }),
    },
  },
})
