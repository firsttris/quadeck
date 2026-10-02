import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { hub } from '~/server/hub'
import { privileged } from '~/server/privileged'
import { mergeContainerPorts } from '~/shared/network'

// GET: interfaces, routes, DNS, listening ports (with container names) and firewall.
export const Route = createFileRoute('/api/network/')({
  server: {
    handlers: {
      GET: authed(async () => {
        const s = await privileged().networkState()
        return Response.json({ ...s, ports: mergeContainerPorts(s.ports, hub().snapshot().containers, s.firewall) })
      }),
    },
  },
})
