import { describe, expect, it } from 'vitest'
import { buildRows, matches } from '~/lib/unit-rows'
import type { Container, Unit } from '~/shared/types'

const unit = (name: string, o: Partial<Unit> = {}): Unit => ({ name, description: name, load: 'loaded', active: 'active', sub: 'running', kind: 'service', ...o })
const ct = (name: string, o: Partial<Container> = {}): Container => ({
  id: name, name, image: 'img', state: 'running', status: 'Up', labels: {}, ports: [], networks: [], aliases: [], ips: [], cpuHistory: [], ...o,
})

describe('unit rows', () => {
  const units = [
    unit('jellyfin.service', { kind: 'quadlet', quadlet: { file: 'jellyfin.container', type: 'container' } }),
    unit('media-network.service', { kind: 'quadlet', quadlet: { file: 'media.network', type: 'network' }, sub: 'exited' }),
    unit('smb.service'),
    unit('backup.timer', { kind: 'timer' }),
    unit('broken.service', { active: 'failed', sub: 'failed' }),
  ]
  const containers = [ct('jellyfin', { unit: 'jellyfin.service', cpu: 3 }), ct('scratch'), ct('crashed', { state: 'exited', status: 'Exited (1) 2 minutes ago' })]
  const rows = buildRows(units, containers)

  it('merges containers into their unit and adds unit-less containers', () => {
    expect(rows).toHaveLength(7)
    expect(rows.find((r) => r.key === 'jellyfin.service')!.container?.name).toBe('jellyfin')
    expect(rows.filter((r) => !r.unit).map((r) => r.container!.name)).toEqual(['scratch', 'crashed'])
  })

  it('filters', () => {
    const names = (f: Parameters<typeof matches>[1]) => rows.filter((r) => matches(r, f)).map((r) => r.unit?.name ?? r.container!.name)
    expect(names('container')).toEqual(['jellyfin.service', 'scratch', 'crashed'])
    expect(names('service')).toEqual(['smb.service', 'broken.service'])
    expect(names('timer')).toEqual(['backup.timer'])
    expect(names('failed')).toEqual(['broken.service', 'crashed'])
    expect(names('all')).toHaveLength(7)
  })

  it('shows a container whose unit systemd does not list as its own row', () => {
    const r = buildRows([], [ct('orphan', { unit: 'gone.service' })])
    expect(r).toEqual([{ key: 'ct:orphan', container: expect.objectContaining({ name: 'orphan' }) }])
  })
})
