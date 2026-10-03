import { createFileRoute } from '@tanstack/react-router'
import { privileged } from '~/server/privileged'

const headers = { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

// The install/update script of a backup client, for `curl -fsSL <link> | sh`. No login: the
// one-time link (30 minutes, 192 random bits) is the authorisation, and it is used up here.
// An unknown, used or expired link answers with a script that says so, for the person at the terminal.
export const Route = createFileRoute('/api/backup/script/$token')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        let script: string | undefined
        try {
          script = await privileged().redeemBackupClientLink(params.token)
        } catch {
          script = undefined
        }
        if (script) return new Response(script, { headers })
        return new Response("#!/bin/sh\necho 'quadeck-backup: this link was already used or has expired – create a new one in Quadeck (Backups → Clients).' >&2\nexit 1\n", { status: 200, headers: { ...headers, 'x-quadeck-link': 'invalid' } })
      },
    },
  },
})
