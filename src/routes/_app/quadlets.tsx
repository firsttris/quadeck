import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { useActions } from '~/components/Actions'
import { Glyph } from '~/components/Glyph'
import { Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { PodmanSettingsView } from '~/components/PodmanSettings'
import { QuadletEditor } from '~/components/QuadletEditor'
import { Dot, unitTone } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { api } from '~/lib/api'
import { useLive } from '~/lib/live'
import { TEMPLATES } from '~/lib/quadlet-templates'
import { QUADLET_NAME, QUADLET_TYPES, type ComposeResult, type QuadletFile, type QuadletType, type Revision } from '~/shared/quadlets'

type Tab = 'files' | 'settings'

export const Route = createFileRoute('/_app/quadlets')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab; file?: string } => ({
    tab: s.tab === 'settings' ? 'settings' : undefined,
    file: typeof s.file === 'string' && QUADLET_NAME.test(s.file) ? s.file : undefined,
  }),
  head: () => ({ meta: [{ title: 'Quadlets · Quadeck' }] }),
  component: QuadletsPage,
})

function QuadletsPage() {
  const { tab = 'files' } = Route.useSearch()
  return (
    <>
      <PageHeader title="Quadlets" subtitle="Container-Dateien in /etc/containers/systemd bearbeiten, Podman einstellen" />
      <div role="tablist" aria-label="Bereich" className="flex flex-wrap gap-1.5">
        <Link to="/quadlets" search={{}} role="tab" aria-selected={tab === 'files'} className={`seg ${tab === 'files' ? 'on' : ''}`}>
          Dateien
        </Link>
        <Link to="/quadlets" search={{ tab: 'settings' }} role="tab" aria-selected={tab === 'settings'} className={`seg ${tab === 'settings' ? 'on' : ''}`}>
          Podman-Einstellungen
        </Link>
      </div>
      {tab === 'files' ? <Files /> : <PodmanSettingsView />}
    </>
  )
}

interface Loaded {
  name: string
  content: string
  history: Revision[]
  isNew: boolean
}

