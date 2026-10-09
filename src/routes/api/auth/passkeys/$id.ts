import { createFileRoute } from '@tanstack/react-router'
import { authed, readJson } from '~/server/http'
import { deletePasskey, renamePasskey } from '~/server/passkeys'

export const Route = createFileRoute('/api/auth/passkeys/$id')({
  server: {
    handlers: {
      PUT: authed(async ({ request, params }: { request: Request; params: { id: string } }) => {
        renamePasskey(params.id, (await readJson<{ name?: unknown }>(request)).name)
        return Response.json({ ok: true })
      }),
      DELETE: authed(({ params }: { request: Request; params: { id: string } }) => {
        deletePasskey(params.id)
        return Response.json({ ok: true })
      }),
    },
  },
})
