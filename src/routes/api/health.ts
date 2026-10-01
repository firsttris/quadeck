import { createFileRoute } from '@tanstack/react-router'
import { hub } from '~/server/hub'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        hub() // starts the collectors on boot (main.ts calls this once)
        return Response.json({ ok: true })
      },
    },
  },
})
