// The hub runs all collectors on their own intervals, merges the result into
// one Snapshot and pushes changes to SSE subscribers.

import { asc } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Container, Disk, GpuMetrics, HiddenService, Share, Snapshot, SourceStatus, SystemMetrics, Unit } from '~/shared/types'
import { collectDisks } from './collectors/disks'
import { GpuCollector } from './collectors/gpu'
import { metricRows, pruneHistory, SAMPLE_EVERY_MS, seedFixtureHistory, seedSmartHistory, smartBaselines } from './metrics'
import { assessSmart } from '~/shared/smart'
import { smartSamples } from '~/shared/smart-metrics'
import { collectShares, sharesSummary } from './collectors/shares'
import { PodmanCollector } from './collectors/podman'
import { readHostInfo, SystemCollector } from './collectors/system'
import { collectUnits, systemdVersion } from './collectors/systemd'
import { config } from './config'
import { db, schema } from './db'
import { HealthChecker } from './health'
import { iconIndex } from './icons'
import type { UnitAction } from './privileged/actions'
import { assertUnitName } from './privileged/actions'
import { privileged } from './privileged'
import { CaddyProvider, candidatesFromConfig } from './providers/caddy'
import type { ServiceCandidate } from './providers/types'
import { localHostSet, mergeServices } from './registry'
import { notifier } from './notify'
import { outsideRequest } from './lang'

type Source = keyof Snapshot['sources']
export type HubEvent = { type: 'system'; data: SystemMetrics } | { type: 'state'; data: Snapshot }

export class ActionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Fixtures {
  containers?: Container[]
  units?: Unit[]
  disks?: Disk[]
  caddy?: unknown
  gpus?: GpuMetrics[]
}

export class Hub {
  private systemCollector = new SystemCollector()
  private gpuCollector = new GpuCollector()
  private gpus: GpuMetrics[] = []
  private priv = privileged()
  private podman = new PodmanCollector((path) => this.priv.podmanGet(path), this.priv.kind === 'local' ? config().podmanSocket : undefined)
  private caddy = new CaddyProvider(config().caddyAdmin, config().caddyfile)
  private health = new HealthChecker()
  private fixtures?: Fixtures

  private host = readHostInfo()
  private system: SystemMetrics | null = null
  private disks: Disk[] = []
  private containers: Container[] = []
  private units: Unit[] = []
  private candidates: ServiceCandidate[] = []
  private sources: Snapshot['sources'] = {
    system: { ok: false },
    disks: { ok: false },
    podman: { ok: false },
    systemd: { ok: false },
    caddy: { ok: false },
    shares: { ok: false },
    smart: { ok: false },
  }
  private shares: Share[] = []
  private smart: Snapshot['smart'] = []
  private lastSmartSampleAt = 0
  private current?: Snapshot
  private lastStateJson = ''
  private listeners = new Set<(e: HubEvent) => void>()
  private timers: ReturnType<typeof setInterval>[] = []
  private lastSampleAt = 0

