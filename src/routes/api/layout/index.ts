import { createFileRoute } from '@tanstack/react-router'
import { authed, readJson } from '~/server/http'
import { parseSave, resetLayout, saveLayout } from '~/server/layout'

// Dashboard layout. Not blocked by read-only mode: it only changes the
// dashboard, never the host.
export const Route = createFileRoute('/api/layout/')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const { scope, breakpoint, items } = parseSave(await readJson<Record<string, unknown>>(request))
        saveLayout(scope, breakpoint, items)
        return Response.json({ ok: true })
      }),
      DELETE: authed(() => {
        resetLayout()
        return Response.json({ ok: true })
      }),
    },
  },
})
