import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { hubReady } from '~/server/hub'
import { deleteLink, updateLink, validateLink } from '~/server/links'
import { readJson } from '~/server/http'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/api/links/$id')({
  server: {
    handlers: {
      PUT: authed(async ({ request, params }: { request: Request; params: { id: string } }) => {
        const id = Number(params.id)
        if (!Number.isInteger(id)) throw new HttpError(400, msg(m.api_links_invalidId))
        const link = updateLink(id, validateLink(await readJson<Record<string, unknown>>(request)))
        void (await hubReady()).refreshServices()
        return Response.json({ ok: true, link })
      }),
      DELETE: authed(async ({ params }: { request: Request; params: { id: string } }) => {
        const id = Number(params.id)
        if (!Number.isInteger(id)) throw new HttpError(400, msg(m.api_links_invalidId))
        deleteLink(id)
        ;(await hubReady()).publish()
        return Response.json({ ok: true })
      }),
    },
  },
})
