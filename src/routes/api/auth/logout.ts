import { createFileRoute } from '@tanstack/react-router'
import { clearedSessionCookie, destroySession } from '~/server/auth'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'
import { clearUnlockToken, unlockToken } from '~/server/unlock-sessions'

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: authed(async ({ request }, session) => {
        await privileged().lock(unlockToken(session.id)).catch(() => {})
        clearUnlockToken(session.id)
        destroySession(request)
        return Response.json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie(request) } })
      }),
    },
  },
})
