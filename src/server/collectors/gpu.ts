// GPU collector: NVIDIA via nvidia-smi, AMD (amdgpu) and Intel (i915, xe) via
// sysfs. Everything works without root; Intel iGPUs expose no load counter
// to normal users, so their clock (current/maximum) stands in for the load.

import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { GpuMetrics } from '~/shared/types'
import { run } from '../exec'

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return undefined
  }
}
const num = (p: string) => {
  const v = read(p)
  const n = v === undefined || v === '' ? NaN : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr --format=csv,noheader,nounits */
export function parseNvidiaSmi(out: string): GpuMetrics[] {
  return out
    .split('\n')
    .map((l) => l.split(',').map((c) => c.trim()))
    .filter((c) => c.length >= 6 && c[1])
    .map((c) => {
      const n = (s: string | undefined) => (s && /^[\d.]+$/.test(s) ? Number(s) : undefined)
      const util = n(c[2])
      const mib = 1024 * 1024
      return {
        id: `nvidia${c[0]}`,
        name: c[1]!,
        vendor: 'nvidia' as const,
        util: util !== undefined ? util / 100 : undefined,
        utilKind: 'load' as const,
        memUsed: n(c[3]) !== undefined ? n(c[3])! * mib : undefined,
        memTotal: n(c[4]) !== undefined ? n(c[4])! * mib : undefined,
        tempC: n(c[5]),
        powerW: n(c[6]),
        freqMhz: n(c[7]),
      }
    })
}

/** First hwmon directory of a DRM device. */
function hwmon(dev: string) {
  try {
    const d = readdirSync(join(dev, 'hwmon'))[0]
    return d ? join(dev, 'hwmon', d) : undefined
  } catch {
    return undefined
  }
}

/** One /sys/class/drm/cardN (amdgpu, i915, xe). `name` comes from lspci (once). */
export function readDrmCard(root: string, card: string, name: string | undefined): GpuMetrics | undefined {
  const dev = join(root, card, 'device')
  let driver = ''
  try {
    driver = basename(readlinkSync(join(dev, 'driver')))
  } catch {
    return undefined
  }
  const hw = hwmon(dev)
  const temp = hw ? num(join(hw, 'temp1_input')) : undefined
  const power = hw ? (num(join(hw, 'power1_average')) ?? num(join(hw, 'power1_input'))) : undefined
  const base = { id: card, tempC: temp !== undefined ? temp / 1000 : undefined, powerW: power !== undefined ? power / 1e6 : undefined }
  if (driver === 'amdgpu') {
    const busy = num(join(dev, 'gpu_busy_percent'))
    return {
      ...base,
      name: name ?? 'AMD GPU',
      vendor: 'amd',
      util: busy !== undefined ? busy / 100 : undefined,
      utilKind: 'load',
      memUsed: num(join(dev, 'mem_info_vram_used')),
      memTotal: num(join(dev, 'mem_info_vram_total')),
    }
  }
  if (driver === 'i915' || driver === 'xe') {
    // i915: cardN/gt_act_freq_mhz; xe: device/tile0/gt0/freq0/act_freq
    const act = num(join(root, card, 'gt_act_freq_mhz')) ?? num(join(dev, 'tile0/gt0/freq0/act_freq'))
    const max = num(join(root, card, 'gt_RP0_freq_mhz')) ?? num(join(root, card, 'gt_max_freq_mhz')) ?? num(join(dev, 'tile0/gt0/freq0/rp0_freq')) ?? num(join(dev, 'tile0/gt0/freq0/max_freq'))
    return {
      ...base,
      name: name ?? 'Intel GPU',
      vendor: 'intel',
      util: act !== undefined && max ? Math.min(1, act / max) : undefined,
      utilKind: 'clock',
      freqMhz: act,
      memUsed: num(join(dev, 'mem_info_vram_used')),
      memTotal: num(join(dev, 'mem_info_vram_total')),
    }
  }
  return undefined
}

/** "03:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]" …" → model name. */
export function parseLspciName(line: string): string | undefined {
  const parts = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!)
  const model = parts[2]
  if (!model) return undefined
  const bracket = model.match(/\[([^\]]+)\]/)?.[1]
  const vendor = /intel/i.test(parts[1] ?? '') ? 'Intel' : /amd|ati/i.test(parts[1] ?? '') ? 'AMD' : ''
  return [vendor, bracket ?? model].filter(Boolean).join(' ')
}

export class GpuCollector {
  private names = new Map<string, string | undefined>()
  private hasNvidia = !!Bun.which('nvidia-smi')

  constructor(private root = '/sys/class/drm') {}

  private cards() {
    try {
      return readdirSync(this.root).filter((c) => /^card\d+$/.test(c))
    } catch {
      return []
    }
  }

  private async name(card: string) {
    if (this.names.has(card)) return this.names.get(card)
    let name: string | undefined
    try {
      const slot = basename(readlinkSync(join(this.root, card, 'device')))
      if (Bun.which('lspci')) name = parseLspciName((await run(['lspci', '-mm', '-s', slot])).stdout.split('\n')[0] ?? '')
    } catch {
      // no PCI device
    }
    this.names.set(card, name)
    return name
  }

  async collect(): Promise<GpuMetrics[]> {
    const out: GpuMetrics[] = []
    if (this.hasNvidia) {
      const r = await run(['nvidia-smi', '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr', '--format=csv,noheader,nounits'], { timeoutMs: 5000 })
      if (r.code === 0) out.push(...parseNvidiaSmi(r.stdout))
    }
    for (const card of this.cards()) {
      if (!existsSync(join(this.root, card, 'device', 'driver'))) continue
      const g = readDrmCard(this.root, card, await this.name(card))
      if (g) out.push(g)
    }
    return out
  }
}
