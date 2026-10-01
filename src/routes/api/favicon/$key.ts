import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { hubReady } from '~/server/hub'
import { faviconFor } from '~/server/favicon'

// Favicon of a known service (fallback when dashboard-icons has no match).
// Only keys of discovered/manual services are accepted — no open proxy.
export const Route = createFileRoute('/api/favicon/$key')({
  server: {
    handlers: {
      GET: authed(async ({ params }: { request: Request; params: { key: string } }) => {
        const hub = await hubReady()
        const svc = hub
          .snapshot()
          .services.flatMap((g) => g.items)
          .find((s) => s.key === params.key)
        if (!svc) return new Response('not found', { status: 404 })
        const f = await faviconFor(svc.key, svc.url)
        if (!f) return new Response('not found', { status: 404 })
        return new Response(new Blob([f.data as Uint8Array<ArrayBuffer>]), { headers: { 'content-type': f.type, 'cache-control': 'private, max-age=86400', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' } })
      }),
    },
  },
})
