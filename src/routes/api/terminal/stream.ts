import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'
import { assertTerminalAllowed, forget, owned } from '~/server/terminal/web'

// GET ?id=…: the terminal's output as server-sent events (screen so far, then live; `exit` at the end).
export const Route = createFileRoute('/api/terminal/stream')({
  server: {
    handlers: {
      GET: authed(async ({ request }, session) => {
        assertTerminalAllowed(request)
        const id = owned(new URL(request.url).searchParams.get('id'), session.id)
        try {
          const res = await privileged().terminalStream(id)
          // The helper ends the stream when the shell is gone (exit, idle timeout, lock): forget it
          // then, or the terminal list keeps showing it. A browser leaving only cancels the stream.
          const body = res.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => void forget(id) }))
          return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
        } catch (e) {
          forget(id)
          throw e
        }
      }),
    },
  },
})
