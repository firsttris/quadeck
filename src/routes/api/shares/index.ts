import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { tr } from '~/shared/i18n'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { privileged } from '~/server/privileged'
import { parseShareChange } from '~/server/shares/backend'
import { unlockToken } from '~/server/unlock-sessions'

// GET: SMB shares, NFS exports, services, connections.
// POST { change, preview: true }: diff without writing; POST { change }: write (unlock needed).
// POST { service: { kind, action } }: start/stop/restart/enable smb or nfs.
export const Route = createFileRoute('/api/shares/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().sharesState())),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ change?: unknown; preview?: unknown; service?: { kind?: unknown; action?: unknown } }>(request)
        const p = privileged()
        if (b.service) {
          assertWritable()
          const { kind, action } = b.service
          if ((kind !== 'smb' && kind !== 'nfs') || !['start', 'stop', 'restart', 'enable'].includes(action as string)) throw new HttpError(400, tr('Ungültige Dienst-Aktion', 'Invalid service action'))
          const st = await p.shareService(unlockToken(session.id), kind, action as 'start')
          return Response.json(st)
        }
        const change = parseShareChange(b.change)
        if (b.preview === true) return Response.json(await p.previewShare(change))
        assertWritable()
        const st = await p.applyShare(unlockToken(session.id), change)
        void (await hubReady()).refreshShares()
        return Response.json(st)
      }),
    },
  },
})
