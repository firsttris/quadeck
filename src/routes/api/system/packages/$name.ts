import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'
import { PACKAGE_NAME } from '~/shared/packages'

export const Route = createFileRoute('/api/system/packages/$name')({
  server: {
    handlers: {
      GET: authed(async ({ params }: { request: Request; params: { name: string } }) => {
        if (!PACKAGE_NAME.test(params.name)) throw new HttpError(400, 'Ungültiger Paketname')
        const detail = await privileged().detail(params.name)
        if (!detail) throw new HttpError(404, `Paket ${params.name} ist nicht installiert`)
        return Response.json(detail)
      }),
    },
  },
})
