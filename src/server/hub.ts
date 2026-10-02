// The hub runs all collectors on their own intervals, merges the result into
// one Snapshot and pushes changes to SSE subscribers.

import { asc, lt } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Container, Disk, HiddenService, Share, Snapshot, SourceStatus, SystemMetrics, Unit } from '~/shared/types'
import { collectDisks } from './collectors/disks'
import { collectShares } from './collectors/shares'
import { PodmanCollector } from './collectors/podman'
import { readHostInfo, SystemCollector } from './collectors/system'
import { collectUnits, systemdVersion } from './collectors/systemd'
import { config } from './config'
import { db, schema } from './db'
import { HealthChecker } from './health'
import { iconIndex } from './icons'
import type { PrivilegedActions, UnitAction } from './privileged/actions'
import { assertUnitName } from './privileged/actions'
import { DbusActions } from './privileged/dbus'
import { CaddyProvider, candidatesFromConfig } from './providers/caddy'
import type { ServiceCandidate } from './providers/types'
import { localHostSet, mergeServices } from './registry'

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
}

export class Hub {
  private systemCollector = new SystemCollector()
  private podman = new PodmanCollector(config().podmanSocket)
  private caddy = new CaddyProvider(config().caddyAdmin, config().caddyfile)
  private health = new HealthChecker()
  private actions: PrivilegedActions = new DbusActions()
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
  }
  private shares: Share[] = []
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
      this.fixtures = { containers: load('containers.json'), units, disks: load('disks.json'), caddy: load('caddy.json') }
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
    const slow = every(30_000, async () => {
      await Promise.allSettled([this.collectDisks(), this.collectCaddy(), this.collectShares()])
      this.publish()
    })
    const health = every(60_000, async () => {
      await this.health.checkAll(this.healthTargets())
      if (!this.fixtures) this.host = { ...this.host, uptimeSec: readHostInfo().uptimeSec }
      this.publish()
    })
    every(3600_000, async () => {
      db().delete(schema.metricSamples).where(lt(schema.metricSamples.ts, Date.now() - 24 * 3600_000)).run()
    })
    // First round right away (timers are already registered, so a failure here
    // does not leave the hub dead).
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
      this.system = this.systemCollector.sample()
      this.ok('system')
      if (Date.now() - this.lastSampleAt >= 30_000 && this.system.memTotal) {
        this.lastSampleAt = Date.now()
        const s = this.system
        const rows = [
          { metric: 'cpu', value: s.cpu },
          { metric: 'ram', value: s.memUsed / s.memTotal },
          { metric: 'net_rx', value: s.net.rx },
          { metric: 'net_tx', value: s.net.tx },
          ...(s.temp ? [{ metric: 'temp', value: s.temp.celsius }] : []),
        ].map((r) => ({ ...r, ts: s.ts }))
        db().insert(schema.metricSamples).values(rows).run()
      }
    } catch (e) {
      this.fail('system', e)
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

  private async collectShares() {
    try {
      const dir = config().fixturesDir
      this.shares = collectShares(
        dir ? { smbConf: join(dir, 'smb.conf'), exports: join(dir, 'exports'), exportsDir: join(dir, 'exports.d') } : { smbConf: config().smbConf, exports: config().exports, exportsDir: config().exportsDir },
      )
      this.ok('shares')
    } catch (e) {
      this.fail('shares', e)
    }
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
    const [sd, pm] = await Promise.allSettled([systemdVersion(), this.podman.client.version()])
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
      sources: this.sources,
      readonly: config().readonly,
    }
  }

  /** Rebuilds the snapshot and notifies subscribers if anything besides live metrics changed. */
  publish() {
    const snap = this.build()
    this.current = snap
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

  async unitAction(action: UnitAction, name: string) {
    this.assertWritable()
    try {
      assertUnitName(name)
    } catch (e) {
      throw new ActionError(400, (e as Error).message)
    }
    // Only units we actually know about (fixed action list, no arbitrary targets).
    if (!this.units.some((u) => u.name === name) && !this.containers.some((c) => c.unit === name)) throw new ActionError(404, `Unbekannte Unit: ${name}`)
    if (this.fixtures) {
      this.fixtures.units = (this.fixtures.units ?? []).map((u) =>
        u.name === name ? { ...u, active: action === 'stop' ? 'inactive' : 'active', sub: action === 'stop' ? 'dead' : 'running', result: 'success', since: Date.now() } : u,
      )
    } else {
      await this.actions.unit(action, name)
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
  async containerAction(action: UnitAction, name: string): Promise<'systemd' | 'podman'> {
    this.assertWritable()
    const c = this.containers.find((x) => x.name === name)
    if (!c) throw new ActionError(404, `Unbekannter Container: ${name}`)
    if (c.unit) {
      await this.unitAction(action, c.unit)
      return 'systemd'
    }
    if (this.fixtures) {
      this.fixtures.containers = (this.fixtures.containers ?? []).map((x) => (x.name === name ? { ...x, state: action === 'stop' ? 'exited' : 'running' } : x))
    } else {
      await this.podman.client.action(c.id, action)
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
    g.__quadeckHub = new Hub()
    g.__quadeckHubStarted = g.__quadeckHub.start()
  }
  return g.__quadeckHub
}

export async function hubReady(): Promise<Hub> {
  const h = hub()
  await g.__quadeckHubStarted
  return h
}
