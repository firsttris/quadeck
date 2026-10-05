import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

// GET: Podman secrets (names, dates, which Quadlet uses them – never values) and passwords in
// plain text in Quadlet files. POST (unlock): { action: 'create' | 'replace', name, value } |
// { action: 'remove', name } | { action: 'move', file, key, name, restart }.
export const Route = createFileRoute('/api/podman/secrets')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().secretsState())),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ action?: unknown; name?: unknown; value?: unknown; file?: unknown; key?: unknown; restart?: unknown }>(request)
        const p = privileged()
        const token = unlockToken(session.id)
        const name = typeof b.name === 'string' ? b.name.trim() : ''
        switch (b.action) {
          case 'create':
          case 'replace':
            return Response.json(await p.createSecret(token, name, typeof b.value === 'string' ? b.value : '', b.action === 'replace'))
          case 'remove':
            return Response.json(await p.removeSecret(token, name))
          case 'move':
            if (typeof b.file !== 'string' || typeof b.key !== 'string') throw new HttpError(400, msg(m.secrets_error_noKey, { key: '', file: '' }))
            return Response.json(await p.moveSecret(token, b.file, b.key, name, b.restart !== false))
          default:
            throw new HttpError(400, msg(m.api_shares_nothingToChange))
        }
      }),
    },
  },
})
