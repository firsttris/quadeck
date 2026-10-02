import { useCallback, useEffect, useMemo, useState } from 'react'
import { diskSize } from '~/lib/format'
import {
  FS_PACKAGE,
  defaultOptions,
  defaultPassno,
  formatEntry,
  optionDoc,
  optionName,
  optionValue,
  specFor,
  suggestTarget,
  type BlockDevice,
  type EntryInput,
  type FstabChange,
  type FstabCheck,
  type FstabState,
  type MountView,
} from '~/shared/fstab'
import { useActions } from './Actions'
import { Glyph } from './Glyph'
import { ConfirmDialog, Modal } from './Modal'
import { DiffView, Diagnostics, HistoryDialog } from './QuadletEditor'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { ApiError, api } from '~/lib/api'

const FAT_LIKE = ['vfat', 'exfat', 'ntfs3', 'ntfs', 'ntfs-3g']

function deviceLabel(d: BlockDevice) {
  return [d.label && `„${d.label}“`, d.model, diskSize(d.size)].filter(Boolean).join(' · ')
}

/**
 * /etc/fstab as a list: which file systems are mounted where, which would stop
 * the boot, and devices that are not in the file yet. Every change is checked
 * on the server (device, driver, findmnt, systemd generator, test mount)
 * before the file is written.
 */
