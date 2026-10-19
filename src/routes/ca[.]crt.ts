import { createFileRoute } from '@tanstack/react-router'
import { privileged } from '~/server/privileged'

// Caddy's local root CA (`tls internal`), for the backup client's setup command: it fetches this
// without checking the certificate and compares its SHA-256 with the one in the command. No login:
// a CA certificate is public. 404 when Caddy has no local CA Quadeck can find.
export const Route = createFileRoute('/ca.crt')({
  server: {
    handlers: {
      GET: async () => {
        const ca = await privileged()
          .caddyCa()
          .catch(() => undefined)
        if (!ca) return new Response('no local CA\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        return new Response(ca.pem, { headers: { 'content-type': 'application/x-pem-file', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
      },
    },
  },
})
