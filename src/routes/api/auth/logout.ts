import { createFileRoute } from '@tanstack/react-router'
import { clearedSessionCookie, destroySession } from '~/server/auth'
import { authed } from '~/server/http'

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: authed(({ request }) => {
        destroySession(request)
        return Response.json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie(request) } })
      }),
    },
  },
})
