import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { parseSshChange } from '~/server/ssh/backend'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

// GET: service, host keys, settings, keys per user, logins.
// POST { change, preview: true } → diff; { change } → apply (unlock); { service: action }.
export const Route = createFileRoute('/api/ssh/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().sshState())),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ change?: unknown; preview?: unknown; service?: unknown }>(request)
        const p = privileged()
        if (b.service !== undefined) {
          assertWritable()
          if (!['start', 'restart', 'enable'].includes(b.service as string)) throw new HttpError(400, msg(m.helper_error_invalidServiceAction))
          return Response.json(await p.sshService(unlockToken(session.id), b.service as 'start'))
        }
        const change = parseSshChange(b.change)
        if (b.preview === true) return Response.json(await p.previewSsh(change))
        assertWritable()
        return Response.json(await p.applySsh(unlockToken(session.id), change))
      }),
    },
  },
})
