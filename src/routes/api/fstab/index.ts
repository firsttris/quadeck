import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { parseFstabChange } from '~/server/fstab/parse'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

// fstab configurator.
// GET → entries, devices, history · ?revision=id → content of an earlier version.
// POST { validate: change } (no unlock) · with unlock: { apply: change, confirm } ·
// { mount: { target, action: 'mount' | 'unmount' } }.
export const Route = createFileRoute('/api/fstab/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const p = privileged()
        if (q.has('revision')) return Response.json({ content: await p.fstabRevision(q.get('revision') ?? '') })
        return Response.json(await p.fstabState())
      }),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ validate?: unknown; apply?: unknown; confirm?: unknown; mount?: { target?: unknown; action?: unknown } }>(request)
        const p = privileged()
        if (b.validate) return Response.json(await p.validateFstab(parseFstabChange(b.validate)))
        assertWritable()
        const token = unlockToken(session.id)
        let state
        if (b.apply) state = await p.applyFstab(token, parseFstabChange(b.apply), b.confirm === true)
        else if (b.mount && typeof b.mount.target === 'string') state = await p.mountAction(token, b.mount.target, b.mount.action === 'unmount' ? 'unmount' : 'mount')
        else throw new HttpError(400, 'Unbekannte Anfrage')
        void (await hubReady()).refreshDisks()
        return Response.json(state)
      }),
    },
  },
})
