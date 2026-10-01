import { createFileRoute } from '@tanstack/react-router'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { addLink, validateLink } from '~/server/links'

export const Route = createFileRoute('/api/links/')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        ;(await hubReady()).assertWritable()
        const link = addLink(validateLink(await readJson<Record<string, unknown>>(request)))
        void (await hubReady()).refreshServices()
        return Response.json({ ok: true, link })
      }),
    },
  },
})
