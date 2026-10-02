import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions } from '~/components/Actions'
import { ConfirmDialog, Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { Diagnostics, DiffView, Field, HistoryDialog, TextView } from '~/components/QuadletEditor'
import { Pill, unitTone } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { useT } from '~/i18n'
import { api } from '~/lib/api'
import { tr } from '~/shared/i18n'
import { getValues, parseIni } from '~/shared/ini'
import type { Revision } from '~/shared/quadlets'
import { EDITABLE_UNIT, NEW_UNIT, UNIT_DIR, UNIT_TEMPLATES, formSections, lintUnit, overrideTemplate, type UnitDetail, type UnitFilePart, type UnitValidateResult, type UnitWriteResult } from '~/shared/unit-files'

export const Route = createFileRoute('/_app/systemd')({
  validateSearch: (s: Record<string, unknown>): { unit?: string; new?: boolean } => ({
    unit: typeof s.unit === 'string' && EDITABLE_UNIT.test(s.unit) ? s.unit : undefined,
    new: s.new === true || s.new === 'true' || s.new === 1 ? true : undefined,
  }),
  head: () => ({ meta: [{ title: tr('Unit bearbeiten · Quadeck', 'Edit unit · Quadeck') }] }),
  component: SystemdPage,
})

function SystemdPage() {
  const t = useT().systemd.empty
  const { unit, new: isNew } = Route.useSearch()
  if (isNew) return <NewUnit />
  if (unit) return <UnitView key={unit} unit={unit} />
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <Link to="/units" className="btn self-start">
        {t.toUnits}
      </Link>
    </>
  )
}

// ---------- existing unit ----------

interface Selected {
  part: UnitFilePart
  isNew?: boolean
}

