import { useState } from 'react'
import { describeConfigAction, parseConfigPath, type ConfigAction, type ConfigFileInfo } from '~/shared/configfiles'
import { useActions } from './Actions'
import { useJobs } from './Jobs'
import { Modal } from './Modal'
import { DiffView } from './QuadletEditor'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'
import { rich } from '~/i18n'

/**
 * .pacnew & co. from the last updates: per file the difference to the live
 * one and three ways out – keep mine, take over the new one, merge by hand.
 */
export function ConfigFilesPanel({ files, hint, onChanged }: { files: string[]; hint?: string; onChanged: () => void }) {
  const say = useToast()
  const [open, setOpen] = useState<ConfigFileInfo | null>(null)
  const show = async (path: string) => {
    try {
      const r = await fetch(`/api/system/config?path=${encodeURIComponent(path)}`)
      const d = (await r.json()) as ConfigFileInfo & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setOpen(d)
    } catch (e) {
      say((e as Error).message, 'bad')
      onChanged()
    }
  }
  return (
    <section className="panel flex flex-col" aria-label={m.system_config_label()}>
      <div className="flex flex-wrap items-baseline gap-2 px-[18px] pt-4 pb-2">
        <h2 className="h2">{m.system_config_title()}</h2>
        <Pill tone="warn">{files.length}</Pill>
        <span className="text-[12px] text-muted">{m.system_config_intro()}</span>
      </div>
      {files.map((f) => {
        const p = parseConfigPath(f)
        return (
          <button key={f} type="button" data-testid="config-file" onClick={() => void show(f)} className="flex items-center gap-3 border-t border-line px-[18px] py-[7px] text-left hover:bg-[rgba(255,255,255,.03)]">
            <span className="grow truncate font-mono text-[12px]">{f}</span>
            <span className="chip shrink-0">{p?.kind === 'save' ? m.system_config_backup() : m.system_config_newVersion()}</span>
            <span className="shrink-0 text-[12px] text-accent">{m.system_config_view()}</span>
          </button>
        )
      })}
      {hint && <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">{m.system_config_hint({ cmd: (hint.match(/„[^“]+“|“[^”]+”/)?.[0] ?? 'diff') })}</p>}
      {open && (
        <ConfigDialog
          f={open}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null)
            onChanged()
          }}
        />
      )}
    </section>
  )
}

function ConfigDialog({ f, onClose, onDone }: { f: ConfigFileInfo; onClose: () => void; onDone: () => void }) {
  const { readonly } = useActions()
  const say = useToast()
  const guarded = useGuardedApi()
  const jobs = useJobs()
  const [merge, setMerge] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfigAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const apply = async (action: ConfigAction) => {
    setBusy(true)
    setError('')
    try {
      const r = await guarded<{ done: string; after?: ConfigFileInfo['after']; warning?: string }>('/api/system/config', { body: { path: f.path, action, content: action === 'merge' ? merge : undefined } })
      if (!r) return
      say(r.warning ?? r.done, r.warning ? 'bad' : undefined)
      if (r.after === 'mkinitcpio' && action !== 'keep') void jobs.start({ kind: 'mkinitcpio' })
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  const canChange = !readonly && f.kind === 'new' && !f.noReplace && !f.binary
  return (
    <Modal open onClose={onClose} title={f.live} wide>
      {f.note && <p className="m-0 text-[13px] text-[#c9d1d9]">{f.note}</p>}
      {f.noReplace && (
        <p role="alert" className="m-0 rounded-[10px] border border-[rgba(210,153,34,.5)] bg-[rgba(210,153,34,.08)] p-3 text-[13px] text-[#e3b341]">
          {f.noReplace}
        </p>
      )}
      {f.replaceRisk && (
        <p role="alert" className="m-0 rounded-[10px] border border-[rgba(210,153,34,.5)] bg-[rgba(210,153,34,.08)] p-3 text-[13px] text-[#e3b341]">
          {f.replaceRisk}
        </p>
      )}
      {f.binary && <p className="m-0 text-[13px] text-muted">{m.system_config_binary()}</p>}
      {!f.binary && f.kind === 'new' && merge === null && (
        <>
          <p className="m-0 text-[12px] text-muted">{f.liveExists ? rich(m.system_config_diffIntro, { minus: (<span className="text-[#ff8a80]">−</span>), plus: (<span className="text-[#7ee2a8]">+</span>) }) : m.system_config_noLive({ live: f.live })}</p>
          <DiffView before={f.liveContent ?? ''} after={f.content ?? ''} />
        </>
      )}
      {!f.binary && f.kind === 'save' && (
        <pre className="joblog !min-h-0 max-h-[320px] whitespace-pre-wrap" aria-label={m.system_config_content()}>
          {f.content}
        </pre>
      )}
      {merge !== null && (
        <>
          <p className="m-0 text-[12px] text-muted">{m.system_config_mergeIntro()}</p>
          <DiffView before={f.liveContent ?? ''} after={f.content ?? ''} />
          <textarea className="field h-[260px] font-mono text-[12px]" spellCheck={false} aria-label={m.system_config_merged()} value={merge} onChange={(e) => setMerge(e.target.value)} />
          {f.check && <p className="m-0 text-[12px] text-muted">{m.system_config_check({ cmd: f.check })}</p>}
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      {confirm ? (
        <div className="flex flex-col gap-2 rounded-[10px] border border-edge p-3 text-[13px]">
          <span>{describeConfigAction(f, confirm)}</span>
          {f.after === 'mkinitcpio' && confirm !== 'keep' && <span className="text-muted">{m.system_config_mkinitcpio()}</span>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              {m.common_back()}
            </button>
            <button type="button" className={confirm === 'keep' ? 'btn danger' : 'btn primary'} disabled={busy} onClick={() => void apply(confirm)}>
              {busy ? m.system_config_applying() : m.common_confirm()}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={merge !== null ? () => setMerge(null) : onClose}>
            {merge !== null ? m.common_back() : m.common_close()}
          </button>
          {!readonly && merge === null && (
            <button type="button" className="btn" onClick={() => setConfirm('keep')}>
              {f.kind === 'save' ? m.common_deleteDots() : m.system_config_keepMine()}
            </button>
          )}
          {canChange && merge === null && (
            <>
              <button type="button" className="btn" onClick={() => setMerge(f.liveContent ?? f.content ?? '')}>
                {m.system_config_mergeDots()}
              </button>
              {!f.replaceRisk && (
                <button type="button" className="btn primary" onClick={() => setConfirm('replace')}>
                  {m.system_config_replaceDots()}
                </button>
              )}
            </>
          )}
          {merge !== null && (
            <button type="button" className="btn primary" onClick={() => setConfirm('merge')}>
              {m.system_config_saveDots()}
            </button>
          )}
        </div>
      )}
    </Modal>
  )
}