function Files() {
  const { file } = Route.useSearch()
  const navigate = useNavigate()
  const { readonly } = useActions()
  const { snapshot } = useLive()
  const [files, setFiles] = useState<QuadletFile[] | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [draft, setDraft] = useState<Loaded | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const loadList = useCallback(async () => {
    try {
      const r = await fetch('/api/quadlets')
      const d = (await r.json()) as { files: QuadletFile[]; error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setFiles(d.files)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const loadFile = useCallback(async (name: string) => {
    const r = await fetch(`/api/quadlets/file?name=${encodeURIComponent(name)}`)
    const d = (await r.json()) as Loaded & { error?: string }
    if (!r.ok) {
      setLoaded(null)
      setError(d.error ?? `HTTP ${r.status}`)
      return
    }
    setLoaded({ ...d, isNew: false })
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])
  useEffect(() => {
    if (file && draft?.name !== file) void loadFile(file)
    if (!file) setLoaded(null)
  }, [file, loadFile, draft?.name])

  const open = (name: string | undefined) => void navigate({ to: '/quadlets', search: name ? { file: name } : {} })
  const unitState = new Map(snapshot.units.map((u) => [u.name, u]))
  const current = draft && draft.name === file ? draft : loaded

  return (
    <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[300px_minmax(0,1fr)]">
      <section className="panel flex flex-col self-start" aria-label="Quadlet-Dateien">
        <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
          <h2 className="h2 grow">Dateien</h2>
          {!readonly && (
            <>
              <button type="button" className="btn sm" onClick={() => setCreating(true)}>
                <Glyph name="plus" size={13} /> Neu
              </button>
              <button type="button" className="btn sm" onClick={() => setImporting(true)}>
                Compose-Import
              </button>
            </>
          )}
        </div>
        {error && <p className="m-0 border-t border-line px-[18px] py-2 text-[13px] text-[#e3b341]">{error}</p>}
        {files?.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">Noch keine Quadlets. „Neu“ oder „Compose-Import“.</p>}
        {draft && !files?.some((f) => f.name === draft.name) && (
          <button type="button" onClick={() => open(draft.name)} className={`flex items-center gap-2 border-t border-line px-[18px] py-[9px] text-left ${file === draft.name ? 'bg-[rgba(124,196,184,.10)]' : ''}`}>
            <span className="grow truncate font-mono text-[13px]">{draft.name}</span>
            <span className="chip">neu</span>
          </button>
        )}
        {files?.map((f) => {
          const u = unitState.get(f.unit)
          return (
            <button
              key={f.name}
              type="button"
              data-testid="quadlet-file"
              aria-current={file === f.name ? 'true' : undefined}
              onClick={() => open(f.name)}
              className={`flex items-center gap-2 border-t border-line px-[18px] py-[9px] text-left hover:bg-[rgba(255,255,255,.03)] ${file === f.name ? 'bg-[rgba(124,196,184,.10)]' : ''}`}
            >
              <Dot tone={u ? unitTone(u) : 'idle'} label={u ? `${f.unit}: ${u.active}` : `${f.unit}: nicht geladen`} />
              <span className="grow truncate font-mono text-[13px]">{f.name}</span>
              <span className="chip q">{f.type}</span>
            </button>
          )
        })}
      </section>

      {current ? (
        <QuadletEditor
          key={current.name + (current.isNew ? ':new' : '')}
          name={current.name}
          initial={current.content}
          isNew={current.isNew}
          history={current.history}
          readonly={readonly}
          onSaved={() => {
            setDraft(null)
            void loadList()
            void loadFile(current.name)
          }}
          onDeleted={() => {
            void loadList()
            open(undefined)
          }}
        />
      ) : (
        <section className="panel flex items-center justify-center p-10 text-[13px] text-muted">Datei links auswählen.</section>
      )}

      <NewDialog
        open={creating}
        existing={files?.map((f) => f.name) ?? []}
        onClose={() => setCreating(false)}
        onCreate={(name, content) => {
          setDraft({ name, content, history: [], isNew: true })
          setCreating(false)
          open(name)
        }}
      />
      <ComposeDialog
        open={importing}
        existing={files?.map((f) => f.name) ?? []}
        onClose={() => setImporting(false)}
        onDone={(first) => {
          setImporting(false)
          void loadList()
          if (first) open(first)
        }}
      />
    </div>
  )
}

function NewDialog({ open, existing, onClose, onCreate }: { open: boolean; existing: string[]; onClose: () => void; onCreate: (name: string, content: string) => void }) {
  const [base, setBase] = useState('')
  const [template, setTemplate] = useState(TEMPLATES[0]!.id)
  const t = TEMPLATES.find((x) => x.id === template)!
  const [type, setType] = useState<QuadletType>(t.type)
  useEffect(() => setType(t.type), [t])
  const name = `${base.trim()}.${type}`
  const valid = QUADLET_NAME.test(name)
  const taken = existing.includes(name)
  return (
    <Modal open={open} onClose={onClose} title="Neue Quadlet-Datei">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && !taken) onCreate(name, t.type === type ? t.content(base.trim()) : `[${type[0]!.toUpperCase()}${type.slice(1)}]\n`)
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Vorlage
          <select className="field" value={template} onChange={(e) => setTemplate(e.target.value)}>
            {TEMPLATES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            Name
            <input className="field font-mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="z. B. nextcloud" autoFocus required />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            Typ
            <select className="field" value={type} onChange={(e) => setType(e.target.value as QuadletType)}>
              {QUADLET_TYPES.map((x) => (
                <option key={x} value={x}>
                  .{x}
                </option>
              ))}
            </select>
          </label>
        </div>
        {base && !valid && <p className="m-0 text-[13px] text-[#ff8a80]">Nur Buchstaben, Ziffern, „-“, „_“ und „.“.</p>}
        {taken && <p className="m-0 text-[13px] text-[#ff8a80]">{name} gibt es schon.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn primary" disabled={!valid || taken}>
            Im Editor öffnen
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ComposeDialog({ open, existing, onClose, onDone }: { open: boolean; existing: string[]; onClose: () => void; onDone: (first?: string) => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const [yaml, setYaml] = useState('')
  const [project, setProject] = useState('')
  const [result, setResult] = useState<ComposeResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [start, setStart] = useState(true)
  useEffect(() => {
    if (!open) return
    setResult(null)
    setError('')
  }, [open])

  const convert = async () => {
    setError('')
    try {
      setResult(await api<ComposeResult>('/api/quadlets/compose', { body: { yaml, project } }))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const create = async () => {
    if (!result) return
    setBusy(true)
    try {
      // Networks and volumes first, so the containers find them.
      const order = (n: string) => (n.endsWith('.network') ? 0 : n.endsWith('.volume') ? 1 : 2)
      const files = [...result.files].sort((a, b) => order(a.name) - order(b.name))
      for (const f of files) {
        const r = await guarded('/api/quadlets/file', { method: 'PUT', body: { name: f.name, content: f.content, restart: start } })
        if (!r) return
      }
      say(`${files.length} Quadlet-Dateien angelegt`)
      onDone(files.find((f) => f.name.endsWith('.container'))?.name)
    } catch (e) {
      setError((e as Error).message)
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Aus docker-compose importieren" wide>
      {!result ? (
        <>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            Projektname (für das gemeinsame Netzwerk)
            <input className="field font-mono" value={project} onChange={(e) => setProject(e.target.value)} placeholder="z. B. paperless" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            docker-compose.yml
            <textarea className="field h-[300px] font-mono text-[12px]" spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} placeholder={'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"'} />
          </label>
        </>
      ) : (
        <>
          {result.warnings.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-[#e3b341]" aria-label="Warnungen">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
            {result.files.map((f) => (
              <div key={f.name} data-testid="compose-file">
                <div className="mb-1 flex items-center gap-2 font-mono text-[13px]">
                  {f.name}
                  {existing.includes(f.name) && <span className="chip">wird überschrieben</span>}
                </div>
                <pre className="joblog !min-h-0">{f.content}</pre>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Units nach dem Anlegen starten
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={result ? () => setResult(null) : onClose}>
          {result ? 'Zurück' : 'Abbrechen'}
        </button>
        {!result ? (
          <button type="button" className="btn primary" disabled={!yaml.trim()} onClick={convert}>
            Umwandeln
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy || !result.files.length} onClick={create}>
            {busy ? 'Lege an …' : `${result.files.length} Dateien anlegen`}
          </button>
        )}
      </div>
    </Modal>
  )
}
