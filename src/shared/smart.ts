// SMART data of the drives and how alarming it is. The assessment follows
// snapraid-ui's smart-health.ts (same thresholds and reasons); the data
// comes from `smartctl --json` instead of `snapraid smart`.

export type SmartStatus = 'OK' | 'FAIL' | 'PREFAIL' | 'LOGFAIL' | 'LOGERR' | 'SELFERR' | 'UNKNOWN'

export interface SmartAttribute {
  id: number
  name: string
  value: number
  worst: number
  threshold: number
  raw: string
  /** Normalized value is or was below its threshold. */
  whenFailed?: 'now' | 'past'
  prefailure: boolean
}

export interface SmartSelfTest {
  type: string
  status: string
  passed: boolean
  hours?: number
}

export interface SmartDisk {
  /** Kernel name: sda, nvme0n1 */
  name: string
  device: string
  /** Stable id for the history (serial, else name). */
  id: string
  status: SmartStatus
  /** smartctl could talk to the drive (virtual disks, USB bridges without SAT: no). */
  supported: boolean
  /** Asleep: smartctl left it alone instead of spinning it up. */
  standby?: boolean
  model?: string
  family?: string
  serial?: string
  firmware?: string
  protocol?: string
  /** rpm, 0 = SSD */
  rotationRate?: number
  sizeBytes?: number
  temperature?: number
  powerOnHours?: number
  powerCycles?: number
  /** SSD/NVMe lifetime used in percent, may exceed 100. */
  wearLevel?: number
  /** NVMe media and data integrity errors. */
  errorMedium?: number
  unsafeShutdowns?: number
  attributes: SmartAttribute[]
  selfTests: SmartSelfTest[]
  /** A self-test is running: percent remaining. */
  testRunning?: number
  message?: string
}

export interface SmartReport {
  checkedAt: number
  disks: SmartDisk[]
  installed: boolean
  error?: string
}

export type SmartLevel = 'ok' | 'warning' | 'critical'

export type SmartReason =
  | { kind: 'status'; status: SmartStatus }
  | { kind: 'unreadable' }
  | { kind: 'sectors'; attribute: SectorAttribute; count: number }
  | { kind: 'errors'; attribute: ErrorAttribute; count: number }
  | { kind: 'wear'; percent: number }
  | { kind: 'temperature'; celsius: number }
  | { kind: 'selftest'; status: string }

export type SectorAttribute = 'reallocated' | 'pending' | 'uncorrectable'
export type ErrorAttribute = 'reported_uncorrectable' | 'crc' | 'medium'

export interface SmartAssessment {
  level: SmartLevel
  reasons: SmartReason[]
}

/** What to do: replace the disk, check its cable, cool it, or make it readable. */
export type SmartHint = 'replace' | 'cable' | 'cooling' | 'access'

export const HOT_CELSIUS = 50
export const CRITICAL_CELSIUS = 60
export const WORN_PERCENT = 80
export const CRITICAL_WEAR_PERCENT = 100

const STATUS_LEVEL: Partial<Record<SmartStatus, SmartLevel>> = {
  FAIL: 'critical', // the drive reports itself as failing
  PREFAIL: 'critical', // a pre-failure attribute is below its threshold now
  LOGFAIL: 'warning', // … was below its threshold in the past
  LOGERR: 'warning', // errors in the device error log
  SELFERR: 'warning', // a self-test failed
}

/** Growing counts of these are the most common early sign of a failing disk. */
export const SECTOR_ATTRIBUTES: Record<number, SectorAttribute> = { 5: 'reallocated', 197: 'pending', 198: 'uncorrectable' }
const ERROR_ATTRIBUTES: Record<number, ErrorAttribute> = {
  187: 'reported_uncorrectable', // read errors the disk could not correct with ECC
  199: 'crc', // transfer errors: cable or backplane rather than the disk
}

export const rawCount = (raw: string): number => {
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? 0 : n
}

/** How alarming one attribute is (row colour in the table). */
export function attributeLevel(a: SmartAttribute): SmartLevel {
  if (a.whenFailed === 'now') return 'critical'
  if (a.whenFailed === 'past') return 'warning'
  const watched = SECTOR_ATTRIBUTES[a.id] ?? ERROR_ATTRIBUTES[a.id]
  return watched && rawCount(a.raw) > 0 ? 'warning' : 'ok'
}

const worst = (levels: SmartLevel[]): SmartLevel => (levels.includes('critical') ? 'critical' : levels.includes('warning') ? 'warning' : 'ok')

