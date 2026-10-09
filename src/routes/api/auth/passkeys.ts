import { createFileRoute } from '@tanstack/react-router'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'
import { authed, readJson } from '~/server/http'
import { listPasskeys, register } from '~/server/passkeys'

export const Route = createFileRoute('/api/auth/passkeys')({
  server: {
    handlers: {
      GET: authed(() => Response.json({ passkeys: listPasskeys() })),
      // Stores the passkey the browser made for the challenge from /api/auth/passkeys/options
      POST: authed(async ({ request }, session) => {
        const body = await readJson<{ response?: RegistrationResponseJSON; name?: unknown }>(request)
        const passkey = await register(request, session.id, body.response as RegistrationResponseJSON, body.name)
        return Response.json({ ok: true, passkey })
      }),
    },
  },
})
