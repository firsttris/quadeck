import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

// Boot. GET → loader, entries, settings, warnings, kernel command line.
// POST with unlock: { default: id } · { timeout: '3' | 'menu-hidden' | 'menu-force' } ·
// { cancelOneshot: true } · { update: true } · { reboot: { entry?, firmware? } }.
export const Route = createFileRoute('/api/boot/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().bootState())),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ default?: unknown; timeout?: unknown; cancelOneshot?: unknown; update?: unknown; reboot?: { entry?: unknown; firmware?: unknown } }>(request)
        assertWritable()
        const p = privileged()
        const token = unlockToken(session.id)
        if (typeof b.default === 'string') return Response.json(await p.setBootDefault(token, b.default))
        if (typeof b.timeout === 'string') return Response.json(await p.setBootTimeout(token, b.timeout))
        if (b.cancelOneshot === true) return Response.json(await p.cancelOneshot(token))
        if (b.update === true) return Response.json(await p.updateBootLoader(token))
        if (b.reboot && typeof b.reboot === 'object') {
          const entry = typeof b.reboot.entry === 'string' && b.reboot.entry ? b.reboot.entry : undefined
          return Response.json(await p.reboot(token, { entry, firmware: b.reboot.firmware === true }))
        }
        throw new HttpError(400, 'Unbekannte Anfrage')
      }),
    },
  },
})
