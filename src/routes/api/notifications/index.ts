import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { hub } from '~/server/hub'
import { notifier } from '~/server/notify'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { maskSettings, parseSettings, type NotifyState } from '~/shared/notify'
import { outsideRequest } from '~/server/lang'

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
          // Kept language-neutral in the log, like every other message.
          const notice = outsideRequest(() => ({
            title: msg(m.api_notifications_testTitle, { host }),
            body: msg(m.api_notifications_testBody),
            severity: 'info' as const,
          }))
          const sent = await n.deliver(notice, s.channels, true)
          return Response.json({ ...masked(n.state()), sent })
        }
        if (b.settings === undefined) throw new HttpError(400, msg(m.common_errors_unknownRequest))
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
