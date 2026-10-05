import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { applyCaddyChange, NO_OPTIONS, type CaddyBlock, type CaddyChange, type CaddyResult, type CaddyState, type SiteOptions } from '~/shared/caddy'
import { useLive } from '~/lib/live'
import { useActions } from './Actions'
import { BusyButton, useBusy } from './Busy'
import { Modal } from './Modal'
import { DiffView, TextView } from './QuadletEditor'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'
import { dateTime } from '~/lib/format'

type Pending = { change: CaddyChange; after: string; title: string }

/**
 * Reverse proxy tab: the Caddyfile as a list of domains (simple
 * `reverse_proxy` blocks can be edited in a form) plus the whole file as text.
 * Every change shows the diff first; the server checks it with Caddy, writes
 * it and reloads Caddy.
 */
export function ReverseProxy() {
  const { readonly } = useActions()
  const say = useToast()
  const guarded = useGuardedApi()
  const [state, setState] = useState<CaddyState | null>(null)
  const [error, setError] = useState('')
  const [site, setSite] = useState<SiteInit | null>(null)
  const [text, setText] = useState<{ content: string; jump: number | null; note?: string } | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [block, setBlock] = useState<{ address: string; text: string; error?: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const work = useBusy<'auto' | 'pick'>()

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/caddy')
      const d = (await r.json()) as CaddyState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
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
    others.some((b) => b.kind === 'global') && m.proxy_table_global(),
    others.filter((b) => b.kind === 'snippet').length > 0 && m.proxy_table_snippets({ n: (others.filter((b) => b.kind === 'snippet').length) }),
    others.filter((b) => b.kind === 'import').length > 0 && m.proxy_table_imports({ n: (others.filter((b) => b.kind === 'import').length) }),
  ]
    .filter(Boolean)
    .join(', ')
  const editable = state?.content !== undefined && !!state.source && !state.problem && !readonly
  const src = state?.source

  return (
    <section className="flex flex-col gap-[18px]" aria-label={m.proxy_title()}>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">{m.proxy_loading()}</p>}
      {state && (
        <div className="panel flex flex-col gap-3 p-[18px]">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="h2 grow">{m.proxy_title()}</h2>
            <Pill tone={state.running ? 'ok' : 'warn'}>
              {state.reload === 'api' ? m.proxy_status_api() : state.reload === 'container' ? m.proxy_status_container({ c: (src?.container ?? 'caddy') }) : state.reload === 'service' ? m.proxy_status_service() : m.proxy_status_none()}
            </Pill>
          </div>
          <p className="m-0 text-[13px] text-muted">{m.proxy_intro()}</p>
          {src && (
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" data-testid="caddy-source">
              <span className="font-mono">{src.path}</span>
              <span className="text-muted">
                –{' '}
                {src.how === 'quadlet' ? m.proxy_source_quadlet({ quadlet: (src.quadlet ?? ''), containerPath: (src.containerPath ?? '') }) : src.how === 'service' ? m.proxy_source_service() : src.how === 'env' ? m.proxy_source_env() : src.how === 'manual' ? m.proxy_source_manual() : m.proxy_source_default()}
              </span>
              {!readonly && src.how !== 'env' && (
                <button type="button" className="border-0 bg-transparent p-0 text-[12px] text-accent hover:underline" onClick={() => setPick(src.how === 'manual' ? src.path : '')}>
                  {m.proxy_actions_pick()}
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
                    {m.proxy_pick_title()} …
                  </button>
                  {state.manual && (
                    <BusyButton className="btn sm" busy={work.is('auto')} busyLabel={m.common_applying()} disabled={work.busy !== null} onClick={() => void choosePath(null)}>
                      {m.proxy_actions_automatic()}
                    </BusyButton>
                  )}
                </span>
              )}
              {src?.how === 'env' && <span className="text-muted">{m.proxy_pick_envHint()}</span>}
            </div>
          )}
          {editable && (
            <div className="flex flex-wrap gap-2">
              {!state.unstructured && (
                <button type="button" className="btn primary" onClick={() => setSite({ addresses: '', upstreams: '', options: NO_OPTIONS })}>
                  {m.proxy_actions_add()}
                </button>
              )}
              <button type="button" className="btn" onClick={() => setText({ content: state.content ?? '', jump: null })}>
                {m.proxy_actions_text()}
              </button>
              {state.manual && src?.how === 'manual' && (
                <BusyButton className="btn" busy={work.is('auto')} busyLabel={m.common_applying()} disabled={work.busy !== null} onClick={() => void choosePath(null)}>
                  {m.proxy_actions_automatic()}
                </BusyButton>
              )}
            </div>
          )}
        </div>
      )}

      {state?.content !== undefined && !state.problem && (
        <section className="panel relative flex flex-col overflow-x-auto" aria-label={m.proxy_table_domain()}>
          {state.unstructured ? (
            <p className="m-0 p-[18px] text-[13px] text-muted">{m.proxy_table_unstructured()}</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{m.proxy_table_domain()}</th>
                  <th>{m.proxy_table_target()}</th>
                  <th>
                    <span className="sr-only">{m.common_actions()}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sites.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-muted">
                      {m.proxy_table_none()}
                    </td>
                  </tr>
                )}
                {sites.map((b) => (
                  <SiteRow
                    key={`${b.start}-${b.addresses.join(',')}`}
                    b={b}
                    readonly={!editable}
                    onEdit={() => setSite({ previous: b.addresses[0], addresses: b.addresses.join(', '), upstreams: (b.upstreams ?? []).join(' '), options: b.options ?? NO_OPTIONS })}
                    onText={() => setBlock({ address: b.addresses[0]!, text: b.text })}
                    onDelete={() => propose({ kind: 'delete', address: b.addresses[0]! }, m.proxy_confirm_deleteTitle({ address: b.addresses.join(', ') }))}
                  />
                ))}
              </tbody>
            </table>
          )}
          {also && <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">{m.proxy_table_also({ parts: also })}</p>}
          {state.history.length > 0 && (
            <details className="border-t border-line px-[18px] py-2 text-[12px] text-muted">
              <summary className="cursor-pointer">{m.proxy_history_title({ n: state.history.length })}</summary>
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
                {state.history.map((r) => (
                  <li key={r.id} className="flex items-center gap-3">
                    <span className="w-[140px] font-mono">{dateTime(r.date)}</span>
                    <span className="grow">{r.message}</span>
                    {editable && (
                      <button type="button" className="border-0 bg-transparent p-0 text-accent hover:underline" onClick={() => void viewRevision(r.id, r.date)}>
                        {m.proxy_history_view()}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {site && <SiteDialog init={site} onClose={() => setSite(null)} onNext={(change) => propose(change, change.kind === 'site' && change.previous ? m.proxy_site_editTitle({ address: change.previous }) : m.proxy_site_newTitle())} />}
      {text && (
        <Modal open wide title={m.proxy_text_title()} onClose={() => setText(null)}>
          {text.note && <p className="m-0 text-[13px] text-[#e3b341]">{text.note}</p>}
          <TextView text={text.content} onChange={(v) => setText({ ...text, content: v, jump: null })} jump={text.jump} label={m.proxy_text_title()} height={420} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setText(null)}>
              {m.common_cancel()}
            </button>
            <button type="button" className="btn primary" onClick={() => propose({ kind: 'text', content: text.content }, m.proxy_text_title())}>
              {m.proxy_text_next()}
            </button>
          </div>
        </Modal>
      )}
      {block && (
        <Modal open wide title={m.proxy_block_title({ address: block.address })} onClose={() => setBlock(null)}>
          <p className="m-0 text-[13px] text-muted">{m.proxy_block_hint()}</p>
          <TextView text={block.text} onChange={(v) => setBlock({ ...block, text: v, error: undefined })} jump={null} label={m.proxy_block_title({ address: block.address })} height={260} />
          {block.error && (
            <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
              {block.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setBlock(null)}>
              {m.common_cancel()}
            </button>
            <button type="button" className="btn primary" onClick={() => setBlock({ ...block, error: propose({ kind: 'block', address: block.address, text: block.text }, m.proxy_block_title({ address: block.address })) })}>
              {m.proxy_text_next()}
            </button>
          </div>
        </Modal>
      )}
      {pick !== null && <PickDialog init={pick} busy={work.is('pick')} onClose={() => setPick(null)} onPick={(p) => void choosePath(p)} />}
      {pending && state && (
        <ConfirmChange
          pending={pending}
          state={state}
          onClose={() => setPending(null)}
          onDone={(r) => {
            setPending(null)
            setSite(null)
            setText(null)
            setBlock(null)
            setState(r.state)
            say(r.warning ?? pickMsg({ "api": m.proxy_done_api, "container": m.proxy_done_container, "service": m.proxy_done_service, "none": m.proxy_done_none, "path": m.proxy_done_path, "automatic": m.proxy_done_automatic }, r.reloaded), r.warning ? 'bad' : undefined)
          }}
          apply={(change) => guarded<CaddyResult>('/api/caddy', { body: { apply: change, expected: state.hash } })}
        />
      )}
    </section>
  )

  function choosePath(path: string | null) {
    return work.run(path === null ? 'auto' : 'pick', async () => {
      try {
        const r = await guarded<CaddyState>('/api/caddy', { body: { path } })
        if (!r) return
        setState(r)
        setPick(null)
        say(path === null ? m.proxy_done_automatic() : m.proxy_done_path())
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })
  }

  async function viewRevision(id: string, date: number) {
    try {
      const r = await fetch(`/api/caddy?revision=${encodeURIComponent(id)}`)
      const d = (await r.json()) as { content?: string; error?: string }
      if (!r.ok || d.content === undefined) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setText({ content: d.content, jump: null, note: m.proxy_text_revision({ date: dateTime(date) }) })
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
}

function SiteRow({ b, readonly, onEdit, onText, onDelete }: { b: CaddyBlock; readonly: boolean; onEdit: () => void; onText: () => void; onDelete: () => void }) {
  return (
    <tr data-testid="caddy-site">
      <td>
        <div className="flex flex-col">
          {b.addresses.map((a) => (
            <a key={a} href={/^https?:\/\//.test(a) ? a : a.startsWith(':') ? undefined : `https://${a}`} target="_blank" rel="noreferrer" className="font-mono text-[13px] font-medium text-fg hover:text-accent" title={m.proxy_actions_open({ address: a })}>
              {a}
            </a>
          ))}
        </div>
      </td>
      <td className="font-mono text-[12px]">
        {b.kind === 'proxy' ? (
          <div className="flex flex-col gap-1">
            <span>{b.upstreams!.join(' ')}</span>
            {optionChips(b.options).length > 0 && (
              <span className="flex flex-wrap gap-1 font-sans" data-testid="site-options">
                {optionChips(b.options).map((c) => (
                  <span key={c} className="chip">
                    {c}
                  </span>
                ))}
              </span>
            )}
          </div>
        ) : (
          <span className="font-sans text-muted">{m.proxy_table_custom({ line: b.line })}</span>
        )}
      </td>
      <td>
        {!readonly && (
          <div className="flex justify-end gap-1.5">
            {b.kind === 'proxy' ? (
              <button type="button" className="btn sm" aria-label={`${m.proxy_actions_edit()} ${b.addresses[0]}`} onClick={onEdit}>
                {m.proxy_actions_edit()}
              </button>
            ) : (
              <button type="button" className="btn sm" aria-label={`${m.proxy_actions_editText()} ${b.addresses[0]}`} onClick={onText}>
                {m.proxy_actions_editText()}
              </button>
            )}
            <button type="button" className="btn sm danger" aria-label={`${m.proxy_actions_delete()} ${b.addresses[0]}`} onClick={onDelete}>
              {m.proxy_actions_delete()}
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

type SiteInit = { previous?: string; addresses: string; upstreams: string; options: SiteOptions }

function optionChips(o: SiteOptions | undefined): string[] {
  if (!o) return []
  const chips: unknown[] = [
    o.lanOnly && m.proxy_table_lanOnly(),
    o.auth && m.proxy_table_auth(),
    o.compress && m.proxy_table_compress(),
    o.insecureTls && m.proxy_table_insecureTls(),
    o.tlsInternal && m.proxy_table_tlsInternal(),
    (o.extra.trim() || o.proxyExtra.trim()) && m.proxy_table_extra(),
  ]
  return chips.filter((x): x is string => typeof x === 'string' && !!x)
}

function Option({ checked, onChange, label, help, children }: { checked: boolean; onChange: (v: boolean) => void; label: string; help: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-start gap-2.5 text-[13px]">
        <input type="checkbox" className="mt-[3px]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="flex flex-col">
          <span className="font-medium text-fg">{label}</span>
          <span className="text-[12px] text-muted">{help}</span>
        </span>
      </label>
      {checked && children}
    </div>
  )
}

/** One entry: domains, targets and the options; lines the dialog does not know stay in "other lines". */
function SiteDialog({ init, onClose, onNext }: { init: SiteInit; onClose: () => void; onNext: (change: CaddyChange) => string | undefined }) {
  const { snapshot } = useLive()
  const [addresses, setAddresses] = useState(init.addresses)
  const [upstreams, setUpstreams] = useState(init.upstreams)
  const [o, setO] = useState<SiteOptions>(init.options)
  const [user, setUser] = useState(init.options.auth?.user ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const listId = useId()
  const set = (patch: Partial<SiteOptions>) => setO((x) => ({ ...x, ...patch }))
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
  const hadAuth = !!init.options.auth?.hash
  const field = 'flex flex-col gap-1 text-[12px] font-medium text-muted'
  return (
    <Modal open wide title={init.previous ? m.proxy_site_editTitle({ address: init.previous }) : m.proxy_site_newTitle()} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          const auth = o.auth ? { user: user.trim(), ...(password ? { password } : hadAuth && user.trim() ? { hash: init.options.auth!.hash } : {}) } : undefined
          setError(onNext({ kind: 'site', previous: init.previous, addresses: split(addresses, /[\s,]+/), upstreams: split(upstreams, /\s+/), options: { ...o, auth } }) ?? '')
        }}
      >
        <label className={field}>
          {m.proxy_site_domains()}
          <input className="field font-mono" value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder="app.example.com" autoFocus required />
          <span className="font-normal">{m.proxy_site_domainsHint()}</span>
        </label>
        <label className={field}>
          {m.proxy_site_target()}
          <input className="field font-mono" value={upstreams} onChange={(e) => setUpstreams(e.target.value)} placeholder="localhost:8096" list={listId} required />
          <datalist id={listId}>
            {suggestions.map(([v, label]) => (
              <option key={v} value={v} label={label} />
            ))}
          </datalist>
          <span className="font-normal">{m.proxy_site_targetHint()}</span>
        </label>

        <fieldset className="m-0 flex flex-col gap-3 rounded-[10px] border border-edge p-3">
          <legend className="px-1 text-[12px] font-medium text-muted">{m.proxy_site_options()}</legend>
          <Option checked={o.lanOnly} onChange={(v) => set({ lanOnly: v })} label={m.proxy_site_lanOnly()} help={m.proxy_site_lanOnlyHelp()} />
          <Option checked={!!o.auth} onChange={(v) => set({ auth: v ? (init.options.auth ?? { user: '' }) : undefined })} label={m.proxy_site_auth()} help={m.proxy_site_authHelp()}>
            <div className="ml-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className={field}>
                {m.proxy_site_authUser()}
                <input className="field" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
              </label>
              <label className={field}>
                {m.proxy_site_authPassword()}
                <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={hadAuth ? m.proxy_site_authKeep() : ''} />
              </label>
            </div>
          </Option>
          <Option checked={o.compress} onChange={(v) => set({ compress: v })} label={m.proxy_site_compress()} help={m.proxy_site_compressHelp()} />
          <Option checked={o.insecureTls} onChange={(v) => set({ insecureTls: v })} label={m.proxy_site_insecureTls()} help={m.proxy_site_insecureTlsHelp()} />
          <Option checked={o.tlsInternal} onChange={(v) => set({ tlsInternal: v })} label={m.proxy_site_tlsInternal()} help={m.proxy_site_tlsInternalHelp()} />
        </fieldset>

        <details className="text-[13px]" open={!!(init.options.extra || init.options.proxyExtra)}>
          <summary className="cursor-pointer text-[12px] font-medium text-muted">{m.proxy_site_more()}</summary>
          <div className="mt-2 flex flex-col gap-3">
            <label className={field}>
              {m.proxy_site_proxyExtra()}
              <textarea className="field min-h-[60px] font-mono text-[12px]" value={o.proxyExtra} onChange={(e) => set({ proxyExtra: e.target.value })} spellCheck={false} />
              <span className="font-normal">{m.proxy_site_proxyExtraHelp()}</span>
            </label>
            <label className={field}>
              {m.proxy_site_extra()}
              <textarea className="field min-h-[60px] font-mono text-[12px]" value={o.extra} onChange={(e) => set({ extra: e.target.value })} spellCheck={false} />
              <span className="font-normal">{m.proxy_site_extraHelp()}</span>
            </label>
          </div>
        </details>

        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary">
            {m.proxy_site_next()}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PickDialog({ init, busy, onClose, onPick }: { init: string; busy: boolean; onClose: () => void; onPick: (path: string) => void }) {
  const [path, setPath] = useState(init)
  return (
    <Modal open title={m.proxy_pick_title()} onClose={onClose} busy={busy}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (busy) return
          onPick(path.trim())
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.proxy_pick_label()}
          <input className="field font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/etc/caddy/Caddyfile" autoFocus required />
          <span className="font-normal">{m.proxy_pick_hint()}</span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {m.common_cancel()}
          </button>
          <BusyButton type="submit" className="btn primary" busy={busy} busyLabel={m.common_applying()}>
            {m.proxy_pick_apply()}
          </BusyButton>
        </div>
      </form>
    </Modal>
  )
}

function ConfirmChange({ pending, state, onClose, onDone, apply }: { pending: Pending; state: CaddyState; onClose: () => void; onDone: (r: CaddyResult) => void; apply: (change: CaddyChange) => Promise<CaddyResult | undefined> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Modal open wide title={pending.title} onClose={onClose}>
      <DiffView before={state.content ?? ''} after={pending.after} />
      <p className="m-0 text-[13px] text-muted">{m.proxy_confirm_steps({ path: (state.source?.path ?? '') })}</p>
      {!state.running && <p className="m-0 text-[13px] text-[#e3b341]">{m.proxy_confirm_stopped()}</p>}
      {error && (
        <p role="alert" className="m-0 whitespace-pre-wrap text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_back()}
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
          {busy ? m.proxy_confirm_saving() : m.proxy_confirm_save()}
        </button>
      </div>
    </Modal>
  )
}
