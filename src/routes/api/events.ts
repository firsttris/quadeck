import { createFileRoute } from '@tanstack/react-router'
import { getSession } from '~/server/auth'
import { authed } from '~/server/http'
import { hubReady, type HubEvent } from '~/server/hub'
import { localizeDeep, requestLang } from '~/server/lang'
import type { Lang } from '~/shared/i18n'

const encoder = new TextEncoder()

// Every subscriber gets the same event object: encode it once per language, not once per tab.
const encoded = new WeakMap<object, Map<Lang, Uint8Array>>()
function encode(e: HubEvent, lang: Lang): Uint8Array {
  let byLang = encoded.get(e)
  if (!byLang) encoded.set(e, (byLang = new Map()))
  let bytes = byLang.get(lang)
  if (!bytes) byLang.set(lang, (bytes = encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(localizeDeep(e.data, lang))}\n\n`)))
  return bytes
}

// Server-Sent Events: a full "state" snapshot on connect and whenever
// something changes, "stats" (CPU/RAM per container and unit) when only those
// changed, plus "system" metrics every 2 s.
export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      // Lets the client tell an expired session (401) from a network error.
      HEAD: authed(() => new Response(null, { status: 204 })),
      GET: authed(async ({ request }) => {
        const hub = await hubReady()
        // Events come from the hub, outside of this request: localize for this viewer.
        const lang = requestLang(request)
        let unsubscribe = () => {}
        let ping: ReturnType<typeof setInterval> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (e: HubEvent) => {
              try {
                controller.enqueue(encode(e, lang))
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
