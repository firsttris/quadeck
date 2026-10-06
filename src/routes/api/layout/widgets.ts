import { createFileRoute } from '@tanstack/react-router'
import { authed, readJson } from '~/server/http'
import { addWidget, removeWidget, updateWidget } from '~/server/layout'

// Widgets added from the catalog. Like the layout, not blocked by read-only mode: it only changes
// the dashboard, never the host.
export const Route = createFileRoute('/api/layout/widgets')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const body = await readJson<{ kind?: unknown; config?: unknown }>(request)
        return Response.json(addWidget(body.kind, body.config))
      }),
      PUT: authed(async ({ request }) => {
        const body = await readJson<{ id?: unknown; config?: unknown }>(request)
        return Response.json(updateWidget(body.id, body.config))
      }),
      DELETE: authed(async ({ request }) => {
        removeWidget(new URL(request.url).searchParams.get('id'))
        return Response.json({ ok: true })
      }),
    },
  },
})
