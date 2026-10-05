import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { parseBootEntryChange } from '~/shared/boot'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

// Boot. GET → loader, entries, settings, warnings, kernel command line.
// GET ?entryPreview=linux-lts → { path, content } · ?entry=arch.conf → its file and history ·
// ?entry=arch.conf&revision=… → { content } · ?files → { files } on the boot partition.
// POST { check: text } (no unlock) → problems. With unlock: { default: id } ·
// { timeout: '3' | 'menu-hidden' | 'menu-force' } · { cancelOneshot: true } · { update: true } ·
// { reboot: { entry?, firmware? } } · { createEntry: 'linux-lts' } · { removeEntry: id } ·
// { entry: { kind: 'create' | 'edit' | 'rename', … } }.
export const Route = createFileRoute('/api/boot/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const p = privileged()
        const pkg = q.get('entryPreview')
        if (pkg !== null) return Response.json(await p.kernelEntryPreview(pkg))
        if (q.has('files')) return Response.json({ files: await p.bootFiles() })
        const entry = q.get('entry')
        if (entry !== null && q.has('revision')) return Response.json({ content: await p.bootEntryRevision(entry, q.get('revision') ?? '') })
        if (entry !== null) return Response.json(await p.bootEntryFile(entry))
        return Response.json(await p.bootState())
      }),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{
          check?: unknown
          default?: unknown
          timeout?: unknown
          cancelOneshot?: unknown
          update?: unknown
          reboot?: { entry?: unknown; firmware?: unknown }
          createEntry?: unknown
          removeEntry?: unknown
          entry?: unknown
        }>(request)
        const p = privileged()
        if (typeof b.check === 'string') return Response.json({ problems: await p.checkBootEntry(b.check) })
        assertWritable()
        const token = unlockToken(session.id)
        if (typeof b.default === 'string') return Response.json(await p.setBootDefault(token, b.default))
        if (typeof b.timeout === 'string') return Response.json(await p.setBootTimeout(token, b.timeout))
        if (b.cancelOneshot === true) return Response.json(await p.cancelOneshot(token))
        if (b.update === true) return Response.json(await p.updateBootLoader(token))
        if (typeof b.createEntry === 'string') return Response.json(await p.createKernelEntry(token, b.createEntry))
        if (typeof b.removeEntry === 'string') return Response.json(await p.removeBootEntry(token, b.removeEntry))
        if (b.entry !== undefined) {
          const change = parseBootEntryChange(b.entry)
          if (!change) throw new HttpError(400, msg(m.common_errors_unknownRequest))
          return Response.json(await p.writeBootEntry(token, change))
        }
        if (b.reboot && typeof b.reboot === 'object') {
          const entry = typeof b.reboot.entry === 'string' && b.reboot.entry ? b.reboot.entry : undefined
          return Response.json(await p.reboot(token, { entry, firmware: b.reboot.firmware === true }))
        }
        throw new HttpError(400, msg(m.common_errors_unknownRequest))
      }),
    },
  },
})
