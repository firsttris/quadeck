import { describe, expect, it } from 'vitest'
import { mapContainer, parseHealth } from '~/server/collectors/podman'

describe('podman', () => {
  it('parses health from the compat Status string', () => {
    expect(parseHealth('Up 2 hours (healthy)')).toBe('healthy')
    expect(parseHealth('Up 3 seconds (health: starting)')).toBe('starting')
    expect(parseHealth('Up 1 minute (unhealthy)')).toBe('unhealthy')
    expect(parseHealth('Up 2 hours')).toBeUndefined()
  })

  it('maps a compat container incl. unit label, published ports and aliases', () => {
    const c = mapContainer(
      {
        Id: 'abc123def4567890',
        Names: ['/jellyfin'],
        Image: 'docker.io/jellyfin/jellyfin:latest',
        State: 'running',
        Status: 'Up 2 days (healthy)',
        Labels: { PODMAN_SYSTEMD_UNIT: 'jellyfin.service', 'quadeck.group': 'Medien' },
        Ports: [
          { IP: '', PrivatePort: 8096, PublicPort: 8096, Type: 'tcp' },
          { PrivatePort: 1900, Type: 'udp' },
        ],
        NetworkSettings: { Networks: { media: { IPAddress: '10.89.3.5', Aliases: ['jellyfin', 'jf', 'abc123def456'] } } },
      },
      { aliases: ['media-server'], hostname: 'abc123def456' },
    )
    expect(c).toMatchObject({
      name: 'jellyfin',
      unit: 'jellyfin.service',
      health: 'healthy',
      ports: [{ hostPort: 8096, containerPort: 8096, protocol: 'tcp' }],
      networks: ['media'],
      ips: ['10.89.3.5'],
    })
    expect(c.aliases.sort()).toEqual(['jf', 'media-server'])
  })

  it('treats containers without the label as unit-less', () => {
    const c = mapContainer({ Id: 'x'.repeat(64), Names: ['/scratch'], Image: 'alpine', State: 'exited', Status: 'Exited (0)', Labels: null, Ports: null })
    expect(c.unit).toBeUndefined()
    expect(c.ports).toEqual([])
  })
})
