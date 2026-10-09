import { createFileRoute } from '@tanstack/react-router'
import { errorResponse } from '~/server/http'
import { loginOptions } from '~/server/passkeys'

// The challenge for a passkey login (no session yet)
export const Route = createFileRoute('/api/auth/passkey/options')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return Response.json(await loginOptions(request))
        } catch (e) {
          return errorResponse(e)
        }
      },
    },
  },
})
