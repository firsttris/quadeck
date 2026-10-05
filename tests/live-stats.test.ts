import { describe, expect, it } from 'vitest'
import { applyStats, liveStats, structureKey } from '~/shared/live-stats'
import type { Snapshot } from '~/shared/types'

const snap = (cpu: number, memory: number | undefined, extra: Partial<Snapshot> = {}) =>
  ({
    host: { hostname: 'nas', uptimeSec: 100 },
    system: { ts: 1 },
    disks: [],
    containers: [{ id: 'abc', name: 'jellyfin', state: 'running', cpu, memUsage: cpu * 10, cpuHistory: [cpu] }],
    units: [
      { name: 'jellyfin.service', active: 'active', memory },
      { name: 'sshd.service', active: 'active' },
    ],
    services: [],
    hiddenServices: [],
    shares: [],
    sources: { podman: { ok: true, updatedAt: cpu } },
    readonly: false,
    ...extra,
  }) as unknown as Snapshot

describe('live stats instead of the whole snapshot', () => {
  it('ignores CPU, memory, uptime and update times when comparing', () => {
    const a = snap(1, 100)
    const b = { ...snap(2, 200), host: { ...a.host, uptimeSec: 160 } }
    expect(structureKey(b)).toBe(structureKey(a))
    expect(structureKey(snap(1, 100, { readonly: true }))).not.toBe(structureKey(a))
    const stopped = snap(1, 100)
    stopped.units[0]!.active = 'inactive'
    expect(structureKey(stopped)).not.toBe(structureKey(a))
  })

  it('puts the stats into the browser snapshot', () => {
    const before = snap(1, 100)
    const next = applyStats(before, liveStats(snap(7, undefined)))
    expect(next.containers[0]).toMatchObject({ name: 'jellyfin', cpu: 7, memUsage: 70, cpuHistory: [7] })
    expect(next.units[0]!.memory).toBeUndefined()
    expect(next.units[1]).toBe(before.units[1]) // unchanged rows keep their identity
  })

  it('is much smaller than the snapshot', () => {
    const s = snap(1, 100)
    expect(JSON.stringify(liveStats(s)).length).toBeLessThan(JSON.stringify(s).length)
  })
})
