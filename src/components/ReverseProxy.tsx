import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useT } from '~/i18n'
import { localeOf } from '~/shared/i18n'
import { applyCaddyChange, type CaddyBlock, type CaddyChange, type CaddyResult, type CaddyState } from '~/shared/caddy'
import { useLive } from '~/lib/live'
import { useActions } from './Actions'
import { Modal } from './Modal'
import { DiffView, TextView } from './QuadletEditor'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

type Pending = { change: CaddyChange; after: string; title: string }

const dateFmt = (ts: number) => new Date(ts).toLocaleString(localeOf(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Reverse proxy tab: the Caddyfile as a list of domains (simple
 * `reverse_proxy` blocks can be edited in a form) plus the whole file as text.
 * Every change shows the diff first; the server checks it with Caddy, writes
 * it and reloads Caddy.
 */
export function ReverseProxy() {
  const t = useT().proxy
  const c = useT().common
  const { readonly } = useActions()
  const say = useToast()
  const guarded = useGuardedApi()
  const [state, setState] = useState<CaddyState | null>(null)
  const [error, setError] = useState('')
  const [site, setSite] = useState<{ previous?: string; addresses: string; upstreams: string } | null>(null)
  const [text, setText] = useState<{ content: string; jump: number | null; note?: string } | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/caddy')
      const d = (await r.json()) as CaddyState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? c.http(r.status))
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [c])
  useEffect(() => {
    void load()
  }, [load])

  /** Builds the new file in the browser (same code as the server) and asks for confirmation. */
  const propose = (change: CaddyChange, title: string): string | undefined => {
    try {
      setPending({ change, after: applyCaddyChange(state?.content ?? '', change), title })
      return undefined
    } catch (e) {
      return (e as Error).message
    }
  }

  const sites = state?.blocks.filter((b) => b.kind === 'proxy' || b.kind === 'site') ?? []
  const others = state?.blocks.filter((b) => b.kind !== 'proxy' && b.kind !== 'site') ?? []
  const also = [
    others.some((b) => b.kind === 'global') && t.table.global,
    others.filter((b) => b.kind === 'snippet').length > 0 && t.table.snippets(others.filter((b) => b.kind === 'snippet').length),
    others.filter((b) => b.kind === 'import').length > 0 && t.table.imports(others.filter((b) => b.kind === 'import').length),
  ]
    .filter(Boolean)
    .join(', ')
  const editable = state?.content !== undefined && !!state.source && !state.problem && !readonly
  const src = state?.source

  return (
    <section className="flex flex-col gap-[18px]" aria-label={t.title}>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">{t.loading}</p>}
      {state && (
        <div className="panel flex flex-col gap-3 p-[18px]">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="h2 grow">{t.title}</h2>
            <Pill tone={state.running ? 'ok' : 'warn'}>
              {state.reload === 'api' ? t.status.api : state.reload === 'container' ? t.status.container(src?.container ?? 'caddy') : state.reload === 'service' ? t.status.service : t.status.none}
            </Pill>
          </div>
          <p className="m-0 text-[13px] text-muted">{t.intro}</p>
          {src && (
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" data-testid="caddy-source">
              <span className="font-mono">{src.path}</span>
              <span className="text-muted">
                –{' '}
                {src.how === 'quadlet' ? t.source.quadlet(src.quadlet ?? '', src.containerPath ?? '') : src.how === 'service' ? t.source.service : src.how === 'env' ? t.source.env : src.how === 'manual' ? t.source.manual : t.source.default}
              </span>
              {!readonly && src.how !== 'env' && (
                <button type="button" className="border-0 bg-transparent p-0 text-[12px] text-accent hover:underline" onClick={() => setPick(src.how === 'manual' ? src.path : '')}>
                  {t.actions.pick}
                </button>
              )}
            </p>
          )}
          {state.problem && (
            <div role="alert" className="flex flex-col gap-2 rounded-[10px] border border-[rgba(210,153,34,.5)] bg-[rgba(210,153,34,.08)] p-3 text-[13px] text-[#e3b341]">
              <span>{state.problem}</span>
              {!readonly && src?.how !== 'env' && (
                <span className="flex flex-wrap gap-2">
                  <button type="button" className="btn sm" onClick={() => setPick(state.manual ?? '')}>
                    {t.pick.title} …
                  </button>
                  {state.manual && (
                    <button type="button" className="btn sm" onClick={() => void choosePath(null)}>
                      {t.actions.automatic}
                    </button>
                  )}
                </span>
              )}
              {src?.how === 'env' && <span className="text-muted">{t.pick.envHint}</span>}
            </div>
          )}
          {editable && (
            <div className="flex flex-wrap gap-2">
              {!state.unstructured && (
                <button type="button" className="btn primary" onClick={() => setSite({ addresses: '', upstreams: '' })}>
                  {t.actions.add}
                </button>
              )}
              <button type="button" className="btn" onClick={() => setText({ content: state.content ?? '', jump: null })}>
                {t.actions.text}
              </button>
              {state.manual && src?.how === 'manual' && (
                <button type="button" className="btn" onClick={() => void choosePath(null)}>
                  {t.actions.automatic}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {state?.content !== undefined && !state.problem && (
        <section className="panel relative flex flex-col overflow-x-auto" aria-label={t.table.domain}>
          {state.unstructured ? (
            <p className="m-0 p-[18px] text-[13px] text-muted">{t.table.unstructured}</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t.table.domain}</th>
                  <th>{t.table.target}</th>
                  <th>
                    <span className="sr-only">{c.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sites.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-muted">
                      {t.table.none}
                    </td>
                  </tr>
                )}
                {sites.map((b) => (
                  <SiteRow
                    key={`${b.start}-${b.addresses.join(',')}`}
                    b={b}
                    readonly={!editable}
                    onEdit={() => setSite({ previous: b.addresses[0], addresses: b.addresses.join(', '), upstreams: (b.upstreams ?? []).join(' ') })}
                    onText={() => setText({ content: state.content ?? '', jump: b.line })}
                    onDelete={() => propose({ kind: 'delete', address: b.addresses[0]! }, t.confirm.deleteTitle(b.addresses.join(', ')))}
                  />
                ))}
              </tbody>
            </table>
          )}
          {also && <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">{t.table.also(also)}</p>}
          {state.history.length > 0 && (
            <details className="border-t border-line px-[18px] py-2 text-[12px] text-muted">
              <summary className="cursor-pointer">{t.history.title(state.history.length)}</summary>
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
                {state.history.map((r) => (
                  <li key={r.id} className="flex items-center gap-3">
                    <span className="w-[140px] font-mono">{dateFmt(r.date)}</span>
                    <span className="grow">{r.message}</span>
                    {editable && (
                      <button type="button" className="border-0 bg-transparent p-0 text-accent hover:underline" onClick={() => void viewRevision(r.id, r.date)}>
                        {t.history.view}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {site && <SiteDialog init={site} onClose={() => setSite(null)} onNext={(change) => propose(change, change.kind === 'site' && change.previous ? t.site.editTitle(change.previous) : t.site.newTitle)} />}
      {text && (
        <Modal open wide title={t.text.title} onClose={() => setText(null)}>
          {text.note && <p className="m-0 text-[13px] text-[#e3b341]">{text.note}</p>}
          <TextView text={text.content} onChange={(v) => setText({ ...text, content: v, jump: null })} jump={text.jump} label={t.text.title} height={420} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setText(null)}>
              {c.cancel}
            </button>
            <button type="button" className="btn primary" onClick={() => propose({ kind: 'text', content: text.content }, t.text.title)}>
              {t.text.next}
            </button>
          </div>
        </Modal>
      )}
      {pick !== null && <PickDialog init={pick} onClose={() => setPick(null)} onPick={(p) => void choosePath(p)} />}
      {pending && state && (
        <ConfirmChange
          pending={pending}
          state={state}
          onClose={() => setPending(null)}
          onDone={(r) => {
            setPending(null)
            setSite(null)
            setText(null)
            setState(r.state)
            say(r.warning ?? t.done[r.reloaded], r.warning ? 'bad' : undefined)
          }}
          apply={(change) => guarded<CaddyResult>('/api/caddy', { body: { apply: change, expected: state.hash } })}
        />
      )}
    </section>
  )

  async function choosePath(path: string | null) {
    try {
      const r = await guarded<CaddyState>('/api/caddy', { body: { path } })
      if (!r) return
      setState(r)
      setPick(null)
      say(path === null ? t.done.automatic : t.done.path)
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  async function viewRevision(id: string, date: number) {
    try {
      const r = await fetch(`/api/caddy?revision=${encodeURIComponent(id)}`)
      const d = (await r.json()) as { content?: string; error?: string }
      if (!r.ok || d.content === undefined) throw new Error(d.error ?? c.http(r.status))
      setText({ content: d.content, jump: null, note: t.text.revision(dateFmt(date)) })
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
}

function SiteRow({ b, readonly, onEdit, onText, onDelete }: { b: CaddyBlock; readonly: boolean; onEdit: () => void; onText: () => void; onDelete: () => void }) {
  const t = useT().proxy
  return (
    <tr data-testid="caddy-site">
      <td>
        <div className="flex flex-col">
          {b.addresses.map((a) => (
            <a key={a} href={/^https?:\/\//.test(a) ? a : a.startsWith(':') ? undefined : `https://${a}`} target="_blank" rel="noreferrer" className="font-mono text-[13px] font-medium text-fg hover:text-accent" title={t.actions.open(a)}>
              {a}
            </a>
          ))}
        </div>
      </td>
      <td className="font-mono text-[12px]">{b.kind === 'proxy' ? b.upstreams!.join(' ') : <span className="font-sans text-muted">{t.table.custom(b.line)}</span>}</td>
      <td>
        {!readonly && (
          <div className="flex justify-end gap-1.5">
            {b.kind === 'proxy' ? (
              <button type="button" className="btn sm" aria-label={`${t.actions.edit} ${b.addresses[0]}`} onClick={onEdit}>
                {t.actions.edit}
              </button>
            ) : (
              <button type="button" className="btn sm" aria-label={`${t.actions.editText} ${b.addresses[0]}`} onClick={onText}>
                {t.actions.editText}
              </button>
            )}
            <button type="button" className="btn sm danger" aria-label={`${t.actions.delete} ${b.addresses[0]}`} onClick={onDelete}>
              {t.actions.delete}
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

function SiteDialog({ init, onClose, onNext }: { init: { previous?: string; addresses: string; upstreams: string }; onClose: () => void; onNext: (change: CaddyChange) => string | undefined }) {
  const t = useT().proxy
  const c = useT().common
  const { snapshot } = useLive()
  const [addresses, setAddresses] = useState(init.addresses)
  const [upstreams, setUpstreams] = useState(init.upstreams)
  const [error, setError] = useState('')
  const listId = useId()
  // Containers with a published port: reachable from Caddy as localhost:<port>.
  const suggestions = useMemo(() => {
    const out = new Map<string, string>()
    for (const k of snapshot.containers) for (const p of k.ports) if (p.protocol === 'tcp' && p.hostPort) out.set(`localhost:${p.hostPort}`, `${k.name} (${p.containerPort})`)
    return [...out]
  }, [snapshot.containers])
  const split = (s: string, sep: RegExp) =>
    s
      .split(sep)
      .map((x) => x.trim())
      .filter(Boolean)
  return (
    <Modal open title={init.previous ? t.site.editTitle(init.previous) : t.site.newTitle} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          setError(onNext({ kind: 'site', previous: init.previous, addresses: split(addresses, /[\s,]+/), upstreams: split(upstreams, /\s+/) }) ?? '')
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {t.site.domains}
          <input className="field font-mono" value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder="app.example.com" autoFocus required />
          <span className="font-normal">{t.site.domainsHint}</span>
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {t.site.target}
          <input className="field font-mono" value={upstreams} onChange={(e) => setUpstreams(e.target.value)} placeholder="localhost:8096" list={listId} required />
          <datalist id={listId}>
            {suggestions.map(([v, label]) => (
              <option key={v} value={v} label={label} />
            ))}
          </datalist>
          <span className="font-normal">{t.site.targetHint}</span>
        </label>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {c.cancel}
          </button>
          <button type="submit" className="btn primary">
            {t.site.next}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PickDialog({ init, onClose, onPick }: { init: string; onClose: () => void; onPick: (path: string) => void }) {
  const t = useT().proxy
  const c = useT().common
  const [path, setPath] = useState(init)
  return (
    <Modal open title={t.pick.title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          onPick(path.trim())
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {t.pick.label}
          <input className="field font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/etc/caddy/Caddyfile" autoFocus required />
          <span className="font-normal">{t.pick.hint}</span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {c.cancel}
          </button>
          <button type="submit" className="btn primary">
            {t.pick.apply}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ConfirmChange({ pending, state, onClose, onDone, apply }: { pending: Pending; state: CaddyState; onClose: () => void; onDone: (r: CaddyResult) => void; apply: (change: CaddyChange) => Promise<CaddyResult | undefined> }) {
  const t = useT().proxy
  const c = useT().common
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Modal open wide title={pending.title} onClose={onClose}>
      <DiffView before={state.content ?? ''} after={pending.after} />
      <p className="m-0 text-[13px] text-muted">{t.confirm.steps(state.source?.path ?? '')}</p>
      {!state.running && <p className="m-0 text-[13px] text-[#e3b341]">{t.confirm.stopped}</p>}
      {error && (
        <p role="alert" className="m-0 whitespace-pre-wrap text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {c.back}
        </button>
        <button
          type="button"
          className={pending.change.kind === 'delete' ? 'btn danger' : 'btn primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError('')
            try {
              const r = await apply(pending.change)
              if (r) onDone(r)
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? t.confirm.saving : t.confirm.save}
        </button>
      </div>
    </Modal>
  )
}
