import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

export const Route = createFileRoute('/api/system/cache')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => Response.json(await privileged().packageCache(new URL(request.url).searchParams.has('refresh')))),
    },
  },
})