function UnitView({ unit }: { unit: string }) {
  const tx = useT()
  const t = tx.systemd.unit
  const [detail, setDetail] = useState<UnitDetail | null>(null)
  const [error, setError] = useState('')
  const [sel, setSel] = useState<Selected | null>(null)
  const { readonly } = useActions()
  const guarded = useGuardedApi()
  const say = useToast()

  const load = useCallback(
    async (keep?: string) => {
      try {
        const r = await fetch(`/api/systemd?unit=${encodeURIComponent(unit)}`)
        const d = (await r.json()) as UnitDetail & { error?: string }
        if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
        setDetail(d)
        setError('')
        const pick = d.parts.find((p) => p.path === keep) ?? d.parts.findLast((p) => p.editable) ?? d.parts[0]
        setSel(pick ? { part: pick } : null)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [unit],
  )
  useEffect(() => {
    void load()
  }, [load])

  const toggleEnabled = async (enabled: boolean) => {
    try {
      const r = await guarded('/api/systemd', { body: { enable: { unit, enabled } } })
      if (r) {
        say(enabled ? t.bootOn(unit) : t.bootOff(unit))
        void load(sel?.part.path)
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  const d = detail
  const editableState = d?.unitFileState === 'enabled' || d?.unitFileState === 'disabled'
  return (
    <>
      <PageHeader title={unit} subtitle={d?.description ?? t.subtitle}>
        <Link to="/units" className="btn sm">
          {t.backToUnits}
        </Link>
        <Link to="/journal" search={{ unit }} className="btn sm">
          {tx.common.journal}
        </Link>
      </PageHeader>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#e3b341]">
          {error}
        </p>
      )}
      {!d && !error && <p className="m-0 text-muted">{t.loading}</p>}
      {d && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <Pill tone={unitTone({ active: d.activeState, sub: '' })}>{d.activeState}</Pill>
            {d.unitFileState && <span className="chip">{d.unitFileState}</span>}
            {editableState && !d.readonly && (
              <label className="flex items-center gap-2">
                <input type="checkbox" role="switch" aria-label={t.startAtBoot} checked={d.unitFileState === 'enabled'} disabled={readonly} onChange={(e) => void toggleEnabled(e.target.checked)} />
                {t.startAtBoot}
              </label>
            )}
          </div>
          {d.readonly && <p className="m-0 text-[13px] text-[#e3b341]">{d.readonly}</p>}
          {d.quadlet && (
            <p className="m-0 text-[13px] text-muted">
              {t.quadletBefore} <span className="font-mono">{d.quadlet}</span> {t.quadletMiddle}{' '}
              <Link to="/quadlets" search={{ file: d.quadlet }} className="text-accent underline">
                {t.quadletLink}
              </Link>
              {t.quadletAfter}
            </p>
          )}
          {d.managedTimer && (
            <p className="m-0 text-[13px] text-muted">
              {t.timerBefore}{' '}
              <Link to="/units" search={{ filter: 'timer' }} className="text-accent underline">
                {t.timerLink}
              </Link>
              {t.timerAfter}
            </p>
          )}
          {d.template && <p className="m-0 text-[13px] text-muted">{t.template}</p>}
          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
            <section className="panel flex flex-col gap-2 self-start p-[14px]" aria-label={t.files}>
              <h2 className="h2 px-1">{t.files}</h2>
              {d.parts.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left ${sel?.part.path === p.path ? 'border-accent bg-[rgba(124,196,184,.08)]' : 'border-line hover:border-edge'}`}
                  aria-pressed={sel?.part.path === p.path}
                  onClick={() => setSel({ part: p })}
                >
                  <span className="font-mono text-[12px] break-all">{p.path}</span>
                  <span className="flex flex-wrap gap-1.5">
                    <span className="chip">{p.kind === 'fragment' ? t.fragment : t.override}</span>
                    <span className={p.origin === 'etc' ? 'chip q' : 'chip'}>{tx.systemd.origin[p.origin]}</span>
                    {!p.editable && <span className="chip">{t.readonly}</span>}
                  </span>
                </button>
              ))}
              {sel?.isNew && (
                <div className="rounded-lg border border-accent bg-[rgba(124,196,184,.08)] px-3 py-2">
                  <span className="font-mono text-[12px] break-all">{sel.part.path}</span>
                  <div className="mt-1 text-[11px] text-muted">{t.isNew}</div>
                </div>
              )}
              {d.overridePath && !sel?.isNew && !readonly && (
                <button type="button" className="btn sm self-start" onClick={() => setSel({ isNew: true, part: { path: d.overridePath!, kind: 'dropin', origin: 'etc', editable: true, content: overrideTemplate(unit, d.parts[0]?.path) } })}>
                  {t.addOverride}
                </button>
              )}
              <p className="m-0 px-1 text-[11px] leading-[1.5] text-subtle">
                {t.overridesNote(`${UNIT_DIR}/${unit}.d`)}
              </p>
            </section>
            {sel && (
              <PartEditor
                key={sel.part.path + (sel.isNew ? ':new' : '')}
                unit={unit}
                detail={d}
                part={sel.part}
                isNew={!!sel.isNew}
                readonly={readonly || !!d.readonly || !sel.part.editable}
                onSaved={() => void load(sel.part.path)}
                onDeleted={() => void load()}
                onOverride={d.overridePath ? () => setSel({ isNew: true, part: { path: d.overridePath!, kind: 'dropin', origin: 'etc', editable: true, content: overrideTemplate(unit, d.parts[0]?.path) } }) : undefined}
              />
            )}
          </div>
        </>
      )}
    </>
  )
}

/** Form over the text: only known keys; placeholders show what applies without this file. */
function UnitForm({ unit, text, base, onChange }: { unit: string; text: string; base: string; onChange: (t: string) => void }) {
  const t = useT().systemd.form
  const sections = formSections(unit)
  const shown = new Set(sections.flatMap(([s, keys]) => Object.keys(keys).map((k) => `${s}.${k}`)))
  const other = parseIni(text).filter((e) => e.kind === 'kv' && !shown.has(`${e.section}.${e.key}`))
  return (
    <div className="flex flex-col gap-5">
      {sections.map(([section, keys]) => (
        <fieldset key={section} className="m-0 grid grid-cols-1 gap-3 rounded-[10px] border border-edge p-4 2xl:grid-cols-2">
          <legend className="px-1 font-mono text-[13px] text-accent">[{section}]</legend>
          {Object.entries(keys).map(([k, doc]) => {
            const inherited = base ? getValues(base, section, k).filter(Boolean).at(-1) : undefined
            return <Field key={k} section={section} k={k} doc={inherited ? { ...doc, help: t.before(doc.help, inherited) } : doc} text={text} onChange={onChange} />
          })}
        </fieldset>
      ))}
      {other.length > 0 && (
        <p className="m-0 text-[12px] text-muted">
          {t.otherEntries} <span className="font-mono">{other.map((e) => `${e.section}.${e.key}`).join(', ')}</span>
        </p>
      )}
    </div>
  )
}

function PartEditor({
  unit,
  detail,
  part,
  isNew,
  readonly,
  onSaved,
  onDeleted,
  onOverride,
}: {
  unit: string
  detail: UnitDetail
  part: UnitFilePart
  isNew: boolean
  readonly: boolean
  onSaved: () => void
  onDeleted: () => void
  onOverride?: () => void
}) {
  const tx = useT()
  const t = tx.systemd.editor
  const q = tx.quadlets.editor
  const say = useToast()
  const guarded = useGuardedApi()
  const [text, setText] = useState(part.content)
  const [mode, setMode] = useState<'form' | 'text'>(readonly ? 'text' : part.kind === 'dropin' && formSections(unit).length > 2 ? 'form' : 'text')
  const [server, setServer] = useState<UnitValidateResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [review, setReview] = useState(false)
  const [restart, setRestart] = useState(detail.activeState === 'active')
  const [saving, setSaving] = useState(false)
  const [jump, setJump] = useState<number | null>(null)
  const [history, setHistory] = useState<Revision[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const historyUrl = `/api/systemd?unit=${encodeURIComponent(unit)}&path=${encodeURIComponent(part.path)}`
  const loadHistory = useCallback(() => {
    if (!part.editable) return
    fetch(`${historyUrl}&history`)
      .then((r) => (r.ok ? (r.json() as Promise<Revision[]>) : []))
      .then(setHistory)
      .catch(() => {})
  }, [historyUrl, part.editable])
  useEffect(loadHistory, [loadHistory])

  // What applies without this file: the other files before it.
  const base = useMemo(() => {
    const idx = detail.parts.findIndex((p) => p.path === part.path)
    return (idx < 0 ? detail.parts : detail.parts.slice(0, idx)).map((p) => p.content).join('\n')
  }, [detail.parts, part.path])
  const local = useMemo(() => lintUnit(text, part.kind), [text, part.kind])
  const dirty = isNew || text !== part.content
  const diags = server ? server.diagnostics : local
  const change = (t: string) => {
    setText(t)
    setServer(null)
  }

  const validate = async () => {
    setChecking(true)
    try {
      const r = await api<UnitValidateResult>('/api/systemd', { body: { validate: { unit, path: part.path, content: text } } })
      setServer(r)
      return r
    } catch (e) {
      say((e as Error).message, 'bad')
      return null
    } finally {
      setChecking(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await guarded<UnitWriteResult>('/api/systemd', { body: { write: { unit, path: part.path, content: text, restart } } })
      if (!r) return
      setReview(false)
      if (r.warning) say(r.warning, 'bad')
      else say(t.saved(part.path, unit, r.restarted))
      loadHistory()
      onSaved()
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      const r = await guarded('/api/systemd', { body: { delete: { unit, path: part.path } } })
      if (!r) return
      say(part.kind === 'dropin' ? t.overrideRemoved(part.path) : t.unitDeleted(unit))
      onDeleted()
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  return (
    <section className="panel flex min-w-0 flex-col gap-4 p-[18px]" aria-label={t.aria(part.path)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 grow">
          <h2 className="h2 truncate font-mono text-[14px]">{part.path}</h2>
          <div className="text-[12px] text-muted">
            {isNew ? tx.systemd.unit.isNew : readonly ? tx.systemd.unit.readonly : part.kind === 'dropin' ? tx.systemd.unit.override : t.ownUnit}
            {dirty && !isNew && q.unsaved}
          </div>
        </div>
        {!readonly && (
          <div role="group" aria-label={q.view} className="flex gap-1.5">
            <button type="button" className={`seg ${mode === 'form' ? 'on' : ''}`} aria-pressed={mode === 'form'} onClick={() => setMode('form')}>
              {q.form}
            </button>
            <button type="button" className={`seg ${mode === 'text' ? 'on' : ''}`} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
              {q.text}
            </button>
          </div>
        )}
      </div>

      {readonly && part.origin === 'vendor' && (
        <p className="m-0 text-[13px] text-muted">
          {t.vendorNote}
          {onOverride && (
            <>
              {' '}
              <button type="button" className="btn sm" onClick={onOverride}>
                {t.addOverride}
              </button>
            </>
          )}
        </p>
      )}

      {mode === 'form' && !readonly ? (
        <UnitForm unit={unit} text={text} base={part.kind === 'dropin' ? base : ''} onChange={change} />
      ) : (
        <TextView text={text} jump={jump} label={t.contentOf(part.path)} readOnly={readonly} height={readonly ? 360 : 480} onChange={change} />
      )}

      <Diagnostics
        items={diags}
        onLine={(l) => {
          setMode('text')
          setJump(null)
          setTimeout(() => setJump(l), 0)
        }}
      />
      {server?.skipped && <p className="m-0 text-[13px] text-muted">{server.skipped}</p>}
      {server?.ok && !server.skipped && <p className="m-0 text-[13px] text-[#7ee2a8]">{t.verified}</p>}

      {!readonly && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {!isNew && (part.kind === 'dropin' || detail.canDelete) && (
            <button type="button" className="btn danger sm" onClick={() => setConfirmDelete(true)}>
              {part.kind === 'dropin' ? t.removeOverride : t.deleteUnit}
            </button>
          )}
          {history.length > 0 && (
            <button type="button" className="btn sm" onClick={() => setShowHistory(true)}>
              {q.history(history.length)}
            </button>
          )}
          <span className="grow" />
          {dirty && !isNew && (
            <button type="button" className="btn sm" onClick={() => change(part.content)}>
              {q.discard}
            </button>
          )}
          <button type="button" className="btn sm" onClick={() => void validate()} disabled={checking}>
            {checking ? q.checking : q.check}
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={!dirty || checking || local.some((x) => x.severity === 'error')}
            onClick={async () => {
              const r = await validate()
              if (r?.ok) setReview(true)
            }}
          >
            {q.saveDots}
          </button>
        </div>
      )}

      <Modal open={review} onClose={() => setReview(false)} title={q.saveTitle(part.path)} wide>
        <DiffView before={isNew ? '' : part.content} after={text} />
        {(detail.activeState === 'active' || detail.activeState === 'activating') && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
            {t.restartBefore} <span className="font-mono">{unit}</span> {t.restartAfter}
          </label>
        )}
        <p className="m-0 text-[12px] text-muted">{q.saveNote}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setReview(false)}>
            {tx.common.cancel}
          </button>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? q.savingDots : restart && detail.activeState === 'active' ? q.saveRestart : tx.common.save}
          </button>
        </div>
      </Modal>
      <HistoryDialog
        open={showHistory}
        name={part.path}
        history={history}
        current={text}
        url={(id) => `${historyUrl}&revision=${id}`}
        onClose={() => setShowHistory(false)}
        onLoad={(content) => {
          change(content)
          setShowHistory(false)
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={part.kind === 'dropin' ? t.removeOverrideTitle : t.deleteTitle(unit)}
        danger
        confirm={part.kind === 'dropin' ? tx.common.remove : tx.common.delete}
        body={
          <p className="m-0">
            {part.kind === 'dropin' ? (
              <>
                <span className="font-mono">{part.path}</span>
                {t.dropinBody}
              </>
            ) : (
              <>
                {t.fragmentBefore(unit)}
                <span className="font-mono">{part.path}</span>
                {t.fragmentAfter}
              </>
            )}{' '}
            {t.keptInHistory}
          </p>
        }
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </section>
  )
}

// ---------- new unit ----------

function NewUnit() {
  const tx = useT()
  const t = tx.systemd.create
  const q = tx.quadlets.editor
  const navigate = useNavigate()
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState(UNIT_TEMPLATES[0]!.id)
  const [text, setText] = useState(UNIT_TEMPLATES[0]!.content(t.defaultName))
  const [touched, setTouched] = useState(false)
  const [mode, setMode] = useState<'form' | 'text'>('text')
  const [enable, setEnable] = useState(true)
  const [server, setServer] = useState<UnitValidateResult | null>(null)
  const [busy, setBusy] = useState(false)
  const unit = name && !/\.\w+$/.test(name) ? `${name}.service` : name
  const validName = NEW_UNIT.test(unit)
  const local = useMemo(() => lintUnit(text, 'fragment'), [text])
  const diags = server ? server.diagnostics : local

  const pick = (id: string) => {
    const tpl = UNIT_TEMPLATES.find((x) => x.id === id)!
    setTemplate(id)
    setText(tpl.content(unit.replace(/\.\w+$/, '') || t.defaultName))
    setTouched(false)
    setServer(null)
  }
  // The template follows the name until the text is edited.
  useEffect(() => {
    if (!touched) setText(UNIT_TEMPLATES.find((x) => x.id === template)!.content(unit.replace(/\.\w+$/, '') || t.defaultName))
  }, [unit, template, touched, t.defaultName])

  const create = async () => {
    setBusy(true)
    try {
      const check = await api<UnitValidateResult>('/api/systemd', { body: { validate: { unit, path: `${UNIT_DIR}/${unit}`, content: text } } })
      setServer(check)
      if (!check.ok) return
      const r = await guarded<UnitWriteResult>('/api/systemd', { body: { create: { unit, content: text, enable } } })
      if (!r) return
      if (r.warning) say(r.warning, 'bad')
      else say(t.created(unit, r.restarted))
      void navigate({ to: '/systemd', search: { unit } })
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle(UNIT_DIR)}>
        <Link to="/units" className="btn sm">
          {tx.systemd.unit.backToUnits}
        </Link>
      </PageHeader>
      <section className="panel flex flex-col gap-4 p-[18px]" aria-label={t.title}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            {t.name}
            <input className="field w-[280px] font-mono" value={name} placeholder="mein-dienst.service" onChange={(e) => setName(e.target.value.trim())} autoFocus />
          </label>
          {name && !validName && <span className="pb-2 text-[12px] text-[#ff8a80]">{t.invalidName}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          {t.template}
          {UNIT_TEMPLATES.map((x) => (
            <button key={x.id} type="button" className={`seg ${template === x.id ? 'on' : ''}`} aria-pressed={template === x.id} onClick={() => pick(x.id)}>
              {x.label}
            </button>
          ))}
          <span className="grow" />
          <div role="group" aria-label={q.view} className="flex gap-1.5">
            <button type="button" className={`seg ${mode === 'form' ? 'on' : ''}`} aria-pressed={mode === 'form'} onClick={() => setMode('form')}>
              {q.form}
            </button>
            <button type="button" className={`seg ${mode === 'text' ? 'on' : ''}`} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
              {q.text}
            </button>
          </div>
        </div>
        {mode === 'form' ? (
          <UnitForm
            unit={unit || 'x.service'}
            text={text}
            base=""
            onChange={(v) => {
              setText(v)
              setTouched(true)
              setServer(null)
            }}
          />
        ) : (
          <TextView
            text={text}
            jump={null}
            label={t.contentLabel}
            height={420}
            onChange={(v) => {
              setText(v)
              setTouched(true)
              setServer(null)
            }}
          />
        )}
        <Diagnostics items={diags} />
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
            {t.enable}
          </label>
          <span className="grow" />
          {!readonly && (
            <button type="button" className="btn primary" disabled={!validName || busy || local.some((x) => x.severity === 'error')} onClick={() => void create()}>
              {busy ? t.creating : tx.common.create}
            </button>
          )}
        </div>
      </section>
    </>
  )
}
