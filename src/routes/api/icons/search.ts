import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { iconIndex, searchIcons } from '~/server/icons'

// Icon picker: matches from the dashboard-icons index (incl. aliases).
export const Route = createFileRoute('/api/icons/search')({
  server: {
    handlers: {
      GET: authed(({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? ''
        const idx = iconIndex()
        return Response.json({ available: !!idx, icons: idx ? searchIcons(idx, q, 48) : [] })
      }),
    },
  },
})
