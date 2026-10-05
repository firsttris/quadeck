// smartctl --json output → SmartDisk (unit-tested with captured output).

import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import type { SmartAttribute, SmartDisk, SmartSelfTest, SmartStatus } from '~/shared/smart'

/** smartctl exit status bits (man smartctl, "RETURN VALUES"). */
const BIT = { CMDLINE: 1 << 0, OPEN: 1 << 1, FAIL: 1 << 3, PREFAIL: 1 << 4, PREFAIL_LOGGED: 1 << 5, ERROR_LOGGED: 1 << 6, SELFTEST_LOGGED: 1 << 7 }

/** Same precedence as SnapRAID's report (and snapraid-ui). */
export function statusFromExit(code: number | undefined): SmartStatus {
  if (code === undefined || code & (BIT.CMDLINE | BIT.OPEN)) return 'UNKNOWN'
  if (code & BIT.FAIL) return 'FAIL'
  if (code & BIT.PREFAIL) return 'PREFAIL'
  if (code & BIT.PREFAIL_LOGGED) return 'LOGFAIL'
  if (code & BIT.ERROR_LOGGED) return 'LOGERR'
  if (code & BIT.SELFTEST_LOGGED) return 'SELFERR'
  return 'OK'
}

interface Json {
  smartctl?: { exit_status?: number; messages?: { string: string; severity?: string }[] }
  device?: { name?: string; protocol?: string; type?: string }
  model_family?: string
  model_name?: string
  serial_number?: string
  firmware_version?: string
  user_capacity?: { bytes?: number }
  nvme_total_capacity?: number
  rotation_rate?: number
  smart_status?: { passed?: boolean }
  temperature?: { current?: number }
  power_on_time?: { hours?: number }
  power_cycle_count?: number
  ata_smart_attributes?: {
    table?: { id: number; name: string; value: number; worst: number; thresh: number; when_failed?: string; flags?: { prefailure?: boolean }; raw?: { value?: number; string?: string } }[]
  }
  ata_smart_data?: { self_test?: { status?: { remaining_percent?: number; string?: string } } }
  ata_smart_self_test_log?: { standard?: { table?: { type?: { string?: string }; status?: { string?: string; passed?: boolean }; lifetime_hours?: number }[] } }
  nvme_smart_health_information_log?: {
    percentage_used?: number
    media_errors?: number
    unsafe_shutdowns?: number
    power_on_hours?: number
    power_cycles?: number
    temperature?: number
    critical_warning?: number
  }
  nvme_self_test_log?: {
    current_self_test_completion_percent?: number
    table?: { self_test_code?: { string?: string }; self_test_result?: { value?: number; string?: string }; power_on_hours?: number }[]
  }
  scsi_grown_defect_list?: number
}

export function parseSmartctl(name: string, text: string): SmartDisk {
  let j: Json = {}
  try {
    j = JSON.parse(text) as Json
  } catch {
    // no JSON at all (very old smartctl)
  }
  const exit = j.smartctl?.exit_status
  const messages = (j.smartctl?.messages ?? []).map((m) => m.string)
  const standby = messages.some((m) => /STANDBY|SLEEP/i.test(m)) && !!exit && !!(exit & BIT.OPEN)
  const openFailed = exit !== undefined && !!(exit & (BIT.CMDLINE | BIT.OPEN))
  const supported = !openFailed || standby
  const nvme = j.nvme_smart_health_information_log
  const attributes: SmartAttribute[] = (j.ata_smart_attributes?.table ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    value: a.value,
    worst: a.worst,
    threshold: a.thresh,
    // Some drives pack extra data into the raw string ("34 (Min/Max 20/45)"); the number is what counts.
    raw: String(a.raw?.string?.split(' ')[0] ?? a.raw?.value ?? ''),
    whenFailed: a.when_failed === 'now' || a.when_failed === 'past' ? a.when_failed : undefined,
    prefailure: !!a.flags?.prefailure,
  }))
  const attr = (id: number) => attributes.find((a) => a.id === id)
  // SSD life: NVMe percentage_used; SATA SSDs vary (177 Wear_Leveling_Count, 231 SSD_Life_Left, 233 Media_Wearout_Indicator) – normalized values count down from 100.
  let wearLevel = nvme?.percentage_used
  if (wearLevel === undefined && j.rotation_rate === 0) {
    const life = attr(231) ?? attr(233) ?? attr(177) ?? attr(202)
    if (life && life.value <= 100) wearLevel = 100 - life.value
  }
  const selfTests: SmartSelfTest[] = [
    ...(j.ata_smart_self_test_log?.standard?.table ?? []).map((t) => ({ type: t.type?.string ?? '?', status: t.status?.string ?? '?', passed: t.status?.passed !== false, hours: t.lifetime_hours })),
    ...(j.nvme_self_test_log?.table ?? []).map((t) => ({
      type: t.self_test_code?.string ?? '?',
      status: t.self_test_result?.string ?? '?',
      passed: (t.self_test_result?.value ?? 0) === 0,
      hours: t.power_on_hours,
    })),
  ]
  const ataRunning = j.ata_smart_data?.self_test?.status
  const testRunning =
    ataRunning?.remaining_percent !== undefined && /progress/i.test(ataRunning.string ?? '')
      ? ataRunning.remaining_percent
      : j.nvme_self_test_log?.current_self_test_completion_percent !== undefined
        ? 100 - j.nvme_self_test_log.current_self_test_completion_percent
        : undefined
  let status = statusFromExit(exit)
  // smartctl's exit bits do not see an NVMe critical warning as failure.
  if (nvme?.critical_warning && status === 'OK') status = 'PREFAIL'
  return {
    name,
    device: j.device?.name ?? `/dev/${name}`,
    id: j.serial_number ? `${j.model_name ?? ''}-${j.serial_number}`.replace(/[^A-Za-z0-9_.-]/g, '_') : name,
    status: supported ? status : 'UNKNOWN',
    supported,
    standby: standby || undefined,
    model: j.model_name,
    family: j.model_family,
    serial: j.serial_number,
    firmware: j.firmware_version,
    protocol: j.device?.protocol,
    rotationRate: j.rotation_rate ?? (nvme ? 0 : undefined),
    sizeBytes: j.user_capacity?.bytes ?? j.nvme_total_capacity,
    temperature: j.temperature?.current ?? nvme?.temperature,
    powerOnHours: j.power_on_time?.hours ?? nvme?.power_on_hours,
    powerCycles: j.power_cycle_count ?? nvme?.power_cycles,
    wearLevel,
    errorMedium: nvme?.media_errors,
    unsafeShutdowns: nvme?.unsafe_shutdowns,
    attributes,
    selfTests,
    testRunning: testRunning !== undefined && testRunning > 0 ? testRunning : undefined,
    message: !supported ? (messages.find((m) => !/^Warning/i.test(m)) ?? msg(m.disks_card_noSmart)) : standby ? msg(m.smart_status_asleep) : undefined,
  }
}

/** lsblk -d -J -o NAME,TYPE,TRAN → physical disks worth asking (no zram, loop, rom, md). */
export function physicalDisks(lsblkJson: string): string[] {
  const data = JSON.parse(lsblkJson) as { blockdevices?: { name: string; type: string }[] }
  return (data.blockdevices ?? []).filter((d) => d.type === 'disk' && !/^(zram|loop|ram|md|dm-|nbd|rbd)/.test(d.name)).map((d) => d.name)
}
