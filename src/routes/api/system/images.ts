import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

// Container image updates (podman auto-update --dry-run). POST: check now.
export const Route = createFileRoute('/api/system/images')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().imageUpdates(false))),
      POST: authed(async () => Response.json(await privileged().imageUpdates(true))),
    },
  },
})
