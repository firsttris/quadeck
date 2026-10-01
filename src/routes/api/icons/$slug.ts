import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { iconFile } from '~/server/icons'

export const Route = createFileRoute('/api/icons/$slug')({
  server: {
    handlers: {
      GET: authed(async ({ params }: { request: Request; params: { slug: string } }) => {
        const f = await iconFile(params.slug)
        if (!f) return new Response('not found', { status: 404 })
        return new Response(Bun.file(f.path), {
          headers: { 'content-type': f.type, 'cache-control': 'private, max-age=86400', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' },
        })
      }),
    },
  },
})
