import { createFileRoute } from '@tanstack/react-router'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { parseUserChange } from '~/server/users/parse'

// Accounts. GET → accounts, groups, shells, login history.
// POST { change } with unlock: create, update, password, lock, unlock, samba-password, delete.
export const Route = createFileRoute('/api/users/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().usersState())),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ change?: unknown }>(request)
        assertWritable()
        return Response.json(await privileged().applyUser(unlockToken(session.id), parseUserChange(b.change)))
      }),
    },
  },
})
