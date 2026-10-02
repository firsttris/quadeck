// Types shared between server (collectors, registry) and UI.

export type Health = 'ok' | 'warn' | 'bad' | 'unknown'

export interface SourceStatus {
  ok: boolean
  error?: string
  updatedAt?: number
}

export interface HostInfo {
  hostname: string
  os: string
  kernel: string
  systemdVersion?: string
  podmanVersion?: string
  uptimeSec: number
  cpuCores: number
  cpuModel?: string
}

export interface SystemMetrics {
  ts: number
  cpu: number // 0..1
  load: [number, number, number]
  memTotal: number // bytes
  memUsed: number // bytes
  temp?: { celsius: number; sensor: string }
  net: { rx: number; tx: number; iface: string; speedMbps?: number } // bytes/s
}

export interface Disk {
  dev: string
  path: string
  mount: string
  fstype: string
  size: number
  used: number
  tempC?: number
  role: string
}

export interface ContainerPort {
  hostIp?: string
  hostPort: number
  containerPort: number
  protocol: string
}

export interface Container {
  id: string
  name: string
  image: string
  state: string // running, exited, created, paused …
  health?: 'healthy' | 'unhealthy' | 'starting'
  status: string
  labels: Record<string, string>
  ports: ContainerPort[]
  networks: string[]
  aliases: string[]
  ips: string[]
  unit?: string // PODMAN_SYSTEMD_UNIT
  cpu?: number // percent of one host (0..100)
  memUsage?: number // bytes
  cpuHistory: number[] // percent, oldest first
}

export type UnitKind = 'quadlet' | 'service' | 'timer' | 'other'

export interface Unit {
  name: string
  description: string
  load: string
  active: string // active, inactive, failed, activating …
  sub: string // running, dead, exited, waiting …
  kind: UnitKind
  quadlet?: { file: string; type: string } // e.g. jellyfin.container
  type?: string // Type= (simple, oneshot, notify …)
  result?: string // success, oom-kill, exit-code …
  exitStatus?: number
  memory?: number
  memoryMax?: number
  since?: number // ms epoch of last state change
  unitFileState?: string // enabled, disabled, static …
  timer?: { calendar?: string; next?: number; last?: number; unit?: string }
}

export type IconRef =
  | { kind: 'dash'; slug: string }
  | { kind: 'favicon'; key: string }
  | { kind: 'glyph'; glyph: string }

export interface Service {
  key: string
  name: string
  url: string
  host: string
  group: string
  icon: IconRef
  iconFallback: string // glyph used when an image icon fails to load
  color: string
  health: Health
  healthNote?: string
  container?: string
  unit?: string
  source: 'caddy' | 'label' | 'manual'
  /** Values set in the UI (service_overrides); empty fields follow discovery. */
  overridden?: { name?: string; group?: string; url?: string; icon?: string }
  /** Direct upstream (e.g. http://10.88.0.5:8096), probed when the public URL is not reachable from the server itself. */
  probe?: string
  manualId?: number
  healthCheck?: boolean // manual links: whether the URL is checked
  pinned?: boolean
}

export interface ServiceGroup {
  name: string
  note: string
  items: Service[]
}

export interface Share {
  type: 'SMB' | 'NFS'
  name: string
  path: string
  access: string // "lesen", "lesen/schreiben", NFS client list …
  note?: string // valid users, guest …
}

export interface HiddenService {
  key: string
  name: string
}

export interface Snapshot {
  host: HostInfo
  system: SystemMetrics | null
  disks: Disk[]
  containers: Container[]
  units: Unit[]
  services: ServiceGroup[]
  hiddenServices: HiddenService[]
  shares: Share[]
  sources: Record<'system' | 'disks' | 'podman' | 'systemd' | 'caddy' | 'shares', SourceStatus>
  readonly: boolean
}

export interface JournalEntry {
  ts: number // ms epoch
  unit: string
  priority: number
  message: string
  cursor?: string
}
