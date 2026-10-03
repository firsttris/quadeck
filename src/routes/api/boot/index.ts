import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { msg } from '~/shared/i18n'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

// Boot. GET → loader, entries, settings, warnings, kernel command line.
// POST with unlock: { default: id } · { timeout: '3' | 'menu-hidden' | 'menu-force' } ·
// { cancelOneshot: true } · { update: true } · { reboot: { entry?, firmware? } } ·
// { createEntry: 'linux-lts' } · { removeEntry: id }. GET ?entryPreview=linux-lts → { path, content }.
export const Route = createFileRoute('/api/boot/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const pkg = new URL(request.url).searchParams.get('entryPreview')
        return Response.json(pkg !== null ? await privileged().kernelEntryPreview(pkg) : await privileged().bootState())
      }),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ default?: unknown; timeout?: unknown; cancelOneshot?: unknown; update?: unknown; reboot?: { entry?: unknown; firmware?: unknown }; createEntry?: unknown; removeEntry?: unknown }>(request)
        assertWritable()
        const p = privileged()
        const token = unlockToken(session.id)
        if (typeof b.default === 'string') return Response.json(await p.setBootDefault(token, b.default))
        if (typeof b.timeout === 'string') return Response.json(await p.setBootTimeout(token, b.timeout))
        if (b.cancelOneshot === true) return Response.json(await p.cancelOneshot(token))
        if (b.update === true) return Response.json(await p.updateBootLoader(token))
        if (typeof b.createEntry === 'string') return Response.json(await p.createKernelEntry(token, b.createEntry))
        if (typeof b.removeEntry === 'string') return Response.json(await p.removeBootEntry(token, b.removeEntry))
        if (b.reboot && typeof b.reboot === 'object') {
          const entry = typeof b.reboot.entry === 'string' && b.reboot.entry ? b.reboot.entry : undefined
          return Response.json(await p.reboot(token, { entry, firmware: b.reboot.firmware === true }))
        }
        throw new HttpError(400, msg('common_errors_unknownRequest'))
      }),
    },
  },
})
