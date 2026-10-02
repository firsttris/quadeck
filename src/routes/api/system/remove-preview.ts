import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { PACKAGE_NAME } from '~/shared/packages'

export const Route = createFileRoute('/api/system/remove-preview')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const { names } = await readJson<{ names?: unknown }>(request)
        if (!Array.isArray(names) || !names.length || names.length > 200 || !names.every((n) => typeof n === 'string' && PACKAGE_NAME.test(n))) throw new HttpError(400, 'Ungültige Paketnamen')
        return Response.json(await privileged().removePreview(names as string[]))
      }),
    },
  },
})
