import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { PageHeader } from '~/components/PageHeader'
import { Pill, type Tone } from '~/components/Status'
import { bytes } from '~/lib/format'
import { KNOWN_PORTS, type IfaceKind, type ListeningPort, type NetInterface, type NetworkState } from '~/shared/network'

export const Route = createFileRoute('/_app/network')({
  head: () => ({ meta: [{ title: 'Netzwerk · Quadeck' }] }),
  component: NetworkPage,
})

const KIND_LABEL: Record<IfaceKind, string> = { ethernet: 'LAN', wifi: 'WLAN', bridge: 'Bridge', container: 'Container', vpn: 'VPN', loopback: 'Loopback', virtual: 'virtuell' }
const MAIN: IfaceKind[] = ['ethernet', 'wifi', 'vpn', 'bridge']

function NetworkPage() {
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
  useEffect(() => {
    void load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const s = state
  const ifaces = s?.interfaces.filter((i) => allIfaces || MAIN.includes(i.kind)) ?? []
  const hidden = (s?.interfaces.length ?? 0) - (s?.interfaces.filter((i) => MAIN.includes(i.kind)).length ?? 0)
  const ports = (s?.ports ?? []).filter((p) => !onlyExternal || p.scope !== 'local').sort((a, b) => Number(a.scope === 'local') - Number(b.scope === 'local') || a.port - b.port)
  return (
    <>
      <PageHeader title="Netzwerk" subtitle="Schnittstellen, Routen, DNS und offene Ports – nur zum Ansehen" />
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {s?.error && <p className="m-0 text-[13px] text-[#e3b341]">{s.error}</p>}
      {!s && !error && <p className="m-0 text-muted">Wird geladen …</p>}
      {s && (
        <>
          <section className="flex flex-col gap-3" aria-label="Schnittstellen">
            <div className="flex items-center gap-3">
              <h2 className="h2 grow">Schnittstellen</h2>
              {hidden > 0 && (
                <label className="flex items-center gap-2 text-[12px] text-muted">
                  <input type="checkbox" checked={allIfaces} onChange={(e) => setAllIfaces(e.target.checked)} />
                  auch Loopback und Container-Verbindungen ({hidden})
                </label>
              )}
            </div>
            <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2 2xl:grid-cols-3">
              {ifaces.map((i) => (
                <Iface key={i.name} iface={i} gateway={s.routes.find((r) => r.dst === 'default' && r.dev === i.name && r.family === 'inet')?.gateway} />
              ))}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
            <section className="panel relative flex flex-col overflow-x-auto" aria-label="Offene Ports">
              <div className="flex flex-wrap items-center gap-3 px-[18px] pt-[18px] pb-2">
                <h2 className="h2 grow">Offene Ports</h2>
                <label className="flex items-center gap-2 text-[12px] text-muted">
                  <input type="checkbox" checked={onlyExternal} onChange={(e) => setOnlyExternal(e.target.checked)} />
                  nur aus dem Netz erreichbare
                </label>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Port</th>
                    <th>Erreichbar</th>
                    <th>Programm</th>
                    <th>Firewall</th>
                  </tr>
                </thead>
                <tbody>
                  {ports.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-muted">
                        Keine Ports.
                      </td>
                    </tr>
                  )}
                  {ports.map((p) => (
                    <PortRow key={`${p.proto}/${p.port}/${p.process ?? p.container ?? ''}`} p={p} />
                  ))}
                </tbody>
              </table>
            </section>

            <div className="flex flex-col gap-[18px]">
              <Firewall s={s} />
              <section className="panel flex flex-col gap-2 p-[18px] text-[13px]" aria-label="Routen und DNS">
                <h2 className="h2">Routen und DNS</h2>
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                  <dt className="text-muted">Rechnername</dt>
                  <dd className="m-0 font-mono">{s.hostname}</dd>
                  {s.routes
                    .filter((r) => r.dst === 'default')
                    .map((r, i) => (
                      <Pair key={i} k={r.family === 'inet' ? 'Gateway' : 'Gateway (IPv6)'} v={`${r.gateway ?? '–'}${r.dev ? ` über ${r.dev}` : ''}`} />
                    ))}
                  <Pair k="DNS-Server" v={s.dns.servers.join(', ') || '–'} />
                  {s.dns.resolver && <Pair k="Resolver" v={s.dns.resolver} />}
                  {s.dns.search.length > 0 && <Pair k="Suchdomänen" v={s.dns.search.join(', ')} />}
                </dl>
                <details className="text-[12px] text-muted">
                  <summary className="cursor-pointer">Alle Routen ({s.routes.length})</summary>
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
            </div>
          </div>
        </>
      )}
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
        <span className="chip">{KIND_LABEL[i.kind]}</span>
        <span className="grow" />
        <Pill tone={tone}>{up ? 'verbunden' : i.state === 'DOWN' ? 'getrennt' : i.state.toLowerCase()}</Pill>
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
        {!v4.length && !v6.length && <span className="font-sans text-[12px] text-muted">keine Adresse{link6.length ? ' (nur IPv6 link-local)' : ''}</span>}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted">
        {gateway && <span>Gateway {gateway}</span>}
        {i.speedMbps && <span>{i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gbit/s` : `${i.speedMbps} Mbit/s`}</span>}
        {i.master && <span>an {i.master}</span>}
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

const FW: Record<NonNullable<ListeningPort['firewall']>, { tone: Tone; label: string; title: string }> = {
  open: { tone: 'ok', label: 'offen', title: 'Aus dem Netz erreichbar' },
  blocked: { tone: 'warn', label: 'blockiert', title: 'Die Firewall lässt Verbindungen von außen nicht durch' },
  podman: { tone: 'ok', label: 'offen (Podman)', title: 'Podman öffnet veröffentlichte Container-Ports selbst' },
  unknown: { tone: 'idle', label: 'unklar', title: 'Eigene nftables-Regeln' },
}

function PortRow({ p }: { p: ListeningPort }) {
  const known = KNOWN_PORTS[`${p.port}/${p.proto}`]
  const where = p.scope === 'all' ? 'alle Schnittstellen' : p.scope === 'local' ? 'nur dieser Rechner' : `nur ${p.addresses.join(', ')}`
  const fw = p.firewall ? FW[p.firewall] : undefined
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
          {p.container && <span className="chip q">Container {p.container}</span>}
          {!p.process && !p.container && <span className="text-[12px] text-muted">Kernel (z. B. NFS, WireGuard)</span>}
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
    <section className="panel flex flex-col gap-2 p-[18px] text-[13px]" aria-label="Firewall">
      <div className="flex items-center gap-2">
        <h2 className="h2 grow">Firewall</h2>
        <Pill tone={f.active ? 'ok' : 'idle'}>{f.active ? `${f.kind} aktiv` : 'keine aktiv'}</Pill>
      </div>
      {!f.active && (
        <p className="m-0 text-muted">
          Keine Firewall aktiv: alles, was auf „alle Schnittstellen“ lauscht, ist im lokalen Netz erreichbar. Hinter einem Router ist das zu Hause üblich – von außen kommt nur durch, was der Router weiterleitet.
        </p>
      )}
      {f.active && (
        <>
          {f.zone && (
            <div className="text-muted">
              Zone <span className="font-mono text-fg">{f.zone}</span>
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
              {blocked.length === 1 ? 'Ein Port lauscht' : `${blocked.length} Ports lauschen`}, wird aber blockiert: {blocked.map((p) => `${p.port}/${p.proto}`).join(', ')}. Gewollt? Sonst in der Firewall freigeben (z. B.{' '}
              <span className="font-mono">{f.kind === 'ufw' ? `ufw allow ${blocked[0]!.port}/${blocked[0]!.proto}` : `firewall-cmd --permanent --add-port=${blocked[0]!.port}/${blocked[0]!.proto} && firewall-cmd --reload`}</span>).
            </p>
          )}
        </>
      )}
      {f.note && <p className="m-0 text-[12px] text-muted">{f.note}</p>}
    </section>
  )
}
