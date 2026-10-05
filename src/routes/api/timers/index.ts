import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { parseSave, parseTimerAction } from '~/server/timers/backend'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

// GET: all timers · ?calendar=expr → next runs · ?files=x.timer → unit files.
// POST (unlock): { save: { spec, previous?, enable } } · { delete: name } ·
// { schedule: { name, calendar } } ('' = back to default) · { action: { name, action } }.
export const Route = createFileRoute('/api/timers/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const p = privileged()
        if (q.has('calendar')) return Response.json(await p.previewCalendar(q.get('calendar') ?? ''))
        if (q.has('files'))
          return Response.json({
            text: await p.timerFiles(q.get('files') ?? ''),
          })
        return Response.json(await p.timersState())
      }),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{
          save?: unknown
          delete?: unknown
          schedule?: { name?: unknown; calendar?: unknown }
          action?: { name?: unknown; action?: unknown }
        }>(request)
        const p = privileged()
        const token = unlockToken(session.id)
        const str = (v: unknown) => (typeof v === 'string' ? v : '')
        if (b.save !== undefined) {
          const s = parseSave(b.save)
          return Response.json(await p.saveTimer(token, s.spec, s.previous, s.enable))
        }
        if (b.delete !== undefined) return Response.json(await p.deleteTimer(token, str(b.delete)))
        if (b.schedule) return Response.json(await p.setTimerSchedule(token, str(b.schedule.name), str(b.schedule.calendar).trim()))
        if (b.action) return Response.json(await p.timerAction(token, str(b.action.name), parseTimerAction(b.action.action)))
        throw new HttpError(400, msg(m.common_errors_unknownRequest))
      }),
    },
  },
})