export function assessSmart(disk: SmartDisk): SmartAssessment {
  const found: { level: SmartLevel; reason: SmartReason }[] = []
  if (!disk.supported) return { level: 'ok', reasons: [] }
  const statusLevel = STATUS_LEVEL[disk.status]
  if (statusLevel) found.push({ level: statusLevel, reason: { kind: 'status', status: disk.status } })
  if (disk.status === 'UNKNOWN' && !disk.standby) found.push({ level: 'warning', reason: { kind: 'unreadable' } })
  for (const a of disk.attributes) {
    const count = rawCount(a.raw)
    if (count === 0) continue
    const sector = SECTOR_ATTRIBUTES[a.id]
    if (sector) found.push({ level: 'warning', reason: { kind: 'sectors', attribute: sector, count } })
    const error = ERROR_ATTRIBUTES[a.id]
    if (error) found.push({ level: 'warning', reason: { kind: 'errors', attribute: error, count } })
  }
  if (disk.errorMedium) found.push({ level: 'warning', reason: { kind: 'errors', attribute: 'medium', count: disk.errorMedium } })
  if (disk.wearLevel !== undefined && disk.wearLevel >= WORN_PERCENT)
    found.push({ level: disk.wearLevel >= CRITICAL_WEAR_PERCENT ? 'critical' : 'warning', reason: { kind: 'wear', percent: disk.wearLevel } })
  if (disk.temperature !== undefined && disk.temperature > HOT_CELSIUS)
    found.push({ level: disk.temperature >= CRITICAL_CELSIUS ? 'critical' : 'warning', reason: { kind: 'temperature', celsius: disk.temperature } })
  const lastTest = disk.selfTests[0]
  if (lastTest && !lastTest.passed && disk.status !== 'SELFERR') found.push({ level: 'warning', reason: { kind: 'selftest', status: lastTest.status } })
  return { level: worst(found.map((f) => f.level)), reasons: found.map((f) => f.reason) }
}

const hintFor = (r: SmartReason): SmartHint => {
  switch (r.kind) {
    case 'unreadable':
      return 'access'
    case 'temperature':
      return 'cooling'
    case 'errors':
      return r.attribute === 'crc' ? 'cable' : 'replace'
    case 'status':
      // The error log also fills up from loose cables and power losses.
      return r.status === 'LOGERR' ? 'cable' : 'replace'
    default:
      return 'replace'
  }
}

/** What to do about the problems, most urgent first. */
export function smartHints(assessments: SmartAssessment[]): SmartHint[] {
  const hints = new Set(assessments.flatMap((a) => a.reasons.map(hintFor)))
  return (['replace', 'cable', 'cooling', 'access'] as const).filter((h) => hints.has(h))
}

const STATUS_TEXT: Record<SmartStatus, string> = {
  OK: 'in Ordnung',
  FAIL: 'Die Platte meldet selbst einen bevorstehenden Ausfall',
  PREFAIL: 'Ein Vorausfall-Attribut liegt jetzt unter seinem Grenzwert',
  LOGFAIL: 'Ein Vorausfall-Attribut lag früher unter seinem Grenzwert',
  LOGERR: 'Fehler im Fehlerprotokoll der Platte',
  SELFERR: 'Ein Selbsttest ist fehlgeschlagen',
  UNKNOWN: 'unbekannt',
}

const SECTOR_TEXT: Record<SectorAttribute, string> = {
  reallocated: 'Sektoren wurden ersetzt (Reallocated)',
  pending: 'Sektoren warten auf Ersatz (Pending)',
  uncorrectable: 'Sektoren sind nicht lesbar (Offline Uncorrectable)',
}

const ERROR_TEXT: Record<ErrorAttribute, string> = {
  reported_uncorrectable: 'nicht korrigierbare Lesefehler',
  crc: 'Übertragungsfehler (CRC) – meist Kabel oder Backplane',
  medium: 'Medienfehler',
}

export function describeReason(r: SmartReason): string {
  switch (r.kind) {
    case 'status':
      return STATUS_TEXT[r.status]
    case 'unreadable':
      return 'SMART-Daten nicht lesbar'
    case 'sectors':
      return `${r.count} ${SECTOR_TEXT[r.attribute]}`
    case 'errors':
      return `${r.count} ${ERROR_TEXT[r.attribute]}`
    case 'wear':
      return `${r.percent} % der vorgesehenen Lebensdauer verbraucht`
    case 'temperature':
      return `${r.celsius} °C – zu warm`
    case 'selftest':
      return `Letzter Selbsttest: ${r.status}`
  }
}

export const HINT_TEXT: Record<SmartHint, string> = {
  replace: 'Ersatz besorgen und Daten sichern – die Platte zeigt Verschleiß oder Defekte.',
  cable: 'SATA-Kabel und Stromanschluss prüfen oder tauschen; die Platte selbst ist oft in Ordnung.',
  cooling: 'Für bessere Kühlung sorgen (Luftstrom, Lüfter, Abstand zwischen den Platten).',
  access: 'smartctl kann die Platte nicht auslesen – USB-Gehäuse ohne SAT-Unterstützung oder fehlende Rechte.',
}
