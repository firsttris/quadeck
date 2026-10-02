import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { config } from '~/server/config'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { clearUnlockToken, setUnlockToken, unlockToken } from '~/server/unlock-sessions'

// Unlock privileged actions for this session (admin password, checked where
// the root actions run). GET: state · POST: unlock · DELETE: lock.
export const Route = createFileRoute('/api/unlock')({
  server: {
    handlers: {
      GET: authed(async (_ctx, session) => {
        if (config().readonly) return Response.json({ mode: 'readonly', until: null })
        const p = privileged()
        const info = await p.info()
        return Response.json({ ...info, until: await p.unlockedUntil(unlockToken(session.id)) })
      }),
      POST: authed(async ({ request }, session) => {
        if (config().readonly) throw new HttpError(403, 'Read-only-Modus (QUADECK_READONLY)')
        const body = await readJson<{ user?: unknown; password?: unknown }>(request)
        if (typeof body.password !== 'string') throw new HttpError(400, 'Passwort fehlt')
        const { token, expiresAt } = await privileged().unlock(typeof body.user === 'string' ? body.user : 'root', body.password)
        setUnlockToken(session.id, token)
        return Response.json({ ok: true, until: expiresAt })
      }),
      DELETE: authed(async (_ctx, session) => {
        await privileged().lock(unlockToken(session.id))
        clearUnlockToken(session.id)
        return Response.json({ ok: true })
      }),
    },
  },
})
