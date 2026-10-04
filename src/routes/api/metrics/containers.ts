import { createFileRoute } from '@tanstack/react-router'
import { queryUsage } from '~/server/container-usage'
import { db } from '~/server/db'
import { authed } from '~/server/http'
import { hub } from '~/server/hub'
import { parseUsageRange } from '~/shared/container-usage'

// CPU and RAM per container for ?range=24h|7d|30d (5-minute buckets, 30 days kept).
export const Route = createFileRoute('/api/metrics/containers')({
  server: {
    handlers: {
      GET: authed(({ request }) => {
        const range = parseUsageRange(new URL(request.url).searchParams.get('range'))
        const h = hub()
        // the bucket in progress counts too
        h.usage.flush()
        return Response.json({ range, containers: queryUsage(db(), range, h.usage.units), now: Date.now() })
      }),
    },
  },
})
