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
  /** Per disk id: counter values from the history (web app only). */
  baselines?: Record<string, SmartBaseline>
}

/**
 * Lifetime counters never go back to zero – not after a new cable, a reboot or
 * formatting. What matters is whether they still grow: `crc` is the oldest
 * value of the last days (CRC_WINDOW_DAYS) from Quadeck's own history.
 */
export interface SmartBaseline {
  crc?: { value: number; since: number }
}

export const CRC_WINDOW_DAYS = 7

export type SmartLevel = 'ok' | 'warning' | 'critical'

export type SmartReason =
  | { kind: 'status'; status: SmartStatus }
  | { kind: 'unreadable' }
  | { kind: 'sectors'; attribute: SectorAttribute; count: number }
  | { kind: 'errors'; attribute: ErrorAttribute; count: number }
  /** CRC errors that still occur: `added` since `since`. */
  | { kind: 'crc'; count: number; added: number; since: number }
  | { kind: 'wear'; percent: number }
  | { kind: 'temperature'; celsius: number }
  | { kind: 'selftest'; status: string }

export type SectorAttribute = 'reallocated' | 'pending' | 'uncorrectable'
export type ErrorAttribute = 'reported_uncorrectable' | 'crc' | 'medium'

export interface SmartAssessment {
  level: SmartLevel
  reasons: SmartReason[]
  /** Worth knowing, no reason to act (e.g. old CRC errors that stopped). */
  notes: SmartNote[]
}

export type SmartNote = { kind: 'crc-old'; count: number; since?: number }

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

/** CRC errors that came after the baseline – the only ones that say something about today. */
export function crcAdded(count: number, baseline?: SmartBaseline): number {
  return baseline?.crc ? Math.max(0, count - baseline.crc.value) : 0
}

/** How alarming one attribute is (row colour in the table). */
export function attributeLevel(a: SmartAttribute, baseline?: SmartBaseline): SmartLevel {
  if (a.whenFailed === 'now') return 'critical'
  if (a.whenFailed === 'past') return 'warning'
  if (a.id === 199) return crcAdded(rawCount(a.raw), baseline) > 0 ? 'warning' : 'ok'
  const watched = SECTOR_ATTRIBUTES[a.id] ?? ERROR_ATTRIBUTES[a.id]
  return watched && rawCount(a.raw) > 0 ? 'warning' : 'ok'
}

const worst = (levels: SmartLevel[]): SmartLevel => (levels.includes('critical') ? 'critical' : levels.includes('warning') ? 'warning' : 'ok')

export function assessSmart(disk: SmartDisk, baseline?: SmartBaseline): SmartAssessment {
  const found: { level: SmartLevel; reason: SmartReason }[] = []
  const notes: SmartNote[] = []
  if (!disk.supported) return { level: 'ok', reasons: [], notes }
  const statusLevel = STATUS_LEVEL[disk.status]
  if (statusLevel) found.push({ level: statusLevel, reason: { kind: 'status', status: disk.status } })
  if (disk.status === 'UNKNOWN' && !disk.standby) found.push({ level: 'warning', reason: { kind: 'unreadable' } })
  for (const a of disk.attributes) {
    const count = rawCount(a.raw)
    if (count === 0) continue
    const sector = SECTOR_ATTRIBUTES[a.id]
    if (sector) found.push({ level: 'warning', reason: { kind: 'sectors', attribute: sector, count } })
    if (a.id === 199) {
      const added = crcAdded(count, baseline)
      if (added > 0) found.push({ level: 'warning', reason: { kind: 'crc', count, added, since: baseline!.crc!.since } })
      else notes.push({ kind: 'crc-old', count, since: baseline?.crc?.since })
      continue
    }
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
  return { level: worst(found.map((f) => f.level)), reasons: found.map((f) => f.reason), notes }
}

const hintFor = (r: SmartReason): SmartHint => {
  switch (r.kind) {
    case 'unreadable':
      return 'access'
    case 'temperature':
      return 'cooling'
    case 'crc':
      return 'cable'
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
    case 'crc':
      return `${r.added} neue Übertragungsfehler (CRC) seit ${dateDe(r.since)} – insgesamt ${r.count}; Kabel oder Backplane prüfen`
    case 'wear':
      return `${r.percent} % der vorgesehenen Lebensdauer verbraucht`
    case 'temperature':
      return `${r.celsius} °C – zu warm`
    case 'selftest':
      return `Letzter Selbsttest: ${r.status}`
  }
}

const dateDe = (ts: number) => new Date(ts).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })

export function describeNote(n: SmartNote): string {
  return n.since
    ? `${n.count} ältere Übertragungsfehler (CRC), seit ${dateDe(n.since)} keine neuen – der Zähler wird nie zurückgesetzt, nur ein Anstieg wäre ein Problem`
    : `${n.count} Übertragungsfehler (CRC) seit dem Einbau – der Zähler wird nie zurückgesetzt; Quadeck meldet sich, sobald neue dazukommen`
}

export const HINT_TEXT: Record<SmartHint, string> = {
  replace: 'Ersatz besorgen und Daten sichern – die Platte zeigt Verschleiß oder Defekte.',
  cable: 'SATA-Kabel und Stromanschluss prüfen oder tauschen; die Platte selbst ist oft in Ordnung. Der CRC-Zähler bleibt danach stehen, geht aber nicht zurück – steigt er nicht mehr, ist das Problem behoben.',
  cooling: 'Für bessere Kühlung sorgen (Luftstrom, Lüfter, Abstand zwischen den Platten).',
  access: 'smartctl kann die Platte nicht auslesen – USB-Gehäuse ohne SAT-Unterstützung oder fehlende Rechte.',
}
