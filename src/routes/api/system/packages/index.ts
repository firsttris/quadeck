import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

export const Route = createFileRoute('/api/system/packages/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json({ packages: await privileged().installed() })),
    },
  },
})
