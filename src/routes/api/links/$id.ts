import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { hubReady } from '~/server/hub'
import { deleteLink } from '~/server/links'

export const Route = createFileRoute('/api/links/$id')({
  server: {
    handlers: {
      DELETE: authed(async ({ params }: { request: Request; params: { id: string } }) => {
        const id = Number(params.id)
        if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID')
        deleteLink(id)
        ;(await hubReady()).publish()
        return Response.json({ ok: true })
      }),
    },
  },
})
