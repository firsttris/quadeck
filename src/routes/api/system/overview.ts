import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { archNews } from '~/server/news'
import { privileged } from '~/server/privileged'

export const Route = createFileRoute('/api/system/overview')({
  server: {
    handlers: {
      GET: authed(async () => {
        const overview = await privileged().overview()
        const news = overview.manager === 'pacman' ? await archNews() : undefined
        return Response.json({ ...overview, news })
      }),
    },
  },
})
