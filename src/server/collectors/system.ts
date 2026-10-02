// System collector: CPU, RAM, load, uptime, network and temperature from /proc and /sys.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { hostname, cpus, release } from 'node:os'
import type { HostInfo, SystemMetrics } from '~/shared/types'

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

// ---------- pure parsers (unit-tested) ----------

export interface CpuTimes {
  idle: number
  total: number
}

export function parseProcStat(text: string): CpuTimes | undefined {
  const line = text.split('\n').find((l) => l.startsWith('cpu '))
  if (!line) return undefined
  const v = line.trim().split(/\s+/).slice(1).map(Number)
  // user nice system idle iowait irq softirq steal (guest is already in user)
  const idle = (v[3] ?? 0) + (v[4] ?? 0)
  const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0)
  return { idle, total }
}

export function cpuUsage(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total
  if (dt <= 0) return 0
  return Math.min(1, Math.max(0, 1 - (cur.idle - prev.idle) / dt))
}

export function parseMeminfo(text: string): { total: number; available: number } {
  const kb = (k: string) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024
  const total = kb('MemTotal')
  const available = kb('MemAvailable') || kb('MemFree') + kb('Buffers') + kb('Cached')
  return { total, available }
}

export function parseLoadavg(text: string): [number, number, number] {
  const [a, b, c] = text.trim().split(/\s+/).map(Number)
  return [a || 0, b || 0, c || 0]
}

export function parseNetDev(text: string): Record<string, { rx: number; tx: number }> {
  const out: Record<string, { rx: number; tx: number }> = {}
  for (const line of text.split('\n').slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/)
    if (!m) continue
    const f = m[2]!.trim().split(/\s+/).map(Number)
    out[m[1]!.trim()] = { rx: f[0] ?? 0, tx: f[8] ?? 0 }
  }
  return out
}

export function parseOsRelease(text: string): string {
  const get = (k: string) => text.match(new RegExp(`^${k}="?([^"\\n]*)"?`, 'm'))?.[1]
  return get('PRETTY_NAME') ?? ([get('NAME'), get('VERSION_ID')].filter(Boolean).join(' ') || 'Linux')
}

// ---------- host readers ----------

/** Physical interfaces only (those backed by a device), skipping bridges, veths and podman networks. */
function physicalInterfaces(): string[] {
  try {
    return readdirSync('/sys/class/net').filter((i) => i !== 'lo' && existsSync(`/sys/class/net/${i}/device`))
  } catch {
    return []
  }
}

const CPU_SENSORS = ['k10temp', 'coretemp', 'zenpower', 'cpu_thermal', 'soc_thermal', 'acpitz']

function readCpuTemp(): { celsius: number; sensor: string } | undefined {
  let best: { celsius: number; sensor: string; rank: number } | undefined
  try {
    for (const h of readdirSync('/sys/class/hwmon')) {
      const name = read(`/sys/class/hwmon/${h}/name`)?.trim()
      const rank = name ? CPU_SENSORS.indexOf(name) : -1
      if (rank < 0) continue
      const t = Number(read(`/sys/class/hwmon/${h}/temp1_input`))
      if (t > 0 && (!best || rank < best.rank)) best = { celsius: t / 1000, sensor: name!, rank }
    }
  } catch {
    // no hwmon
  }
  if (!best) {
    const t = Number(read('/sys/class/thermal/thermal_zone0/temp'))
    if (t > 0) return { celsius: t / 1000, sensor: 'thermal_zone0' }
    return undefined
  }
  return { celsius: best.celsius, sensor: best.sensor }
}

export function readHostInfo(): HostInfo {
  const uptime = Number(read('/proc/uptime')?.split(' ')[0] ?? 0)
  const c = cpus()
  return {
    hostname: hostname(),
    os: parseOsRelease(read('/etc/os-release') ?? read('/usr/lib/os-release') ?? ''),
    kernel: release(),
    uptimeSec: Math.floor(uptime),
    cpuCores: c.length || 1,
    cpuModel: c[0]?.model,
  }
}

export class SystemCollector {
  private prevCpu?: CpuTimes
  private prevNet?: { ts: number; rx: number; tx: number }

  sample(): SystemMetrics {
    const ts = Date.now()
    const cpuNow = parseProcStat(read('/proc/stat') ?? '')
    const cpu = cpuNow && this.prevCpu ? cpuUsage(this.prevCpu, cpuNow) : 0
    this.prevCpu = cpuNow

    const mem = parseMeminfo(read('/proc/meminfo') ?? '')
    const ifaces = physicalInterfaces()
    const dev = parseNetDev(read('/proc/net/dev') ?? '')
    let rxTot = 0
    let txTot = 0
    for (const i of ifaces) {
      rxTot += dev[i]?.rx ?? 0
      txTot += dev[i]?.tx ?? 0
    }
    let rx = 0
    let tx = 0
    if (this.prevNet) {
      const dt = (ts - this.prevNet.ts) / 1000
      if (dt > 0) {
        rx = Math.max(0, (rxTot - this.prevNet.rx) / dt)
        tx = Math.max(0, (txTot - this.prevNet.tx) / dt)
      }
    }
    this.prevNet = { ts, rx: rxTot, tx: txTot }
    const primary = ifaces[0]
    const speed = primary ? Number(read(`/sys/class/net/${primary}/speed`)) : NaN

    return {
      ts,
      cpu,
      load: parseLoadavg(read('/proc/loadavg') ?? ''),
      memTotal: mem.total,
      memUsed: Math.max(0, mem.total - mem.available),
      temp: readCpuTemp(),
      net: { rx, tx, iface: ifaces.join(', ') || '–', speedMbps: speed > 0 ? speed : undefined },
    }
  }
}
