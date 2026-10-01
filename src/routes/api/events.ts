import { createFileRoute } from '@tanstack/react-router'
import { getSession } from '~/server/auth'
import { authed } from '~/server/http'
import { hubReady, type HubEvent } from '~/server/hub'

const encoder = new TextEncoder()

// Server-Sent Events: a full "state" snapshot on connect and whenever
// something changes, plus "system" metrics every 2 s.
export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      // Lets the client tell an expired session (401) from a network error.
      HEAD: authed(() => new Response(null, { status: 204 })),
      GET: authed(async ({ request }) => {
        const hub = await hubReady()
        let unsubscribe = () => {}
        let ping: ReturnType<typeof setInterval> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (e: HubEvent) => {
              try {
                controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`))
              } catch {
                unsubscribe()
              }
            }
            send({ type: 'state', data: hub.snapshot() })
            unsubscribe = hub.subscribe(send)
            ping = setInterval(() => {
              try {
                // Logout, password change or expiry ends open streams too.
                if (!getSession(request)) {
                  unsubscribe()
                  clearInterval(ping)
                  controller.close()
                  return
                }
                controller.enqueue(encoder.encode(': ping\n\n'))
              } catch {
                unsubscribe()
                clearInterval(ping)
              }
            }, 15_000)
            request.signal.addEventListener('abort', () => {
              unsubscribe()
              clearInterval(ping)
              try {
                controller.close()
              } catch {
                // already closed
              }
            })
          },
          cancel() {
            unsubscribe()
            clearInterval(ping)
          },
        })
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
        })
      }),
    },
  },
})
