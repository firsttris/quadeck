import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { allTerminals, assertTerminalAllowed, forget, owned, ownedBy, remember, setTerminalSettings, terminalSettings } from '~/server/terminal/web'
import { unlockToken } from '~/server/unlock-sessions'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { CONTAINER_NAME } from '~/shared/terminal'

// GET: settings and this login's open terminals.
// POST { action: 'open', target: {kind:'shell'} | {kind:'container', name}, cols, rows } (unlock)
//      { action: 'input', id, data } | { action: 'resize', id, cols, rows } | { action: 'close', id }
//      { action: 'settings', enabled, localOnly, idleMinutes } (unlock)
export const Route = createFileRoute('/api/terminal/')({
  server: {
    handlers: {
      GET: authed(async (_ctx, session) => Response.json({ settings: terminalSettings(), sessions: ownedBy(session.id) })),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ action?: unknown; id?: unknown; data?: unknown; cols?: unknown; rows?: unknown; target?: { kind?: unknown; name?: unknown } }>(request)
        const p = privileged()
        const token = unlockToken(session.id)
        switch (b.action) {
          case 'settings': {
            assertWritable()
            if ((await p.unlockedUntil(token)) === null) throw new HttpError(423, msg(m.terminal_error_unlock))
            const before = terminalSettings()
            const s = setTerminalSettings({ ...before, ...b })
            // switched off: every open terminal ends
            if (!s.enabled)
              for (const id of allTerminals()) {
                await p.terminalClose(id).catch(() => {})
                forget(id)
              }
            return Response.json({ settings: s, sessions: ownedBy(session.id) })
          }
          case 'open': {
            assertWritable()
            assertTerminalAllowed(request)
            const t = b.target ?? {}
            if (t.kind === 'container' && (typeof t.name !== 'string' || !CONTAINER_NAME.test(t.name))) throw new HttpError(400, msg(m.terminal_error_container))
            const info = await p.terminalOpen(token, t.kind === 'container' ? { kind: 'container', name: t.name as string } : { kind: 'shell' }, Number(b.cols) || 80, Number(b.rows) || 24, terminalSettings().idleMinutes)
            remember(info, session.id)
            return Response.json(info)
          }
          case 'input':
            assertTerminalAllowed(request)
            await p.terminalInput(owned(b.id, session.id), typeof b.data === 'string' ? b.data : '')
            return Response.json({ ok: true })
          case 'resize':
            await p.terminalResize(owned(b.id, session.id), Number(b.cols), Number(b.rows))
            return Response.json({ ok: true })
          case 'close': {
            const id = owned(b.id, session.id)
            await p.terminalClose(id).catch(() => {})
            forget(id)
            return Response.json({ ok: true })
          }
          default:
            throw new HttpError(400, msg(m.api_shares_nothingToChange))
        }
      }),
    },
  },
})
