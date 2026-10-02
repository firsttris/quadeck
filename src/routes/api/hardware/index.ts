import { createFileRoute } from '@tanstack/react-router'
import { authed } from '~/server/http'
import { privileged } from '~/server/privileged'

// GET → system, CPU, memory slots, GPUs, PCIe, USB, SATA links, sensors, warnings (read only).
export const Route = createFileRoute('/api/hardware/')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(await privileged().hardware())),
    },
  },
})
