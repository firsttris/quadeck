import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/server/db'
import { authed } from '~/server/http'
import { parseRange, queryHistory } from '~/server/metrics'

// Averaged history of all stored metrics for ?range=1h|6h|24h|7d.
export const Route = createFileRoute('/api/metrics/history')({
  server: {
    handlers: {
      GET: authed(({ request }) => {
        const range = parseRange(new URL(request.url).searchParams.get('range'))
        return Response.json({ range, series: queryHistory(db(), range) })
      }),
    },
  },
})
