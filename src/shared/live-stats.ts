// The part of the snapshot that changes on every collector tick (CPU and memory per container,
// memory per unit). The hub sends it as a small "stats" event; a full "state" goes out only when
// anything else changed.

import type { Snapshot } from './types'

export interface LiveStats {
  containers: { id: string; cpu?: number; memUsage?: number; cpuHistory: number[] }[]
  /** Units with a memory value; every other unit has none. */
  units: { name: string; memory: number }[]
}

export function liveStats(s: Snapshot): LiveStats {
  return {
    containers: s.containers.map((c) => ({ id: c.id, cpu: c.cpu, memUsage: c.memUsage, cpuHistory: c.cpuHistory })),
    units: s.units.flatMap((u) => (u.memory === undefined ? [] : [{ name: u.name, memory: u.memory }])),
  }
}

/** Everything else, to compare: live metrics, uptime and "last updated" times left out. */
export function structureKey(s: Snapshot): string {
  return JSON.stringify({
    ...s,
    system: null,
    host: { ...s.host, uptimeSec: 0 },
    sources: Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, { ...v, updatedAt: 0 }])),
    containers: s.containers.map(({ cpu: _c, memUsage: _m, cpuHistory: _h, ...c }) => c),
    units: s.units.map(({ memory: _m, ...u }) => u),
  })
}

/** Puts the stats into a snapshot (browser side). Containers and units not in it stay as they are. */
export function applyStats<S extends Pick<Snapshot, 'containers' | 'units'>>(s: S, stats: LiveStats): S {
  const byId = new Map(stats.containers.map((c) => [c.id, c]))
  const mem = new Map(stats.units.map((u) => [u.name, u.memory]))
  return {
    ...s,
    containers: s.containers.map((c) => {
      const x = byId.get(c.id)
      return x ? { ...c, cpu: x.cpu, memUsage: x.memUsage, cpuHistory: x.cpuHistory } : c
    }),
    units: s.units.map((u) => (mem.get(u.name) === u.memory ? u : { ...u, memory: mem.get(u.name) })),
  }
}
