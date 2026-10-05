import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { parseItems } from '~/shared/podman-storage'

// GET: images, volumes, containers and networks with what uses them, the cleanup timer.
// POST { items: [{kind, id}] }: removes exactly these (if still unused) – unlock.
// POST { prune: 'weekly' | 'monthly' | null }: the cleanup timer – unlock.
export const Route = createFileRoute('/api/podman/storage')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().podmanStorage())),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ items?: unknown; prune?: unknown }>(request)
        const p = privileged()
        const token = unlockToken(session.id)
        if ('prune' in b) return Response.json(await p.setPodmanPrune(token, b.prune === 'weekly' || b.prune === 'monthly' ? b.prune : null))
        const items = parseItems(b.items)
        if (!items.length) throw new HttpError(400, msg(m.podstore_error_nothing))
        const r = await p.cleanPodman(token, items)
        return Response.json({ ...r, storage: await p.podmanStorage() })
      }),
    },
  },
})
