import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'
import { PACKAGE_NAME } from '~/shared/packages'

export const Route = createFileRoute('/api/system/packages/$name')({
  server: {
    handlers: {
      GET: authed(async ({ params }: { request: Request; params: { name: string } }) => {
        if (!PACKAGE_NAME.test(params.name)) throw new HttpError(400, msg(m.api_packages_invalidName))
        const detail = await privileged().detail(params.name)
        if (!detail) throw new HttpError(404, msg(m.api_packages_notInstalled, { package: params.name }))
        return Response.json(detail)
      }),
    },
  },
})
