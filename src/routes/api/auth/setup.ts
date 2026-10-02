import { createFileRoute } from '@tanstack/react-router'
import { beginAttempt, checkSetupToken, createSession, hasPassword, HttpError, sessionCookie, setPassword } from '~/server/auth'
import { errorResponse, readJson } from '~/server/http'

export const Route = createFileRoute('/api/auth/setup')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (hasPassword()) throw new HttpError(409, 'Passwort ist bereits gesetzt')
          const body = await readJson<{ token?: unknown; password?: unknown }>(request)
          if (typeof body.token !== 'string' || typeof body.password !== 'string') throw new HttpError(400, 'Token und Passwort erforderlich')
          const finish = beginAttempt(request)
          const ok = checkSetupToken(body.token)
          finish(ok)
          if (!ok) throw new HttpError(403, 'Setup-Token ist falsch')
          await setPassword(body.password).catch((e) => {
            throw new HttpError(400, (e as Error).message)
          })
          const { token } = createSession()
          return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(request, token) } })
        } catch (e) {
          return errorResponse(e)
        }
      },
    },
  },
})
