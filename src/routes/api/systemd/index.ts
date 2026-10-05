import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

// Unit editor.
// GET ?unit=x → files · ?unit&path&history → versions · ?unit&path&revision=id → content.
// POST { validate: { unit, path, content } } (no unlock) · with unlock:
// { write: { unit, path, content, restart } } · { delete: { unit, path } } ·
// { create: { unit, content, enable } } · { enable: { unit, enabled } }.
export const Route = createFileRoute('/api/systemd/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const unit = q.get('unit') ?? ''
        const path = q.get('path') ?? ''
        const p = privileged()
        if (q.has('history')) return Response.json(await p.unitFileHistory(unit, path))
        if (q.has('revision')) return Response.json({ content: await p.unitFileRevision(unit, path, q.get('revision') ?? '') })
        return Response.json(await p.unitDetail(unit))
      }),
      POST: authed(async ({ request }, session) => {
        type Body = Partial<Record<'validate' | 'write' | 'delete' | 'create' | 'enable', Record<string, unknown>>>
        const b = await readJson<Body>(request)
        const p = privileged()
        const str = (v: unknown) => (typeof v === 'string' ? v : '')
        if (b.validate) return Response.json(await p.validateUnitFile(str(b.validate.unit), str(b.validate.path), str(b.validate.content)))
        assertWritable()
        const token = unlockToken(session.id)
        if (b.write) return Response.json(await p.writeUnitFile(token, str(b.write.unit), str(b.write.path), str(b.write.content), b.write.restart === true, typeof b.write.expected === 'string' ? b.write.expected : undefined))
        if (b.delete) {
          await p.deleteUnitFile(token, str(b.delete.unit), str(b.delete.path))
          return Response.json({ ok: true })
        }
        if (b.create) return Response.json(await p.createUnit(token, str(b.create.unit), str(b.create.content), b.create.enable === true))
        if (b.enable) {
          await p.setUnitEnabled(token, str(b.enable.unit), b.enable.enabled === true)
          return Response.json({ ok: true })
        }
        throw new HttpError(400, msg(m.common_errors_unknownRequest))
      }),
    },
  },
})
