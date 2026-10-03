import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import type { PodmanConfigName } from '~/shared/quadlets'

// GET: everything; POST: { timer: {enabled, calendar} } | { autoUpdateDefault: boolean } | { config: {name, content} }
export const Route = createFileRoute('/api/podman/settings')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().podmanSettings())),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ timer?: { enabled?: unknown; calendar?: unknown }; autoUpdateDefault?: unknown; config?: { name?: unknown; content?: unknown } }>(request)
        const p = privileged()
        const token = unlockToken(session.id)
        if (b.timer) await p.setAutoUpdateTimer(token, b.timer.enabled === true, typeof b.timer.calendar === 'string' ? b.timer.calendar.trim() : '')
        else if (typeof b.autoUpdateDefault === 'boolean') await p.setAutoUpdateDefault(token, b.autoUpdateDefault)
        else if (b.config && typeof b.config.name === 'string' && typeof b.config.content === 'string') await p.writePodmanConfig(token, b.config.name as PodmanConfigName, b.config.content)
        else throw new HttpError(400, msg('api_podman_nothingChange'))
        return Response.json(await p.podmanSettings())
      }),
    },
  },
})
