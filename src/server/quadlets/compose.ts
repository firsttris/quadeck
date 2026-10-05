// docker-compose.yml → Quadlet files. Covers the common keys; everything
// else is reported as a warning so nothing disappears silently.

import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import type { ComposeResult } from '~/shared/quadlets'

type Obj = Record<string, unknown>

const SAFE = /[^A-Za-z0-9_.-]/g
const slug = (s: string) =>
  s
    .replace(SAFE, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 60) || 'app'

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
/** Unit-file values must stay on one line. */
const oneLine = (v: unknown) =>
  str(v)
    .replace(/[\r\n]+/g, ' ')
    .trim()

/** "a b" → shell-ish quoting as Quadlet expects in Exec=/HealthCmd=. */
function quoteArgs(v: unknown): string {
  if (Array.isArray(v)) return v.map((a) => (/[\s"'\\]/.test(String(a)) ? `"${String(a).replace(/(["\\])/g, '\\$1')}"` : String(a))).join(' ')
  return oneLine(v)
}

function kvList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(oneLine).filter(Boolean)
  if (isObj(v)) return Object.entries(v).map(([k, x]) => (x === null || x === undefined ? k : `${k}=${oneLine(x)}`))
  return []
}

function ports(v: unknown, warn: (s: string) => void): string[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((p) => {
    if (isObj(p)) {
      if (!p.target) return []
      const host = p.published ? `${p.host_ip ? `${p.host_ip}:` : ''}${p.published}:` : ''
      return [`${host}${p.target}${p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`]
    }
    const s = oneLine(p)
    if (!s.includes(':')) warn(msg(m.quadlets_compose_portNotPublished, { port: s }))
    return [s]
  })
}

export function composeToQuadlets(doc: unknown, project: string): ComposeResult {
  const warnings: string[] = []
  const files: { name: string; content: string }[] = []
  if (!isObj(doc) || !isObj(doc.services)) return { files, warnings: [msg(m.quadlets_compose_noServices)] }
  const prefix = slug(project)
  const services = doc.services as Record<string, unknown>
  const namedVolumes = isObj(doc.volumes) ? Object.keys(doc.volumes) : []
  const networks = isObj(doc.networks) ? Object.keys(doc.networks) : []
  // Compose puts all services of a project into one network.
  const defaultNet = `${prefix}.network`
  const needsDefaultNet = Object.keys(services).length > 1

  if (needsDefaultNet && !networks.length) files.push({ name: defaultNet, content: `[Network]\nNetworkName=${prefix}\n` })
  for (const n of networks) {
    const spec = (doc.networks as Obj)[n]
    if (isObj(spec) && spec.external) {
      warnings.push(msg(m.quadlets_compose_externalNetwork, { network: n }))
      continue
    }
    files.push({ name: `${slug(n)}.network`, content: `[Network]\nNetworkName=${slug(n)}\n` })
  }
  for (const v of namedVolumes) {
    const spec = (doc.volumes as Obj)[v]
    if (isObj(spec) && spec.external) {
      warnings.push(msg(m.quadlets_compose_externalVolume, { volume: v }))
      continue
    }
    files.push({ name: `${slug(v)}.volume`, content: `[Volume]\nVolumeName=${slug(v)}\n` })
  }

  const KNOWN = new Set([
    'image',
    'container_name',
    'ports',
    'volumes',
    'environment',
    'env_file',
    'command',
    'entrypoint',
    'restart',
    'depends_on',
    'labels',
    'networks',
    'healthcheck',
    'user',
    'working_dir',
    'devices',
    'cap_add',
    'cap_drop',
    'hostname',
    'network_mode',
    'build',
    'expose',
    'shm_size',
    'mem_limit',
    'tmpfs',
    'dns',
    'extra_hosts',
    'security_opt',
    'privileged',
    'read_only',
    'stop_signal',
    'sysctls',
    'ulimits',
    'secrets',
    'logging',
  ])

  for (const [name, raw] of Object.entries(services)) {
    if (!isObj(raw)) continue
    const s = raw
    const svc = slug(name)
    const warn = (m: string) => warnings.push(`${name}: ${m}`)
    const unit: string[] = [`Description=${oneLine(name)} (from docker-compose)`]
    const c: string[] = []
    const service: string[] = []

    if (!s.image) {
      if (s.build) warn(msg(m.quadlets_compose_buildNotConverted))
      else warn(msg(m.quadlets_compose_noImage))
    }
    let image = oneLine(s.image)
    // Short names break AutoUpdate=registry and need a search registry.
    const registry = image.split('/')[0]!
    if (image && !(image.includes('/') && (/[.:]/.test(registry) || registry === 'localhost'))) image = `docker.io/${image.includes('/') ? '' : 'library/'}${image}`
    if (image) c.push(`Image=${image}`)
    c.push(`ContainerName=${s.container_name ? slug(str(s.container_name)) : svc}`)
    if (image) c.push('AutoUpdate=registry')
    for (const p of ports(s.ports, warn)) c.push(`PublishPort=${p}`)
    if (Array.isArray(s.volumes)) {
      for (const v of s.volumes) {
        if (isObj(v)) {
          const src = str(v.source)
          const target = str(v.target)
          if (!target) continue
          const src2 = v.type === 'volume' && namedVolumes.includes(src) ? `${slug(src)}.volume` : src
          c.push(`Volume=${src2 ? `${src2}:` : ''}${target}${v.read_only ? ':ro' : ''}`)
          continue
        }
        const parts = oneLine(v).split(':')
        if (parts.length >= 2 && namedVolumes.includes(parts[0]!)) parts[0] = `${slug(parts[0]!)}.volume`
        else if (parts.length >= 2 && parts[0]!.startsWith('.')) warn(msg(m.quadlets_compose_relativePath, { path: parts[0] }))
        c.push(`Volume=${parts.join(':')}`)
      }
    }
    for (const e of kvList(s.environment)) c.push(`Environment=${e}`)
    for (const f of Array.isArray(s.env_file) ? s.env_file : s.env_file ? [s.env_file] : []) {
      const p = isObj(f) ? str(f.path) : str(f)
      if (p.startsWith('.')) warn(msg(m.quadlets_compose_relativeEnvFile, { path: p }))
      c.push(`EnvironmentFile=${oneLine(p)}`)
    }
    for (const l of kvList(s.labels)) c.push(`Label=${l}`)
    if (s.command) c.push(`Exec=${quoteArgs(s.command)}`)
    if (s.entrypoint) c.push(`Entrypoint=${Array.isArray(s.entrypoint) ? oneLine(s.entrypoint[0]) : oneLine(s.entrypoint)}`)
    if (s.user) c.push(`User=${oneLine(s.user)}`)
    if (s.working_dir) c.push(`WorkingDir=${oneLine(s.working_dir)}`)
    if (s.hostname) c.push(`HostName=${oneLine(s.hostname)}`)
    if (s.shm_size) c.push(`ShmSize=${oneLine(s.shm_size)}`)
    if (s.mem_limit) c.push(`Memory=${oneLine(s.mem_limit)}`)
    if (s.read_only) c.push('ReadOnly=true')
    if (s.stop_signal) c.push(`StopSignal=${oneLine(s.stop_signal)}`)
    for (const d of Array.isArray(s.devices) ? s.devices : []) c.push(`AddDevice=${oneLine(d)}`)
    for (const d of Array.isArray(s.cap_add) ? s.cap_add : []) c.push(`AddCapability=${oneLine(d)}`)
    for (const d of Array.isArray(s.cap_drop) ? s.cap_drop : []) c.push(`DropCapability=${oneLine(d)}`)
    for (const d of Array.isArray(s.tmpfs) ? s.tmpfs : s.tmpfs ? [s.tmpfs] : []) c.push(`Tmpfs=${oneLine(d)}`)
    for (const d of Array.isArray(s.dns) ? s.dns : s.dns ? [s.dns] : []) c.push(`DNS=${oneLine(d)}`)
    for (const d of kvList(s.sysctls)) c.push(`Sysctl=${d}`)
    for (const h of Array.isArray(s.extra_hosts) ? s.extra_hosts : []) c.push(`PodmanArgs=--add-host=${oneLine(h)}`)
    if (s.privileged) {
      warn(msg(m.quadlets_compose_privileged))
      c.push('PodmanArgs=--privileged')
    }
    if (s.network_mode) {
      const mode = oneLine(s.network_mode)
      if (mode === 'host' || mode === 'none') c.push(`Network=${mode}`)
      else warn(msg(m.quadlets_compose_networkMode, { mode }))
    } else if (Array.isArray(s.networks) || isObj(s.networks)) {
      const nets = Array.isArray(s.networks) ? s.networks.map(str) : Object.keys(s.networks as Obj)
      for (const n of nets) c.push(`Network=${networks.includes(n) ? `${slug(n)}.network` : slug(n)}`)
    } else if (needsDefaultNet) c.push(`Network=${defaultNet}`)
    if (isObj(s.healthcheck) && !s.healthcheck.disable) {
      const test = s.healthcheck.test
      const cmd = Array.isArray(test) ? (test[0] === 'CMD-SHELL' ? oneLine(test.slice(1).join(' ')) : test[0] === 'CMD' ? quoteArgs(test.slice(1)) : quoteArgs(test)) : oneLine(test)
      if (cmd && cmd !== 'NONE') c.push(`HealthCmd=${cmd}`)
      if (s.healthcheck.interval) c.push(`HealthInterval=${oneLine(s.healthcheck.interval)}`)
      if (s.healthcheck.retries) c.push(`HealthRetries=${oneLine(s.healthcheck.retries)}`)
      if (s.healthcheck.timeout) c.push(`HealthTimeout=${oneLine(s.healthcheck.timeout)}`)
      if (s.healthcheck.start_period) c.push(`HealthStartPeriod=${oneLine(s.healthcheck.start_period)}`)
    }
    const deps = Array.isArray(s.depends_on) ? s.depends_on.map(str) : isObj(s.depends_on) ? Object.keys(s.depends_on) : []
    for (const d of deps) {
      unit.push(`Requires=${slug(d)}.service`)
      unit.push(`After=${slug(d)}.service`)
    }
    const restart = oneLine(s.restart)
    service.push(`Restart=${restart === 'no' ? 'no' : restart.startsWith('on-failure') ? 'on-failure' : 'always'}`)
    service.push('TimeoutStartSec=900')
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) warn(msg(m.quadlets_compose_keyNotConverted, { key: k }))
    for (const k of ['secrets', 'logging', 'ulimits', 'security_opt', 'expose']) if (s[k]) warn(msg(m.quadlets_compose_transferManually, { key: k }))

    files.push({
      name: `${svc}.container`,
      content: `[Unit]\n${unit.join('\n')}\n\n[Container]\n${c.join('\n')}\n\n[Service]\n${service.join('\n')}\n\n[Install]\nWantedBy=multi-user.target\n`,
    })
  }
  return { files, warnings }
}
