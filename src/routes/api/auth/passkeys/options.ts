import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { createFileRoute } from '@tanstack/react-router'
import { beginAttempt, HttpError, verifyPassword } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { registrationOptions } from '~/server/passkeys'

// The challenge for a new passkey; asks for the admin password once more
export const Route = createFileRoute('/api/auth/passkeys/options')({
  server: {
    handlers: {
      POST: authed(async ({ request }, session) => {
        const body = await readJson<{ password?: unknown }>(request)
        const finish = beginAttempt(request)
        let ok = false
        try {
          ok = typeof body.password === 'string' && (await verifyPassword(body.password))
        } finally {
          finish(ok)
        }
        if (!ok) throw new HttpError(403, msg(m.api_auth_wrongPassword))
        return Response.json(await registrationOptions(request, session.id))
      }),
    },
  },
})
