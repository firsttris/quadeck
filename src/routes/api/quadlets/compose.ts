import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { composeToQuadlets } from '~/server/quadlets/compose'

// docker-compose.yml → Quadlet files (preview only; saving goes through PUT /api/quadlets/file).
export const Route = createFileRoute('/api/quadlets/compose')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const b = await readJson<{ yaml?: unknown; project?: unknown }>(request)
        if (typeof b.yaml !== 'string' || !b.yaml.trim()) throw new HttpError(400, 'docker-compose.yml fehlt')
        let doc: unknown
        try {
          doc = Bun.YAML.parse(b.yaml)
        } catch (e) {
          throw new HttpError(422, `YAML-Fehler: ${(e as Error).message}`)
        }
        return Response.json(composeToQuadlets(doc, typeof b.project === 'string' && b.project.trim() ? b.project : 'app'))
      }),
    },
  },
})
