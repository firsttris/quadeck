import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

// GET: cached result (checked at most hourly). POST: check now.
export const Route = createFileRoute('/api/system/updates')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().updates(false))),
      POST: authed(async () => Response.json(await privileged().updates(true))),
    },
  },
})
