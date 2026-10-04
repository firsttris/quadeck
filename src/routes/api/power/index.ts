import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { db } from '~/server/db'
import { energyReport, setEnergySettings } from '~/server/energy'
import { authed, readJson } from '~/server/http'
import { hub } from '~/server/hub'

// GET: power now (per component, disks), energy per hour/day/month, cost, standby savings.
// POST { price, baseW, lossPct }: the settings.
export const Route = createFileRoute('/api/power/')({
  server: {
    handlers: {
      GET: authed(async () => {
        const h = hub()
        return Response.json(energyReport(db(), h.energy.now, (d) => h.energy.diskKind(d)))
      }),
      POST: authed(async ({ request }) => {
        try {
          setEnergySettings(await readJson(request))
        } catch (e) {
          throw new HttpError(400, (e as Error).message)
        }
        const h = hub()
        return Response.json(energyReport(db(), h.energy.now, (d) => h.energy.diskKind(d)))
      }),
    },
  },
})
