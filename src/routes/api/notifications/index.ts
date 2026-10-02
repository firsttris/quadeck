import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { hub } from '~/server/hub'
import { notifier } from '~/server/notify'
import { maskSettings, parseSettings, type NotifyState } from '~/shared/notify'

const masked = (s: NotifyState): NotifyState => ({ ...s, settings: maskSettings(s.settings) })

// GET: settings (tokens masked), reported problems, recent messages.
// POST { settings } → save · { test: channel } → send a test message to it.
export const Route = createFileRoute('/api/notifications/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(masked(notifier().state()))),
      POST: authed(async ({ request }) => {
        const b = await readJson<{ settings?: unknown; test?: unknown }>(request)
        const n = notifier()
        const current = n.settings()
        if (b.test !== undefined) {
          let s
          try {
            s = parseSettings({ ...current, channels: [b.test] }, current)
          } catch (e) {
            throw new HttpError(400, (e as Error).message)
          }
          const host = hub().snapshot().host.hostname
          const sent = await n.deliver({ title: `${host}: Testnachricht`, body: 'Benachrichtigungen von Quadeck kommen an.', severity: 'info' }, s.channels, true)
          return Response.json({ ...masked(n.state()), sent })
        }
        if (b.settings === undefined) throw new HttpError(400, 'Unbekannte Anfrage')
        try {
          n.save(parseSettings(b.settings, current))
        } catch (e) {
          throw new HttpError(400, (e as Error).message)
        }
        // Report current problems right away (e.g. after adding the first channel).
        hub().publish()
        return Response.json(masked(n.state()))
      }),
    },
  },
})
