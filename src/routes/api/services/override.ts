import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { deleteOverride, saveOverride, setHidden, validateOverride } from '~/server/overrides'

// Service overrides from the UI (name, group, URL, icon, hidden, pinned).
// Only touches the dashboard, so read-only mode does not block it.
export const Route = createFileRoute('/api/services/override')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const body = await readJson<Record<string, unknown>>(request)
        if (body.onlyHidden === true) {
          if (typeof body.key !== 'string' || typeof body.hidden !== 'boolean') throw new HttpError(400, 'key und hidden erforderlich')
          setHidden(body.key, body.hidden)
        } else {
          saveOverride(validateOverride(body))
        }
        void (await hubReady()).refreshServices()
        return Response.json({ ok: true })
      }),
      DELETE: authed(async ({ request }) => {
        const body = await readJson<{ key?: unknown }>(request)
        if (typeof body.key !== 'string') throw new HttpError(400, 'key erforderlich')
        deleteOverride(body.key)
        ;(await hubReady()).publish()
        return Response.json({ ok: true })
      }),
    },
  },
})
