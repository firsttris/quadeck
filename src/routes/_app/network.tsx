import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { PageHeader } from '~/components/PageHeader'
import { SpeedTest } from '~/components/SpeedTest'
import { ReverseProxy } from '~/components/ReverseProxy'
import { Devices } from '~/components/Devices'
import { Pill, type Tone } from '~/components/Status'
import { bytes } from '~/lib/format'
import { msg } from '~/shared/i18n'
import { knownPorts, type IfaceKind, type ListeningPort, type NetInterface, type NetworkState } from '~/shared/network'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'
import { usePolling } from '~/lib/polling'

type Tab = 'interfaces' | 'devices' | 'ports' | 'firewall' | 'proxy' | 'speed'

export const Route = createFileRoute('/_app/network')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({ tab: s.tab === 'devices' || s.tab === 'ports' || s.tab === 'firewall' || s.tab === 'proxy' || s.tab === 'speed' ? s.tab : undefined }),
  head: () => ({ meta: [{ title: msg(m.page_title_network) }] }),
  component: NetworkPage,
})

const MAIN: IfaceKind[] = ['ethernet', 'wifi', 'vpn', 'thread', 'bridge']

function NetworkPage() {
  const { tab = 'interfaces' } = Route.useSearch()
  const [state, setState] = useState<NetworkState | null>(null)
  const [error, setError] = useState('')
  const [allIfaces, setAllIfaces] = useState(false)
  const [onlyExternal, setOnlyExternal] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/network')
      const d = (await r.json()) as NetworkState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  usePolling(load, 30_000)

  const s = state
  const ifaces = s?.interfaces.filter((i) => allIfaces || MAIN.includes(i.kind)) ?? []
  const hidden = (s?.interfaces.length ?? 0) - (s?.interfaces.filter((i) => MAIN.includes(i.kind)).length ?? 0)
  const ports = (s?.ports ?? []).filter((p) => !onlyExternal || p.scope !== 'local').sort((a, b) => Number(a.scope === 'local') - Number(b.scope === 'local') || a.port - b.port)
  const tabs: [Tab, string, number | undefined][] = [
    ['interfaces', m.network_tabs_interfaces(), undefined],
    ['devices', m.network_tabs_devices(), undefined],
    ['ports', m.network_tabs_ports(), s?.ports.length],
    ['firewall', m.network_tabs_firewall(), undefined],
    ['proxy', m.network_tabs_proxy(), undefined],
    ['speed', m.network_tabs_speed(), undefined],
  ]
  return (
    <>
      <PageHeader title={m.network_title()} subtitle={m.network_subtitle()} />
      <div role="tablist" aria-label={m.network_area()} className="flex flex-wrap gap-1.5">
        {tabs.map(([k, label, n]) => (
          <Link key={k} to="/network" search={k === 'interfaces' ? {} : { tab: k }} role="tab" aria-selected={tab === k} className={`seg ${tab === k ? 'on' : ''}`}>
            {label}
            {n !== undefined && <span className="opacity-60">{n}</span>}
          </Link>
        ))}
      </div>
      {tab === 'proxy' && <ReverseProxy />}
      {tab === 'speed' && <SpeedTest />}
      {tab === 'devices' && <Devices />}
      {tab !== 'proxy' && tab !== 'speed' && tab !== 'devices' && error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {tab !== 'proxy' && tab !== 'speed' && tab !== 'devices' && s?.error && <p className="m-0 text-[13px] text-[#e3b341]">{s.error}</p>}
      {tab !== 'proxy' && tab !== 'speed' && tab !== 'devices' && !s && !error && <p className="m-0 text-muted">{m.network_loading()}</p>}
      {s && tab === 'interfaces' && (
        <>
          <section className="flex flex-col gap-3" aria-label={m.network_tabs_interfaces()}>
            {hidden > 0 && (
              <label className="flex items-center gap-2 self-end text-[12px] text-muted">
                <input type="checkbox" checked={allIfaces} onChange={(e) => setAllIfaces(e.target.checked)} />
                {m.network_ifaces_showAll({ n: hidden })}
              </label>
            )}
            <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2 2xl:grid-cols-3">
              {ifaces.map((i) => (
                <Iface key={i.name} iface={i} gateway={s.routes.find((r) => r.dst === 'default' && r.dev === i.name && r.family === 'inet')?.gateway} />
              ))}
            </div>
          </section>

          <section className="panel flex flex-col gap-2 p-[18px] text-[13px] xl:max-w-[50%]" aria-label={m.network_routes_title()}>
            <h2 className="h2">{m.network_routes_title()}</h2>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <dt className="text-muted">{m.network_routes_hostname()}</dt>
              <dd className="m-0 font-mono">{s.hostname}</dd>
              {s.routes
                .filter((r) => r.dst === 'default')
                .map((r, i) => (
                  <Pair key={i} k={r.family === 'inet' ? m.network_routes_gateway() : m.network_routes_gateway6()} v={`${r.gateway ?? '–'}${r.dev ? m.network_routes_via({ dev: r.dev }) : ''}`} />
                ))}
              <Pair k={m.network_routes_dns()} v={s.dns.servers.join(', ') || '–'} />
              {s.dns.resolver && <Pair k={m.network_routes_resolver()} v={s.dns.resolver} />}
              {s.dns.search.length > 0 && <Pair k={m.network_routes_search()} v={s.dns.search.join(', ')} />}
            </dl>
            <details className="text-[12px] text-muted">
              <summary className="cursor-pointer">{m.network_routes_all({ n: s.routes.length })}</summary>
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0 font-mono">
                {s.routes.map((r, i) => (
                  <li key={i}>
                    {r.dst}
                    {r.gateway ? ` via ${r.gateway}` : ''}
                    {r.dev ? ` dev ${r.dev}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        </>
      )}
      {s && tab === 'ports' && (
        <section className="panel relative flex flex-col overflow-x-auto" aria-label={m.network_ports_title()}>
          <div className="flex flex-wrap items-center gap-3 px-[18px] pt-[18px] pb-2">
            <h2 className="h2 grow">{m.network_ports_title()}</h2>
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <input type="checkbox" checked={onlyExternal} onChange={(e) => setOnlyExternal(e.target.checked)} />
              {m.network_ports_onlyExternal()}
            </label>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>{m.network_ports_port()}</th>
                <th>{m.network_ports_reachable()}</th>
                <th>{m.network_ports_program()}</th>
                <th>{m.network_ports_firewall()}</th>
              </tr>
            </thead>
            <tbody>
              {ports.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-muted">
                    {m.network_ports_none()}
                  </td>
                </tr>
              )}
              {ports.map((p) => (
                <PortRow key={`${p.proto}/${p.port}/${p.process ?? p.container ?? ''}`} p={p} />
              ))}
            </tbody>
          </table>
        </section>
      )}
      {s && tab === 'firewall' && <Firewall s={s} />}
    </>
  )
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="m-0 font-mono break-all">{v}</dd>
    </>
  )
}

function Iface({ iface: i, gateway }: { iface: NetInterface; gateway?: string }) {
  // VPN and some virtual links report UNKNOWN even when they carry traffic.
  const up = i.state === 'UP' || (i.state === 'UNKNOWN' && i.addresses.some((a) => a.scope !== 'link'))
  const tone: Tone = up ? 'ok' : 'idle'
  const v4 = i.addresses.filter((a) => a.family === 'inet')
  const v6 = i.addresses.filter((a) => a.family === 'inet6' && a.scope !== 'link')
  const link6 = i.addresses.filter((a) => a.family === 'inet6' && a.scope === 'link')
  return (
    <div className="panel flex flex-col gap-2 p-[16px]" data-testid="iface">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[14px] font-semibold">{i.name}</span>
        <span className="chip">
          {pickMsg(
            { ethernet: m.network_kind_ethernet, wifi: m.network_kind_wifi, bridge: m.network_kind_bridge, container: m.network_kind_container, vpn: m.network_kind_vpn, thread: m.network_kind_thread, loopback: m.network_kind_loopback, virtual: m.network_kind_virtual },
            i.kind,
          )}
        </span>
        <span className="grow" />
        <Pill tone={tone}>{up ? m.network_ifaces_connected() : i.state === 'DOWN' ? m.network_ifaces_disconnected() : i.state.toLowerCase()}</Pill>
      </div>
      <div className="flex flex-col gap-0.5 font-mono text-[13px]">
        {v4.map((a) => (
          <span key={a.address}>
            {a.address}/{a.prefix}
            {a.dynamic && <span className="ml-2 font-sans text-[11px] text-subtle">DHCP</span>}
          </span>
        ))}
        {v6.map((a) => (
          <span key={a.address} className="text-[12px] text-subtle">
            {a.address}/{a.prefix}
          </span>
        ))}
        {!v4.length && !v6.length && (
          <span className="font-sans text-[12px] text-muted">
            {m.network_ifaces_noAddress()}
            {link6.length ? m.network_ifaces_linkLocalOnly() : ''}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted">
        {gateway && <span>{m.network_ifaces_gateway({ gw: gateway })}</span>}
        {i.speedMbps && <span>{i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gbit/s` : `${i.speedMbps} Mbit/s`}</span>}
        {i.master && <span>{m.network_ifaces_member({ master: i.master })}</span>}
        {i.mac && <span className="font-mono">{i.mac}</span>}
        <span>MTU {i.mtu}</span>
        {i.rxBytes !== undefined && (
          <span>
            ↓ {bytes(i.rxBytes)} · ↑ {bytes(i.txBytes)}
          </span>
        )}
      </div>
    </div>
  )
}

const FW_TONE: Record<NonNullable<ListeningPort['firewall']>, Tone> = { open: 'ok', blocked: 'warn', podman: 'ok', unknown: 'idle' }

function PortRow({ p }: { p: ListeningPort }) {
  const known = knownPorts()[`${p.port}/${p.proto}`]
  const where = p.scope === 'all' ? m.network_ports_all() : p.scope === 'local' ? m.network_ports_local() : m.network_ports_only({ addrs: p.addresses.join(', ') })
  const fw = p.firewall
    ? {
        tone: FW_TONE[p.firewall],
        label: pickMsg({ open: m.network_fw_open_label, blocked: m.network_fw_blocked_label, podman: m.network_fw_podman_label, unknown: m.network_fw_unknown_label }, p.firewall),
        title: pickMsg({ open: m.network_fw_open_title, blocked: m.network_fw_blocked_title, podman: m.network_fw_podman_title, unknown: m.network_fw_unknown_title }, p.firewall),
      }
    : undefined
  return (
    <tr data-testid="port-row">
      <td className="whitespace-nowrap">
        <span className="font-mono text-[13px] font-medium">{p.port}</span>
        <span className="ml-1.5 text-[11px] text-subtle uppercase">{p.proto}</span>
        {known && <div className="text-[11px] text-muted">{known}</div>}
      </td>
      <td className={p.scope === 'local' ? 'text-muted' : ''}>
        <span title={p.addresses.join(', ')}>{where}</span>
      </td>
      <td className="max-w-[320px]">
        <div className="flex flex-wrap items-center gap-1.5">
          {p.process && <span className="font-mono text-[13px]">{p.process}</span>}
          {p.container && <span className="chip q">{m.network_ports_container({ name: p.container })}</span>}
          {!p.process && !p.container && <span className="text-[12px] text-muted">{m.network_ports_kernel()}</span>}
        </div>
        {p.unit && (
          <Link to="/systemd" search={{ unit: p.unit }} className="font-mono text-[11px] text-subtle hover:underline">
            {p.unit}
          </Link>
        )}
      </td>
      <td>
        {fw ? (
          <span title={fw.title}>
            <Pill tone={fw.tone}>{fw.label}</Pill>
          </span>
        ) : (
          <span className="text-muted">–</span>
        )}
      </td>
    </tr>
  )
}

function Firewall({ s }: { s: NetworkState }) {
  const f = s.firewall
  const blocked = s.ports.filter((p) => p.firewall === 'blocked')
  return (
    <section className="panel flex flex-col gap-2 p-[18px] text-[13px]" aria-label={m.network_firewall_title()}>
      <div className="flex items-center gap-2">
        <h2 className="h2 grow">{m.network_firewall_title()}</h2>
        <Pill tone={f.active ? 'ok' : 'idle'}>{f.active ? m.network_firewall_active({ kind: f.kind }) : m.network_firewall_noneActive()}</Pill>
      </div>
      {!f.active && <p className="m-0 text-muted">{m.network_firewall_noFirewall()}</p>}
      {f.active && (
        <>
          {f.zone && (
            <div className="text-muted">
              {m.network_firewall_zone()} <span className="font-mono text-fg">{f.zone}</span>
            </div>
          )}
          {f.services.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {f.services.map((x) => (
                <span key={x} className="chip">
                  {x}
                </span>
              ))}
            </div>
          )}
          {f.ports.length > 0 && <div className="font-mono text-[12px] text-subtle">{f.ports.join(' ')}</div>}
          {blocked.length > 0 && (
            <p className="m-0 text-[#e3b341]">
              {m.network_firewall_listening({ n: blocked.length })}
              {m.network_firewall_blocked({ ports: blocked.map((p) => `${p.port}/${p.proto}`).join(', ') })}{' '}
              <span className="font-mono">{f.kind === 'ufw' ? `ufw allow ${blocked[0]!.port}/${blocked[0]!.proto}` : `firewall-cmd --permanent --add-port=${blocked[0]!.port}/${blocked[0]!.proto} && firewall-cmd --reload`}</span>).
            </p>
          )}
        </>
      )}
      {f.note && <p className="m-0 text-[12px] text-muted">{f.note}</p>}
    </section>
  )
}
