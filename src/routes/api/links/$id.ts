import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { hubReady } from '~/server/hub'
import { deleteLink, updateLink, validateLink } from '~/server/links'
import { readJson } from '~/server/http'
import { tr } from '~/shared/i18n'

export const Route = createFileRoute('/api/links/$id')({
  server: {
    handlers: {
      PUT: authed(async ({ request, params }: { request: Request; params: { id: string } }) => {
        const id = Number(params.id)
        if (!Number.isInteger(id)) throw new HttpError(400, tr('Ungültige ID', 'Invalid ID'))
        const link = updateLink(id, validateLink(await readJson<Record<string, unknown>>(request)))
        void (await hubReady()).refreshServices()
        return Response.json({ ok: true, link })
      }),
      DELETE: authed(async ({ params }: { request: Request; params: { id: string } }) => {
        const id = Number(params.id)
        if (!Number.isInteger(id)) throw new HttpError(400, tr('Ungültige ID', 'Invalid ID'))
        deleteLink(id)
        ;(await hubReady()).publish()
        return Response.json({ ok: true })
      }),
    },
  },
})
