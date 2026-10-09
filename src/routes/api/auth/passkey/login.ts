import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { createFileRoute } from '@tanstack/react-router'
import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
import { beginAttempt, createSession, HttpError, sessionCookie } from '~/server/auth'
import { errorResponse, readJson } from '~/server/http'
import { verifyLogin } from '~/server/passkeys'

export const Route = createFileRoute('/api/auth/passkey/login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readJson<{ response?: AuthenticationResponseJSON }>(request)
          const finish = beginAttempt(request)
          let ok = false
          try {
            ok = !!body.response && (await verifyLogin(request, body.response))
          } finally {
            finish(ok)
          }
          if (!ok) throw new HttpError(401, msg(m.api_passkey_unknown))
          const { token } = createSession()
          return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(request, token) } })
        } catch (e) {
          return errorResponse(e)
        }
      },
    },
  },
})
