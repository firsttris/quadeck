import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

export const Route = createFileRoute('/api/quadlets/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json({ files: await privileged().quadlets() })),
    },
  },
})