export function MountsView() {
  const { readonly } = useActions()
  const say = useToast()
  const guarded = useGuardedApi()
  const [state, setState] = useState<FstabState | null>(null)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<null | { entry?: MountView; device?: BlockDevice }>(null)
  const [pending, setPending] = useState<null | { change: FstabChange; check: FstabCheck; title: string }>(null)
  const [history, setHistory] = useState(false)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/fstab')
      const d = (await r.json()) as FstabState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  /** Check on the server, then show the confirmation with diff and steps. */
  const review = async (change: FstabChange, title: string) => {
    try {
      const check = await api<FstabCheck>('/api/fstab', { body: { validate: change } })
      setPending({ change, check, title })
      return check
    } catch (e) {
      say((e as Error).message, 'bad')
      if (e instanceof ApiError && e.status === 409) void load()
    }
  }

  const mount = async (e: MountView, action: 'mount' | 'unmount') => {
    setBusy(e.file)
    try {
      const s = await guarded<FstabState>('/api/fstab', { body: { mount: { target: e.file, action } } })
      if (s) {
        setState(s)
        say(action === 'mount' ? `${e.file} eingehängt` : `${e.file} ausgehängt`)
      }
    } catch (err) {
      say((err as Error).message, 'bad')
    } finally {
      setBusy('')
    }
  }

  const taken = state?.entries.map((e) => e.file) ?? []
  const own = state?.entries.filter((e) => !e.system) ?? []
  const system = state?.entries.filter((e) => e.system) ?? []

  return (
    <>
      <p className="m-0 text-[13px] text-muted">
        Welche Platten beim Start wo eingehängt werden ({state?.path ?? '/etc/fstab'}). Jede Änderung wird vorher geprüft – Gerät, Dateisystem, Treiber, <span className="font-mono">findmnt --verify</span>, der fstab-Generator von systemd und ein Probemount mit den gewählten Optionen. Systemeinträge bleiben unangetastet.
      </p>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">Wird gelesen …</p>}
      {state && (
        <>
          <section className="panel relative flex flex-col overflow-x-auto" aria-label="Einträge">
            <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
              <h2 className="h2 grow">Eingebunden</h2>
              {state.history.length > 0 && (
                <button type="button" className="btn sm" onClick={() => setHistory(true)}>
                  Verlauf ({state.history.length})
                </button>
              )}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Einhängepunkt</th>
                  <th className="hidden md:table-cell">Quelle</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Aktionen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {own.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-muted">
                      Noch keine Datenplatten in der fstab.
                    </td>
                  </tr>
                )}
                {own.map((e) => (
                  <EntryRow key={e.line} e={e} readonly={readonly} busy={busy === e.file} onEdit={() => setEdit({ entry: e })} onMount={(a) => void mount(e, a)} onRemove={() => void review({ kind: 'remove', line: e.line, original: e.raw }, `${e.file} entfernen`)} />
                ))}
              </tbody>
            </table>
            {system.length > 0 && (
              <details className="border-t border-line px-[18px] py-3 text-[13px]">
                <summary className="cursor-pointer text-muted">Systemeinträge ({system.length}) – nur zur Ansicht</summary>
                <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                  {system.map((e) => (
                    <li key={e.line} className="flex flex-wrap items-center gap-2" data-testid="system-entry">
                      <Glyph name="lock" size={13} />
                      <span className="font-mono">{e.file}</span>
                      <span className="text-muted">
                        {e.vfstype} · {e.system}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="panel flex flex-col" aria-label="Nicht eingebunden">
            <div className="px-[18px] pt-4 pb-2">
              <h2 className="h2">Nicht eingebunden</h2>
            </div>
            {state.devices.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">Alle Dateisysteme stehen in der fstab.</p>}
            {state.devices.map((d) => (
              <div key={d.path} data-testid="free-device" className="flex flex-wrap items-center gap-3 border-t border-line px-[18px] py-3">
                <Glyph name="disk" />
                <div className="min-w-0 grow">
                  <div className="font-mono text-[13px]">
                    {d.path} <span className="chip q">{d.fstype}</span>
                  </div>
                  <div className="text-[12px] text-muted">
                    {deviceLabel(d)}
                    {d.mountpoints.length > 0 && ` · gerade unter ${d.mountpoints.join(', ')} eingehängt, aber nicht in der fstab – nach dem Neustart weg`}
                  </div>
                </div>
                {!readonly && (
                  <button type="button" className="btn sm" onClick={() => setEdit({ device: d })}>
                    Einbinden …
                  </button>
                )}
              </div>
            ))}
          </section>
        </>
      )}

      {edit && state && (
        <EntryDialog
          key={edit.entry?.line ?? edit.device?.path}
          entry={edit.entry}
          device={edit.device}
          taken={taken}
          onClose={() => setEdit(null)}
          onReview={async (change, title) => {
            const c = await review(change, title)
            if (c) setEdit(null)
          }}
        />
      )}

      {pending && (
        <ApplyDialog
          pending={pending}
          onClose={() => setPending(null)}
          onApplied={(s, msg) => {
            setState(s)
            setPending(null)
            say(msg)
          }}
          onConflict={() => {
            setPending(null)
            void load()
          }}
        />
      )}

      {state && (
        <HistoryDialog
          open={history}
          name={state.path}
          history={state.history}
          current={state.content}
          url={(id) => `/api/fstab?revision=${encodeURIComponent(id)}`}
          onClose={() => setHistory(false)}
          onLoad={(content) => {
            setHistory(false)
            void review({ kind: 'restore', content }, 'Frühere Fassung wiederherstellen')
          }}
        />
      )}
    </>
  )
}

function EntryRow({ e, readonly, busy, onEdit, onMount, onRemove }: { e: MountView; readonly: boolean; busy: boolean; onEdit: () => void; onMount: (a: 'mount' | 'unmount') => void; onRemove: () => void }) {
  return (
    <tr data-testid="fstab-entry">
      <td>
        <div className="font-mono text-[13px]">{e.file}</div>
        <div className="text-[12px] text-muted">
          {e.vfstype}
          {e.size ? ` · ${diskSize(e.used ?? 0)} von ${diskSize(e.size)} belegt` : ''}
        </div>
        {e.usedBy.length > 0 && <div className="text-[12px] text-muted">genutzt von {e.usedBy.join(', ')}</div>}
        <div className="mt-1 flex max-w-[420px] flex-wrap gap-1">
          {e.options.map((o) => (
            <span key={o} className="chip" title={optionDoc(o)?.text ?? 'Option des Treibers'}>
              {o}
            </span>
          ))}
        </div>
      </td>
      <td className="hidden md:table-cell">
        <div className="max-w-[260px] truncate font-mono text-[12px]" title={e.spec}>
          {e.spec}
        </div>
        <div className="max-w-[260px] text-[12px] text-muted">{e.device ? `${e.device.path} · ${deviceLabel(e.device)}` : e.missing ? 'Gerät nicht gefunden' : ''}</div>
      </td>
      <td>
        <div className="flex flex-col items-start gap-1">
          {e.mounted ? <Pill tone="ok">eingehängt</Pill> : e.missing ? <Pill tone="bad">Gerät fehlt</Pill> : <Pill tone="idle">nicht eingehängt</Pill>}
          {e.bootCritical ? (
            <span className="text-[12px] text-[#e3b341]" title="Fehlt die Platte beim Start, hält der Server im Notfallmodus an. „nofail“ verhindert das.">
              blockiert den Start, wenn sie fehlt
            </span>
          ) : (
            <span className="text-[12px] text-muted">Start auch ohne sie</span>
          )}
          {e.mountedAt && <span className="text-[12px] text-muted">gerade unter {e.mountedAt}</span>}
        </div>
      </td>
      <td className="whitespace-nowrap text-right">
        {!readonly && (
          <div className="inline-flex gap-1.5">
            {e.mounted ? (
              <button type="button" className="btn sm" disabled={busy} onClick={() => onMount('unmount')}>
                Aushängen
              </button>
            ) : (
              !e.missing && (
                <button type="button" className="btn sm" disabled={busy} onClick={() => onMount('mount')}>
                  Einhängen
                </button>
              )
            )}
            <button type="button" className="btn sm" onClick={onEdit} aria-label={`${e.file} bearbeiten`}>
              Bearbeiten
            </button>
            <button type="button" className="btn sm" onClick={onRemove} aria-label={`${e.file} entfernen`}>
              <Glyph name="trash" size={13} />
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

// ---------- add / edit ----------

interface Form {
  spec: string
  file: string
  vfstype: string
  nofail: boolean
  timeout: string
  noatime: boolean
  automount: boolean
  ro: boolean
  harden: boolean
  compress: boolean
  uid: string
  gid: string
  umask: string
  extra: string
  passno: number
  freq: number
}

const MANAGED = new Set(['nofail', 'x-systemd.device-timeout', 'noatime', 'x-systemd.automount', 'ro', 'nodev', 'nosuid', 'compress', 'uid', 'gid', 'umask'])

function toForm(e: { spec: string; file: string; vfstype: string; options: string[]; passno: number; freq: number }): Form {
  const o = e.options
  const val = (n: string) => optionValue(o.find((x) => optionName(x) === n) ?? '') ?? ''
  const compress = val('compress')
  const managed = (x: string) => MANAGED.has(optionName(x)) && !(optionName(x) === 'compress' && compress !== 'zstd')
  return {
    spec: e.spec,
    file: e.file,
    vfstype: e.vfstype,
    nofail: o.includes('nofail'),
    timeout: val('x-systemd.device-timeout').replace(/s$/, ''),
    noatime: o.includes('noatime'),
    automount: o.includes('x-systemd.automount'),
    ro: o.includes('ro'),
    harden: o.includes('nodev') && o.includes('nosuid'),
    compress: compress === 'zstd',
    uid: val('uid'),
    gid: val('gid'),
    umask: val('umask'),
    extra: o.filter((x) => !managed(x) && !((x === 'nodev' || x === 'nosuid') && !(o.includes('nodev') && o.includes('nosuid')))).join(','),
    passno: e.passno,
    freq: e.freq,
  }
}

function toInput(f: Form, note?: string): EntryInput {
  const o: string[] = []
  const extra = f.extra
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (extra.includes('defaults')) o.push('defaults')
  if (f.nofail) o.push('nofail')
  if (f.nofail && f.timeout) o.push(`x-systemd.device-timeout=${/^\d+$/.test(f.timeout) ? f.timeout + 's' : f.timeout}`)
  if (f.automount) o.push('x-systemd.automount')
  if (f.noatime) o.push('noatime')
  if (f.ro) o.push('ro')
  if (f.harden) o.push('nodev', 'nosuid')
  if (f.vfstype === 'btrfs' && f.compress) o.push('compress=zstd')
  if (FAT_LIKE.includes(f.vfstype)) {
    if (f.uid) o.push(`uid=${f.uid}`)
    if (f.gid) o.push(`gid=${f.gid}`)
    if (f.umask) o.push(`umask=${f.umask}`)
  }
  for (const x of extra) if (x !== 'defaults' && !o.includes(x)) o.push(x)
  return { spec: f.spec.trim(), file: f.file.trim(), vfstype: f.vfstype.trim(), options: o, freq: f.freq, passno: f.passno, note }
}

function Toggle({ checked, onChange, label, help, warn }: { checked: boolean; onChange: (v: boolean) => void; label: string; help: string; warn?: string }) {
  return (
    <label className="flex items-start gap-2.5 text-[13px]">
      <input type="checkbox" className="mt-[3px]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col">
        <span className="font-medium text-fg">{label}</span>
        <span className="text-[12px] text-muted">{help}</span>
        {warn && <span className="text-[12px] text-[#e3b341]">{warn}</span>}
      </span>
    </label>
  )
}

const label = 'flex flex-col gap-1 text-[12px] font-medium text-muted'

function EntryDialog({ entry, device, taken, onClose, onReview }: { entry?: MountView; device?: BlockDevice; taken: string[]; onClose: () => void; onReview: (c: FstabChange, title: string) => Promise<void> }) {
  const initial = useMemo<Form>(() => {
    if (entry) return toForm(entry)
    const d = device!
    return toForm({ spec: specFor(d), file: suggestTarget(d, taken), vfstype: d.fstype === 'ntfs' ? 'ntfs3' : d.fstype, options: defaultOptions(d.fstype === 'ntfs' ? 'ntfs3' : d.fstype), passno: defaultPassno(d.fstype), freq: 0 })
  }, [entry, device, taken])
  const [f, setF] = useState<Form>(initial)
  const [check, setCheck] = useState<FstabCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const note = device ? [device.label, device.model].filter(Boolean).join(' – ') : undefined
  const input = toInput(f, note)
  const change: FstabChange = entry ? { kind: 'update', line: entry.line, original: entry.raw, entry: input } : { kind: 'add', entry: input }
  const key = JSON.stringify(change)

  // Checks on the server while typing (no unlock needed, nothing is written).
  useEffect(() => {
    setChecking(true)
    const t = setTimeout(() => {
      api<FstabCheck>('/api/fstab', { body: { validate: change } })
        .then(setCheck)
        .catch((e: Error) => setCheck({ ok: false, diagnostics: [{ severity: 'error', message: e.message }], before: '', after: '', bootCritical: [], actions: [], usedBy: [] }))
        .finally(() => setChecking(false))
    }, 350)
    return () => clearTimeout(t)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const fat = FAT_LIKE.includes(f.vfstype)
  const specs = device ? (['uuid', 'label', 'partuuid'] as const).filter((b) => b === 'uuid' || (b === 'label' ? device.label : device.partuuid)).map((b) => specFor(device, b)) : []
  return (
    <Modal open onClose={onClose} title={entry ? `${entry.file} bearbeiten` : `${device!.path} einbinden`} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void onReview(change, entry ? `${entry.file} ändern` : `${device!.path} einbinden`)
        }}
      >
        {device && <p className="m-0 text-[13px] text-muted">{deviceLabel(device)}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr]">
          <label className={label}>
            Einhängepunkt
            <input className="field font-mono" value={f.file} onChange={(e) => set('file', e.target.value)} required autoFocus />
          </label>
          <label className={label}>
            Dateisystem
            <input className="field font-mono" value={f.vfstype} onChange={(e) => set('vfstype', e.target.value)} required />
          </label>
        </div>
        <label className={label}>
          Quelle
          {specs.length > 1 ? (
            <select className="field font-mono" value={f.spec} onChange={(e) => set('spec', e.target.value)}>
              {specs.map((s) => (
                <option key={s} value={s}>
                  {s}
                  {s.startsWith('UUID=') ? ' (empfohlen)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input className="field font-mono" value={f.spec} onChange={(e) => set('spec', e.target.value)} required />
          )}
          <span className="font-normal">Über die UUID bleibt der Eintrag richtig, auch wenn aus sdb nach einem Umbau sdc wird.</span>
        </label>

        <fieldset className="m-0 flex flex-col gap-3 rounded-[10px] border border-edge p-3">
          <legend className="px-1 text-[12px] font-medium text-muted">Optionen</legend>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Toggle checked={f.nofail} onChange={(v) => set('nofail', v)} label="Start auch ohne diese Platte (nofail)" help="Fehlt sie oder ist sie defekt, bootet der Server trotzdem." warn={!f.nofail && !f.automount ? 'Ohne nofail hält der Server beim Start im Notfallmodus an, wenn die Platte fehlt.' : undefined} />
              {f.nofail && (
                <label className="ml-6 flex items-center gap-2 text-[12px] text-muted">
                  höchstens
                  <input className="field w-16 !py-1 font-mono" value={f.timeout} onChange={(e) => set('timeout', e.target.value)} aria-label="Wartezeit in Sekunden" />
                  Sekunden auf die Platte warten
                </label>
              )}
            </div>
            <Toggle checked={f.noatime} onChange={(v) => set('noatime', v)} label="Keine Zugriffszeiten (noatime)" help={optionDoc('noatime')!.text} />
            <Toggle checked={f.automount} onChange={(v) => set('automount', v)} label="Erst beim Zugriff einhängen (automount)" help="Der Start wartet nicht auf die Platte; sie wird beim ersten Öffnen eingehängt." />
            <Toggle checked={f.harden} onChange={(v) => set('harden', v)} label="Als reine Datenplatte absichern (nodev, nosuid)" help="Gerätedateien und Setuid-Programme auf der Platte werden ignoriert." />
            <Toggle checked={f.ro} onChange={(v) => set('ro', v)} label="Nur lesen (ro)" help="Nichts auf der Platte lässt sich ändern." />
            {f.vfstype === 'btrfs' && <Toggle checked={f.compress} onChange={(v) => set('compress', v)} label="Komprimieren (compress=zstd)" help="Neue Dateien werden transparent komprimiert – spart Platz, kostet etwas CPU." />}
          </div>
          {fat && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-[12px] text-muted">{f.vfstype} kennt keine Linux-Rechte – Besitzer und Rechte gelten für alle Dateien:</p>
              <div className="grid grid-cols-3 gap-3">
                <label className={label}>
                  Benutzer-ID (uid)
                  <input className="field font-mono" value={f.uid} onChange={(e) => set('uid', e.target.value)} placeholder="1000" />
                </label>
                <label className={label}>
                  Gruppen-ID (gid)
                  <input className="field font-mono" value={f.gid} onChange={(e) => set('gid', e.target.value)} placeholder="1000" />
                </label>
                <label className={label}>
                  umask
                  <input className="field font-mono" value={f.umask} onChange={(e) => set('umask', e.target.value)} placeholder="022" />
                </label>
              </div>
            </div>
          )}
          <label className={label}>
            Weitere Optionen (durch Komma getrennt)
            <input className="field font-mono" value={f.extra} onChange={(e) => set('extra', e.target.value)} placeholder="z. B. x-systemd.idle-timeout=10min" />
          </label>
          <label className="flex items-center gap-2 text-[12px] text-muted">
            Beim Start prüfen (fsck)
            <select className="field !w-auto !py-1" value={f.passno} onChange={(e) => set('passno', Number(e.target.value))} aria-label="Prüfreihenfolge">
              <option value={0}>nein (0)</option>
              <option value={2}>ja, nach der Systempartition (2)</option>
              <option value={1}>als Systempartition (1)</option>
            </select>
            <span>{['ext2', 'ext3', 'ext4'].includes(f.vfstype) ? 'für ext4 empfohlen: 2' : `für ${f.vfstype} empfohlen: 0`}</span>
          </label>
        </fieldset>

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-muted">Zeile in der fstab</span>
          <pre className="joblog !min-h-0 whitespace-pre-wrap" aria-label="fstab-Zeile">
            {formatEntry(input).replace(/\t/g, '  ')}
          </pre>
          {check && <Diagnostics items={check.diagnostics} />}
          {check && check.bootCritical.length > 0 && <p className="m-0 text-[13px] text-[#e3b341]">Dieser Eintrag würde den Start blockieren, wenn die Platte fehlt – beim Speichern musst du das ausdrücklich bestätigen.</p>}
          {check?.ok && !checking && <p className="m-0 text-[13px] text-[#7ee2a8]">Geprüft – beim Speichern folgt noch ein Probemount.</p>}
          {check?.diagnostics.some((d) => /Treiber für (\S+) fehlt/.test(d.message)) && FS_PACKAGE[f.vfstype] && <p className="m-0 text-[12px] text-muted">Paket installieren: System → Installiert, oder <span className="font-mono">sudo pacman -S {FS_PACKAGE[f.vfstype]}</span></p>}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn primary" disabled={!check?.ok || checking}>
            Weiter …
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---------- confirm & write ----------

function ApplyDialog({ pending, onClose, onApplied, onConflict }: { pending: { change: FstabChange; check: FstabCheck; title: string }; onClose: () => void; onApplied: (s: FstabState, msg: string) => void; onConflict: () => void }) {
  const guarded = useGuardedApi()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { change, check, title } = pending
  const critical = check.bootCritical.length > 0
  const apply = async () => {
    setBusy(true)
    setError('')
    try {
      const s = await guarded<FstabState>('/api/fstab', { body: { apply: change, confirm } })
      if (s) onApplied(s, change.kind === 'remove' ? 'Eintrag entfernt' : change.kind === 'restore' ? 'Frühere Fassung wiederhergestellt' : 'fstab gespeichert und eingehängt')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && /inzwischen geändert/.test(e.message)) onConflict()
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!check.ok)
    return (
      <ConfirmDialog
        open
        title={title}
        body={
          <div className="flex flex-col gap-2">
            <p className="m-0">Das geht so nicht:</p>
            <Diagnostics items={check.diagnostics} />
          </div>
        }
        confirm="Schließen"
        onConfirm={onClose}
        onClose={onClose}
      />
    )
  return (
    <Modal open onClose={onClose} title={title} wide>
      <DiffView before={check.before} after={check.after} />
      <Diagnostics items={check.diagnostics} />
      <div className="text-[13px]">
        <p className="m-0 mb-1 text-muted">Was passiert:</p>
        <ol className="m-0 flex list-decimal flex-col gap-0.5 pl-5" aria-label="Schritte">
          {check.actions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ol>
        <p className="m-0 mt-2 text-[12px] text-muted">Schlägt ein Schritt nach dem Schreiben fehl, stellt Quadeck die vorherige fstab wieder her.</p>
      </div>
      {critical && (
        <label className="flex items-start gap-2 rounded-[10px] border border-[rgba(210,153,34,.5)] p-3 text-[13px] text-[#e3b341]">
          <input type="checkbox" className="mt-[3px]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>
            {check.bootCritical.join(', ')} hat kein „nofail“: Fehlt die Platte beim Start, hält der Server im Notfallmodus an und ist erst nach einem Eingriff an der Konsole wieder erreichbar. Ich will das trotzdem so.
          </span>
        </label>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Abbrechen
        </button>
        <button type="button" className={change.kind === 'remove' ? 'btn danger' : 'btn primary'} disabled={busy || (critical && !confirm)} onClick={() => void apply()}>
          {busy ? 'Wird angewendet …' : change.kind === 'remove' ? 'Entfernen' : 'Prüfen und speichern'}
        </button>
      </div>
    </Modal>
  )
}
