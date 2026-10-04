// CPU and RAM per container over days (Units → Usage). Shared types.

export const USAGE_RANGES = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const
export type UsageRange = keyof typeof USAGE_RANGES

export const parseUsageRange = (v: string | null): UsageRange => (v && v in USAGE_RANGES ? (v as UsageRange) : '24h')

export interface ContainerUsage {
  name: string
  unit?: string
  /** CPU in percent of one core (as podman stats), averaged over the time it ran. */
  cpuAvg: number
  cpuMax: number
  /** Bytes. */
  memAvg: number
  memMax: number
  /** Share of the range it was running, 0..1. */
  uptime: number
  cpu: [number, number][]
  cpuPeak: [number, number][]
  mem: [number, number][]
}
