import { createFileRoute } from '@tanstack/react-router'
import { authed, readJson } from '~/server/http'
import { parseSave, resetLayout, saveLayout, setIconSize } from '~/server/layout'

// Dashboard layout. Not blocked by read-only mode: it only changes the
// dashboard, never the host.
export const Route = createFileRoute('/api/layout/')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const body = await readJson<Record<string, unknown>>(request)
        // { iconSize } sets the size of the service icons, everything else is a grid
        if ('iconSize' in body) return Response.json({ ok: true, iconSize: setIconSize(body.iconSize) })
        const { scope, breakpoint, items } = parseSave(body)
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
