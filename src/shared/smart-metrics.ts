import { rawCount, type SmartDisk } from './smart'

/** Values tracked over time per disk (metric_samples: smart:<id>:<key>). */
export function smartSamples(d: SmartDisk): { key: string; value: number }[] {
  if (!d.supported || d.standby) return []
  const attr = (id: number) => d.attributes.find((a) => a.id === id)
  const rows: { key: string; value: number | undefined }[] = [
    { key: 'temp', value: d.temperature },
    { key: 'realloc', value: attr(5) ? rawCount(attr(5)!.raw) : undefined },
    { key: 'pending', value: attr(197) ? rawCount(attr(197)!.raw) : undefined },
    { key: 'uncorrectable', value: attr(198) ? rawCount(attr(198)!.raw) : undefined },
    { key: 'crc', value: attr(199) ? rawCount(attr(199)!.raw) : undefined },
    { key: 'wear', value: d.wearLevel },
    { key: 'media', value: d.errorMedium },
    // Spin-ups (Start_Stop_Count): how often the disk wakes from standby.
    { key: 'startstop', value: attr(4) ? rawCount(attr(4)!.raw) : undefined },
  ]
  return rows.filter((r): r is { key: string; value: number } => r.value !== undefined && Number.isFinite(r.value))
}
