import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { config } from '~/server/config'
import { checkPorts, devicesView, editDevice, forgetDevice, setDeviceSettings, wake } from '~/server/devices'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { hub } from '~/server/hub'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

let scanning: Promise<void> | undefined
let scannedAt = 0

// GET: the devices Quadeck has seen in the LAN, the last scan and the sweep interval.
// POST { action: 'scan' | 'edit' | 'forget' | 'ports' | 'wake' | 'settings', … }.
export const Route = createFileRoute('/api/network/devices')({
  server: {
    handlers: {
      GET: authed(async () => Response.json(devicesView())),
      POST: authed(async ({ request }) => {
        const b = await readJson<{
          action?: unknown
          key?: unknown
          ip?: unknown
          mac?: unknown
          label?: unknown
          note?: unknown
          known?: unknown
          sweepMinutes?: unknown
        }>(request)
        const demo = !!config().fixturesDir
        switch (b.action) {
          case 'scan':
            // One sweep at a time, at most every 20 s: the page's button is not a ping flood.
            if (!scanning && Date.now() - scannedAt > 20_000) {
              scannedAt = Date.now()
              scanning = hub()
                .scanDevicesNow()
                .finally(() => (scanning = undefined))
            }
            await scanning
            return Response.json(devicesView())
          case 'edit': {
            if (typeof b.key !== 'string') throw new HttpError(400, msg(m.devices_error_unknown))
            const { action: _a, key, ...rest } = b
            editDevice(key, rest)
            hub().publish()
            return Response.json(devicesView())
          }
          case 'forget':
            if (typeof b.key !== 'string') throw new HttpError(400, msg(m.devices_error_unknown))
            forgetDevice(b.key)
            hub().publish()
            return Response.json(devicesView())
          case 'ports':
            if (typeof b.ip !== 'string') throw new HttpError(400, msg(m.devices_error_subnet))
            return Response.json({ ports: await checkPorts(b.ip, demo) })
          case 'wake':
            assertWritable()
            if (typeof b.mac !== 'string') throw new HttpError(400, msg(m.devices_error_mac))
            return Response.json({ sent: await wake(b.mac, demo) })
          case 'settings':
            setDeviceSettings(b)
            return Response.json(devicesView())
          default:
            throw new HttpError(400, msg(m.devices_error_action))
        }
      }),
    },
  },
})
