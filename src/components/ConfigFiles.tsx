import { useState } from 'react'
import { useT } from '~/i18n'
import { describeConfigAction, parseConfigPath, type ConfigAction, type ConfigFileInfo } from '~/shared/configfiles'
import { useActions } from './Actions'
import { useJobs } from './Jobs'
import { Modal } from './Modal'
import { DiffView } from './QuadletEditor'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

/**
 * .pacnew & co. from the last updates: per file the difference to the live
 * one and three ways out – keep mine, take over the new one, merge by hand.
 */
export function ConfigFilesPanel({ files, hint, onChanged }: { files: string[]; hint?: string; onChanged: () => void }) {
  const say = useToast()
  const t = useT()
  const c = t.system.config
  const [open, setOpen] = useState<ConfigFileInfo | null>(null)
  const show = async (path: string) => {
    try {
      const r = await fetch(`/api/system/config?path=${encodeURIComponent(path)}`)
      const d = (await r.json()) as ConfigFileInfo & { error?: string }
      if (!r.ok) throw new Error(d.error ?? t.common.http(r.status))
      setOpen(d)
    } catch (e) {
      say((e as Error).message, 'bad')
      onChanged()
    }
  }
  return (
    <section className="panel flex flex-col" aria-label={c.label}>
      <div className="flex flex-wrap items-baseline gap-2 px-[18px] pt-4 pb-2">
        <h2 className="h2">{c.title}</h2>
        <Pill tone="warn">{files.length}</Pill>
        <span className="text-[12px] text-muted">{c.intro}</span>
      </div>
      {files.map((f) => {
        const p = parseConfigPath(f)
        return (
          <button key={f} type="button" data-testid="config-file" onClick={() => void show(f)} className="flex items-center gap-3 border-t border-line px-[18px] py-[7px] text-left hover:bg-[rgba(255,255,255,.03)]">
            <span className="grow truncate font-mono text-[12px]">{f}</span>
            <span className="chip shrink-0">{p?.kind === 'save' ? c.backup : c.newVersion}</span>
            <span className="shrink-0 text-[12px] text-accent">{c.view}</span>
          </button>
        )
      })}
      {hint && <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">{c.hint(hint.match(/„[^“]+“|“[^”]+”/)?.[0] ?? 'diff')}</p>}
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
  const t = useT()
  const c = t.system.config
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
      {f.binary && <p className="m-0 text-[13px] text-muted">{c.binary}</p>}
      {!f.binary && f.kind === 'new' && merge === null && (
        <>
          <p className="m-0 text-[12px] text-muted">
            {f.liveExists ? (
              c.diffIntro(<span className="text-[#ff8a80]">−</span>, <span className="text-[#7ee2a8]">+</span>)
            ) : (
              c.noLive(f.live)
            )}
          </p>
          <DiffView before={f.liveContent ?? ''} after={f.content ?? ''} />
        </>
      )}
      {!f.binary && f.kind === 'save' && (
        <pre className="joblog !min-h-0 max-h-[320px] whitespace-pre-wrap" aria-label={c.content}>
          {f.content}
        </pre>
      )}
      {merge !== null && (
        <>
          <p className="m-0 text-[12px] text-muted">{c.mergeIntro}</p>
          <DiffView before={f.liveContent ?? ''} after={f.content ?? ''} />
          <textarea className="field h-[260px] font-mono text-[12px]" spellCheck={false} aria-label={c.merged} value={merge} onChange={(e) => setMerge(e.target.value)} />
          {f.check && <p className="m-0 text-[12px] text-muted">{c.check(f.check)}</p>}
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
          {f.after === 'mkinitcpio' && confirm !== 'keep' && <span className="text-muted">{c.mkinitcpio}</span>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              {t.common.back}
            </button>
            <button type="button" className={confirm === 'keep' ? 'btn danger' : 'btn primary'} disabled={busy} onClick={() => void apply(confirm)}>
              {busy ? c.applying : t.common.confirm}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={merge !== null ? () => setMerge(null) : onClose}>
            {merge !== null ? t.common.back : t.common.close}
          </button>
          {!readonly && merge === null && (
            <button type="button" className="btn" onClick={() => setConfirm('keep')}>
              {f.kind === 'save' ? t.common.deleteDots : c.keepMine}
            </button>
          )}
          {canChange && merge === null && (
            <>
              <button type="button" className="btn" onClick={() => setMerge(f.liveContent ?? f.content ?? '')}>
                {c.mergeDots}
              </button>
              {!f.replaceRisk && (
                <button type="button" className="btn primary" onClick={() => setConfirm('replace')}>
                  {c.replaceDots}
                </button>
              )}
            </>
          )}
          {merge !== null && (
            <button type="button" className="btn primary" onClick={() => setConfirm('merge')}>
              {c.saveDots}
            </button>
          )}
        </div>
      )}
    </Modal>
  )
}
