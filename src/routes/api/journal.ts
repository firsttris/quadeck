import { createFileRoute } from '@tanstack/react-router'
import { getSession, HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { journalStream } from '~/server/journal'

export const Route = createFileRoute('/api/journal')({
  server: {
    handlers: {
      GET: authed(({ request }) => {
        const q = new URL(request.url).searchParams
        const unit = q.get('unit') || undefined
        const prio = q.get('priority')
        let stream
        try {
          stream = journalStream({ unit, priority: prio ? Number(prio) : undefined }, request.signal, () => !!getSession(request))
        } catch (e) {
          throw new HttpError(400, (e as Error).message)
        }
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
        })
      }),
    },
  },
})