  constructor() {
    const dir = config().fixturesDir
    if (dir) {
      const load = (f: string) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf8'))
        } catch {
          return undefined
        }
      }
      const host = load('host.json') ?? {}
      // Fixture timestamps are relative to when they were generated.
      const delta = host.generatedAt ? Date.now() - host.generatedAt : 0
      const shift = (t?: number) => (t ? t + delta : t)
      const units = (load('units.json') as Unit[] | undefined)?.map((u) => ({
        ...u,
        since: shift(u.since),
        timer: u.timer && { ...u.timer, next: shift(u.timer.next), last: shift(u.timer.last) },
      }))
      this.fixtures = { containers: load('containers.json'), units, disks: load('disks.json'), caddy: load('caddy.json'), gpus: load('gpus.json') }
      delete host.generatedAt
      this.host = { ...this.host, ...host }
    }
  }

  async start() {
    // Each job runs at most once at a time (a hung socket must not pile up runs),
    // and a failing job never stops the others.
    const guarded = (fn: () => Promise<unknown>) => {
      let busy = false
      return async () => {
        if (busy) return
        busy = true
        try {
          await fn()
        } catch (e) {
          console.error('[quadeck]', e)
        } finally {
          busy = false
        }
      }
    }
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const job = guarded(fn)
      this.timers.push(setInterval(job, ms))
      return job
    }
    every(2000, async () => {
      this.collectSystem()
      this.emit({ type: 'system', data: this.system! })
    })
    const fast = every(5000, async () => {
      await Promise.allSettled([this.collectPodman(), this.collectSystemd()])
      this.publish()
    })
    // SMART reads every disk (seconds each): every 30 min, trends stored hourly.
    const smart = every(30 * 60_000, async () => {
      await this.collectSmart()
      this.publish()
    })
    setTimeout(() => void smart(), 5_000)
    const slow = every(30_000, async () => {
      await Promise.allSettled([this.collectDisks(), this.collectCaddy(), this.collectShares()])
      this.publish()
    })
    const health = every(60_000, async () => {
      await this.health.checkAll(this.healthTargets())
      if (!this.fixtures) this.host = { ...this.host, uptimeSec: readHostInfo().uptimeSec }
      this.publish()
    })
    const gpu = every(5000, async () => this.collectGpus())
    every(3600_000, async () => pruneHistory(db()))
    const updates = every(15 * 60_000, () => notifier().checkUpdates(this.host.hostname, this.priv))
    setTimeout(() => void updates(), 60_000)
    if (this.fixtures) seedFixtureHistory(db())
    // First round right away (timers are already registered, so a failure here
    // does not leave the hub dead).
    await gpu()
    this.collectSystem()
    await Promise.allSettled([fast(), slow(), this.collectVersions()])
    void health()
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  private ok(src: Source) {
    this.sources[src] = { ok: true, updatedAt: Date.now() }
  }

  private fail(src: Source, e: unknown) {
    const error = (e as Error).message ?? String(e)
    if (this.sources[src].error !== error) console.warn(`[quadeck] ${src}: ${error}`)
    this.sources[src] = { ok: false, error, updatedAt: Date.now() }
  }

  private collectSystem() {
    try {
      this.system = { ...this.systemCollector.sample(), gpus: this.gpus.length ? this.gpus : undefined }
      this.ok('system')
      if (Date.now() - this.lastSampleAt >= SAMPLE_EVERY_MS && this.system.memTotal) {
        this.lastSampleAt = Date.now()
        const rows = metricRows(this.system)
        if (rows.length) db().insert(schema.metricSamples).values(rows).run()
      }
    } catch (e) {
      this.fail('system', e)
    }
  }

  private async collectGpus() {
    try {
      if (this.fixtures) {
        // Demo: a little movement around the fixture values.
        this.gpus = (this.fixtures.gpus ?? []).map((g) => ({ ...g, util: g.util !== undefined ? Math.min(1, Math.max(0, g.util + (Math.random() - 0.5) * 0.1)) : undefined }))
      } else this.gpus = await this.gpuCollector.collect()
    } catch (e) {
      console.warn('[quadeck] gpu:', (e as Error).message)
      this.gpus = []
    }
  }

  private async collectPodman() {
    try {
      this.containers = this.fixtures ? (this.fixtures.containers ?? []) : await this.podman.collect()
      this.ok('podman')
    } catch (e) {
      this.fail('podman', e)
    }
  }

  private async collectSystemd() {
    try {
      this.units = this.fixtures ? (this.fixtures.units ?? []) : await collectUnits()
      this.ok('systemd')
    } catch (e) {
      this.fail('systemd', e)
    }
  }

  private async collectDisks() {
    try {
      this.disks = this.fixtures?.disks ?? (await collectDisks())
      this.ok('disks')
    } catch (e) {
      this.fail('disks', e)
    }
  }

  /** From the helper (same source as the shares page); the files directly if it is not reachable. */
  async collectShares() {
    try {
      try {
        this.shares = sharesSummary(await this.priv.sharesState())
      } catch (e) {
        if (this.fixtures) throw e
        this.shares = collectShares({ smbConf: config().smbConf, exports: config().exports, exportsDir: config().exportsDir })
      }
      this.ok('shares')
    } catch (e) {
      this.fail('shares', e)
    }
  }

  /** SMART verdicts for the overview; hourly trend samples into the metric history. */
  async collectSmart(refresh = false) {
    try {
      const report = await this.priv.smartReport(refresh)
      if (this.fixtures) seedSmartHistory(db(), report.disks.map((d) => ({ id: d.id, samples: smartSamples(d) })))
      if (Date.now() - this.lastSmartSampleAt >= 55 * 60_000) {
        const rows = report.disks.flatMap((d) => smartSamples(d).map((r) => ({ ts: report.checkedAt, metric: `smart:${d.id}:${r.key}`, value: r.value })))
        if (rows.length) db().insert(schema.metricSamples).values(rows).run()
        this.lastSmartSampleAt = Date.now()
      }
      // CRC counters are judged by their growth, so against the history (written above first).
      const base = smartBaselines(db(), report.disks.map((d) => d.id))
      this.smart = report.disks.map((d) => ({ name: d.name, level: assessSmart(d, base[d.id]).level, supported: d.supported, standby: d.standby }))
      if (report.installed) this.ok('smart')
      else this.sources.smart = { ok: false, updatedAt: Date.now() } // not an error: see the disks page
    } catch (e) {
      this.fail('smart', e)
    }
  }

  /** After a change on the mounts page. */
  async refreshDisks() {
    await this.collectDisks()
    this.publish()
  }

  /** After a change on the shares page. */
  async refreshShares() {
    await this.collectShares()
    this.publish()
  }

  private async collectCaddy() {
    try {
      if (this.fixtures) {
        this.candidates = this.fixtures.caddy ? candidatesFromConfig(this.fixtures.caddy as never) : []
      } else {
        this.candidates = await this.caddy.discover()
      }
      this.ok('caddy')
    } catch (e) {
      this.fail('caddy', e)
    }
  }

  private async collectVersions() {
    if (this.fixtures) return
    const [sd, pm] = await Promise.allSettled([systemdVersion(), this.podman.version()])
    this.host = {
      ...this.host,
      systemdVersion: sd.status === 'fulfilled' ? sd.value : undefined,
      podmanVersion: pm.status === 'fulfilled' ? pm.value : undefined,
    }
  }

  private build(): Snapshot {
    const localNames = [hostname(), ...Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((i) => i.address))]
    const d = db()
    const hiddenServices: HiddenService[] = []
    const services = mergeServices({
      onHidden: (s) => hiddenServices.push(s),
      candidates: this.candidates,
      containers: this.containers,
      manual: d.select().from(schema.manualServices).all(),
      overrides: d.select().from(schema.serviceOverrides).all(),
      groupOrder: d.select().from(schema.groups).orderBy(asc(schema.groups.order)).all().map((g) => g.name),
      httpHealth: this.health.results,
      iconIndex: iconIndex(),
      localHosts: localHostSet(localNames),
    })
    return {
      host: this.host,
      system: this.system,
      disks: this.disks,
      containers: this.containers,
      units: this.units,
      services,
      hiddenServices,
      shares: this.shares,
      smart: this.smart,
      sources: this.sources,
      readonly: config().readonly,
    }
  }

  /** Rebuilds the snapshot and notifies subscribers if anything besides live metrics changed. */
  publish() {
    const snap = this.build()
    this.current = snap
    notifier()
      .evaluate(snap)
      .catch((e) => console.warn('[quadeck] Benachrichtigung:', (e as Error).message))
    const json = JSON.stringify({ ...snap, system: null, host: { ...snap.host, uptimeSec: 0 } })
    if (json !== this.lastStateJson) {
      this.lastStateJson = json
      this.emit({ type: 'state', data: snap })
    }
  }

  snapshot(): Snapshot {
    if (!this.current) this.current = this.build()
    return { ...this.current, system: this.system, host: this.host }
  }

  subscribe(fn: (e: HubEvent) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: HubEvent) {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch {
        // a broken subscriber must not stop the others
      }
    }
  }

  private healthTargets() {
    return this.snapshot().services.flatMap((g) => g.items.map((s) => ({ url: s.url, probe: s.probe })))
  }

  /** Re-reads manual links/overrides from the DB and pushes the result. */
  async refreshServices() {
    this.publish()
    if (this.healthTargets().some((t) => !this.health.results.has(t.url))) {
      await this.health.checkAll(this.healthTargets())
      this.publish()
    }
  }

  // ---------- actions ----------

  assertWritable() {
    if (config().readonly) throw new ActionError(403, 'Read-only-Modus: Aktionen sind deaktiviert (QUADECK_READONLY)')
  }

  /** token: the session's unlock token (see /api/unlock). */
  async unitAction(action: UnitAction, name: string, token: string | undefined) {
    this.assertWritable()
    await this.priv.check(token) // locked → 423 before anything else
    try {
      assertUnitName(name)
    } catch (e) {
      throw new ActionError(400, (e as Error).message)
    }
    // Only units we actually know about (fixed action list, no arbitrary targets).
    if (!this.units.some((u) => u.name === name) && !this.containers.some((c) => c.unit === name)) throw new ActionError(404, `Unbekannte Unit: ${name}`)
    if (this.fixtures) {
      await this.priv.check(token)
      this.fixtures.units = (this.fixtures.units ?? []).map((u) =>
        u.name === name ? { ...u, active: action === 'stop' ? 'inactive' : 'active', sub: action === 'stop' ? 'dead' : 'running', result: 'success', since: Date.now() } : u,
      )
    } else {
      await this.priv.unit(token, action, name)
    }
    await this.collectSystemd()
    await this.collectPodman()
    this.publish()
  }

  /**
   * Containers with a Quadlet unit are always controlled through systemd —
   * never past it — so systemd does not restart a container one meant to stop
   * and --rm containers do not vanish. Only containers without unit go to the
   * Podman API.
   */
  async containerAction(action: UnitAction, name: string, token: string | undefined): Promise<'systemd' | 'podman'> {
    this.assertWritable()
    await this.priv.check(token)
    const c = this.containers.find((x) => x.name === name)
    if (!c) throw new ActionError(404, `Unbekannter Container: ${name}`)
    if (c.unit) {
      await this.unitAction(action, c.unit, token)
      return 'systemd'
    }
    if (this.fixtures) {
      await this.priv.check(token)
      this.fixtures.containers = (this.fixtures.containers ?? []).map((x) => (x.name === name ? { ...x, state: action === 'stop' ? 'exited' : 'running' } : x))
    } else {
      await this.priv.podmanContainer(token, c.id, action)
    }
    await this.collectPodman()
    this.publish()
    return 'podman'
  }
}

const g = globalThis as unknown as { __quadeckHub?: Hub; __quadeckHubStarted?: Promise<void> }

/** The process-wide hub, started on first use. */
export function hub(): Hub {
  if (!g.__quadeckHub) {
    // Collectors run for every viewer: their texts keep both languages (see src/shared/i18n.ts).
    outsideRequest(() => {
      g.__quadeckHub = new Hub()
      g.__quadeckHubStarted = g.__quadeckHub.start()
    })
  }
  return g.__quadeckHub!
}

export async function hubReady(): Promise<Hub> {
  const h = hub()
  await g.__quadeckHubStarted
  return h
}
