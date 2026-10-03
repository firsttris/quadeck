import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { hubReady } from '~/server/hub'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { parseCaddyChange } from '~/shared/caddy'
import { msg } from '~/shared/i18n'
import * as C from '~/i18n/common'

// Reverse proxy (Caddyfile).
// GET → file, sites, how it goes live · ?revision=id → content of an earlier version.
// POST with unlock: { apply: change, expected: hash } · { path: string | null } (pick by hand / back to automatic).
export const Route = createFileRoute('/api/caddy/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        const p = privileged()
        if (q.has('revision')) return Response.json({ content: await p.caddyRevision(q.get('revision') ?? '') })
        return Response.json(await p.caddyState())
      }),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ apply?: unknown; expected?: unknown; path?: unknown }>(request)
        assertWritable()
        const p = privileged()
        const token = unlockToken(session.id)
        if (b.apply) {
          let change
          try {
            change = parseCaddyChange(b.apply)
          } catch (e) {
            throw new HttpError(400, (e as Error).message)
          }
          const r = await p.applyCaddy(token, change, typeof b.expected === 'string' ? b.expected : undefined)
          // New or changed domains show up as tiles on the overview.
          void (await hubReady()).refreshCaddy()
          return Response.json(r)
        }
        if (b.path === null || typeof b.path === 'string') return Response.json(await p.setCaddyPath(token, b.path))
        throw new HttpError(
          400,
          msg(C, (m) => m.errors.unknownRequest),
        )
      }),
    },
  },
})
