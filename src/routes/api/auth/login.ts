import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { createFileRoute } from '@tanstack/react-router'
import { beginAttempt, createSession, HttpError, sessionCookie, verifyPassword } from '~/server/auth'
import { errorResponse, readJson } from '~/server/http'

export const Route = createFileRoute('/api/auth/login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readJson<{ password?: unknown }>(request)
          const finish = beginAttempt(request)
          let ok = false
          try {
            ok = typeof body.password === 'string' && (await verifyPassword(body.password))
          } finally {
            finish(ok)
          }
          if (!ok) throw new HttpError(401, msg(m.api_auth_wrongPassword))
          const { token } = createSession()
          return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(request, token) } })
        } catch (e) {
          return errorResponse(e)
        }
      },
    },
  },
})
