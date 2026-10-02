import { useCallback, useEffect, useState } from 'react'
import { diskSize } from '~/lib/format'
import { KERNEL_FLAVORS, TIMEOUT_CHOICES, describeTimeout, kernelRemoveProblem, parseCmdline, type BootEntry, type BootState, type KernelFlavor } from '~/shared/boot'
import { useActions } from './Actions'
import { Glyph } from './Glyph'
import { useJobs } from './Jobs'
import { ConfirmDialog, Modal } from './Modal'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

const WARN_COLOR = { critical: 'text-[#ff8a80]', warning: 'text-[#e3b341]', info: 'text-muted' } as const

/** Waits until the server is gone and back, then reloads the page. */
function useComeBack() {
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (!waiting) return
    let wasDown = false
    const t = setInterval(async () => {
      try {
        const r = await fetch('/login', { cache: 'no-store', signal: AbortSignal.timeout(2500) })
        if (r.ok && wasDown) window.location.reload()
      } catch {
        wasDown = true
      }
    }, 3000)
    return () => clearInterval(t)
  }, [waiting])
  return [waiting, () => setWaiting(true)] as const
}

/**
 * systemd-boot: entries, default, timeout, the reboot (also once into another
 * entry or the firmware setup), and the running kernel command line explained.
 */
export function BootView({ rebootReason }: { rebootReason?: string }) {
  const { readonly } = useActions()
  const say = useToast()
  const guarded = useGuardedApi()
  const jobs = useJobs()
  const [state, setState] = useState<BootState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [reboot, setReboot] = useState<null | { entry?: BootEntry; firmware?: boolean }>(null)
  const [entryPreview, setEntryPreview] = useState<null | { pkg: KernelFlavor; path: string; content: string }>(null)
  const [removeKernel, setRemoveKernel] = useState<KernelFlavor | null>(null)
  const [waiting, waitForServer] = useComeBack()

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/boot')
      const d = (await r.json()) as BootState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setState(d)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, jobs.finished])

  const change = async (what: string, body: Record<string, unknown>, msg: string) => {
    setBusy(what)
    try {
      const s = await guarded<BootState>('/api/boot', { body })
      if (s) {
        setState(s)
        say(msg)
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy('')
    }
  }

  const doReboot = async () => {
    const r = reboot!
    setReboot(null)
    try {
      const res = await guarded<{ at: number }>('/api/boot', { body: { reboot: { entry: r.entry?.id, firmware: r.firmware } } })
      if (res) waitForServer()
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  if (waiting)
    return (
      <section className="panel flex flex-col items-center gap-2 p-10 text-center" aria-label="Neustart läuft">
        <Glyph name="restart" size={28} />
        <div className="font-medium">Der Server startet neu …</div>
        <p className="m-0 text-[13px] text-muted">Die Seite lädt sich neu, sobald er wieder erreichbar ist. Das dauert meist ein bis zwei Minuten.</p>
      </section>
    )

  const sd = state?.loader === 'systemd-boot'
  const def = state?.entries.find((e) => e.isDefault)
  const oneshot = state?.entries.find((e) => e.isOneshot)
  const params = state ? parseCmdline(state.cmdline) : []

  return (
    <>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">Wird gelesen …</p>}
      {state && (
        <>
          {state.warnings.length > 0 && (
            <section className={`panel flex flex-col gap-1.5 px-[18px] py-4 ${state.warnings.some((w) => w.level === 'critical') ? 'alertcard' : ''}`} aria-label="Hinweise zum Start">
              {state.warnings.map((w) => (
                <p key={w.text} className={`m-0 text-[13px] ${WARN_COLOR[w.level]}`}>
                  {w.text}
                </p>
              ))}
            </section>
          )}

          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="panel flex flex-col gap-3 p-[18px]" aria-label="Neustart">
              <h2 className="h2">Neustart</h2>
              {rebootReason && <p className="m-0 text-[13px] text-[#e3b341]">Empfohlen: {rebootReason}</p>}
              <p className="m-0 text-[13px] text-muted">
                Container und Dienste werden sauber beendet und starten danach wieder{def ? ` mit „${def.title}${def.version ? ` ${def.version}` : ''}“` : ''}.
                {jobs.running && <span className="text-[#e3b341]"> Gerade läuft „{jobs.running.title}“ – besser abwarten.</span>}
              </p>
              {oneshot && (
                <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]">
                  Beim nächsten Start einmalig: <span className="font-medium">{oneshot.title}{oneshot.version ? ` ${oneshot.version}` : ''}</span>
                  {!readonly && (
                    <button type="button" className="btn sm" disabled={!!busy} onClick={() => void change('oneshot', { cancelOneshot: true }, 'Einmaliger Eintrag zurückgenommen')}>
                      Zurücknehmen
                    </button>
                  )}
                </p>
              )}
              {!readonly && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn primary" onClick={() => setReboot({})}>
                    <Glyph name="restart" size={15} /> Neu starten …
                  </button>
                  {state.firmwareSetup && (
                    <button type="button" className="btn" onClick={() => setReboot({ firmware: true })}>
                      In die UEFI-Einstellungen …
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="panel flex flex-col gap-2 p-[18px] text-[13px]" aria-label="Bootloader">
              <h2 className="h2">Bootloader</h2>
              {state.loader === 'systemd-boot' ? (
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                  <dt className="text-muted">systemd-boot</dt>
                  <dd className="m-0 font-mono">
                    {state.runningVersion ?? '–'}
                    {state.espVersion && state.espVersion !== state.runningVersion ? ` (auf der ESP: ${state.espVersion})` : ''}
                  </dd>
                  {state.firmware && (
                    <>
                      <dt className="text-muted">Firmware</dt>
                      <dd className="m-0">{state.firmware}</dd>
                    </>
                  )}
                  {state.secureBoot && (
                    <>
                      <dt className="text-muted">Secure Boot</dt>
                      <dd className="m-0">{state.secureBoot}</dd>
                    </>
                  )}
                  {state.boot && (
                    <>
                      <dt className="text-muted">{state.boot.path}</dt>
                      <dd className="m-0">
                        {diskSize(state.boot.free)} frei von {diskSize(state.boot.size)}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted">Menü</dt>
                  <dd className="m-0 flex flex-wrap items-center gap-2">
                    {readonly ? (
                      describeTimeout(state.timeout)
                    ) : (
                      <select
                        className="field !w-auto max-w-full !py-1"
                        aria-label="Wartezeit im Bootmenü"
                        value={state.timeout === undefined || state.timeout === 0 ? 'menu-hidden' : String(state.timeout)}
                        disabled={!!busy}
                        onChange={(e) => void change('timeout', { timeout: e.target.value }, 'Wartezeit gespeichert')}
                      >
                        {!TIMEOUT_CHOICES.some((c) => c.value === String(state.timeout)) && state.timeout !== undefined && state.timeout !== 0 && <option value={String(state.timeout)}>{describeTimeout(state.timeout)}</option>}
                        {TIMEOUT_CHOICES.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="text-[12px] text-muted">{state.timeoutSource === 'efi' ? 'gesetzt per bootctl' : state.timeoutSource === 'loader.conf' ? 'aus loader.conf' : ''}</span>
                  </dd>
                </dl>
              ) : (
                <p className="m-0 text-muted">{state.loader === 'grub' ? 'GRUB – Quadeck zeigt hier nur die Kernel-Parameter; Einträge und Standard verwaltet GRUB selbst.' : 'Kein systemd-boot gefunden.'}</p>
              )}
              {sd && !readonly && state.warnings.some((w) => w.text.includes('bootctl update')) && (
                <button type="button" className="btn sm self-start" disabled={!!busy} onClick={() => void change('update', { update: true }, 'systemd-boot aktualisiert')}>
                  Bootloader aktualisieren
                </button>
              )}
            </section>
          </div>

          {sd && (
            <section className="panel relative flex flex-col overflow-x-auto" aria-label="Boot-Einträge">
              <h2 className="h2 px-[18px] pt-4 pb-2">Einträge</h2>
              <table className="tbl">
                <tbody>
                  {state.entries.map((e) => (
                    <tr key={e.id} data-testid="boot-entry">
                      <td>
                        <div className="font-medium">{e.title}</div>
                        <div className="font-mono text-[12px] text-muted">{e.version ?? e.id}</div>
                        {e.missing.length > 0 && <div className="text-[12px] text-[#ff8a80]">fehlt: {e.missing.join(', ')}</div>}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          {e.isDefault && <Pill tone="ok">Standard</Pill>}
                          {e.isSelected && <span className="chip">läuft gerade</span>}
                          {e.isOneshot && <span className="chip q">nächster Start</span>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {!readonly && e.type !== 'auto' && (
                          <div className="inline-flex gap-1.5">
                            {!e.isDefault && (
                              <button type="button" className="btn sm" disabled={!!busy || e.missing.length > 0} onClick={() => void change('default', { default: e.id }, `${e.title} ${e.version ?? ''} ist jetzt Standard`)}>
                                Als Standard
                              </button>
                            )}
                            {e.missing.length > 0 && !e.isDefault && !e.isSelected ? (
                              <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => void change('entry', { removeEntry: e.id }, `Eintrag ${e.title} entfernt`)} aria-label={`Eintrag ${e.title} entfernen`}>
                                Eintrag entfernen
                              </button>
                            ) : (
                              <button type="button" className="btn sm" disabled={e.missing.length > 0} onClick={() => setReboot({ entry: e })} aria-label={`Einmalig mit ${e.title} ${e.version ?? ''} neu starten`}>
                                Einmalig damit starten …
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {state.kernels && (
            <section className="panel relative flex flex-col overflow-x-auto" aria-label="Kernel">
              <div className="px-[18px] pt-4 pb-2">
                <h2 className="h2">Kernel</h2>
                <p className="m-0 mt-1 text-[12px] text-muted">Mehrere Kernel-Varianten können nebeneinander installiert sein; mit „Einmalig damit starten“ springst du hin und her.{state.dkms ? ' DKMS-Module (z. B. NVIDIA, ZFS) werden mit den passenden Headers für jeden Kernel gebaut.' : ''}</p>
              </div>
              <table className="tbl">
                <tbody>
                  {state.kernels.map((k) => {
                    const flavor = KERNEL_FLAVORS.find((f) => f.pkg === k.pkg)!
                    const removeProblem = k.installed ? kernelRemoveProblem(k, state.kernels!) : undefined
                    return (
                      <tr key={k.pkg} data-testid="kernel">
                        <td>
                          <div className="font-medium">
                            <span className="font-mono">{k.pkg}</span> <span className="text-[12px] font-normal text-muted">{flavor.label}</span>
                          </div>
                          <div className="text-[12px] text-muted">{flavor.text}</div>
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1.5">
                            {k.running && <span className="chip">läuft gerade</span>}
                            {k.installed ? <Pill tone="ok">{k.version ?? 'installiert'}</Pill> : <span className="text-[12px] text-muted">nicht installiert</span>}
                            {k.installed && !k.entries.length && <Pill tone="warn">kein Boot-Eintrag</Pill>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {!readonly && (
                            <div className="inline-flex gap-1.5">
                              {!k.installed && (
                                <button type="button" className="btn sm" disabled={!!jobs.running} onClick={() => void jobs.start({ kind: 'kernel-install', flavor: k.pkg })}>
                                  Installieren
                                </button>
                              )}
                              {k.installed && !k.entries.length && state.canCreateEntries && (
                                <button
                                  type="button"
                                  className="btn sm primary"
                                  onClick={async () => {
                                    try {
                                      const r = await fetch(`/api/boot?entryPreview=${k.pkg}`)
                                      const d = (await r.json()) as { path: string; content: string; error?: string }
                                      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
                                      setEntryPreview({ pkg: k.pkg, ...d })
                                    } catch (e) {
                                      say((e as Error).message, 'bad')
                                    }
                                  }}
                                >
                                  Boot-Eintrag anlegen …
                                </button>
                              )}
                              {k.installed && (
                                <button type="button" className="btn sm" disabled={!!removeProblem || !!jobs.running} title={removeProblem} onClick={() => setRemoveKernel(k.pkg)} aria-label={`${k.pkg} entfernen`}>
                                  Entfernen …
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )}

          <section className="panel flex flex-col" aria-label="Kernel-Parameter">
            <div className="px-[18px] pt-4 pb-2">
              <h2 className="h2">Kernel-Parameter dieses Starts</h2>
              <p className="m-0 mt-1 text-[12px] text-muted">
                Aus <span className="font-mono">/proc/cmdline</span>. Ändern lassen sie sich {sd ? <>in der Zeile <span className="font-mono">options</span> des Eintrags unter <span className="font-mono">{state.boot?.path ?? '/boot'}/loader/entries/</span> bzw. in <span className="font-mono">/etc/kernel/cmdline</span></> : <>in <span className="font-mono">/etc/default/grub</span> (danach grub-mkconfig)</>} – wirksam nach dem nächsten Neustart.
              </p>
            </div>
            {params.map((p, i) => (
              <div key={`${p.name}${i}`} className="flex flex-wrap items-baseline gap-x-3 border-t border-line px-[18px] py-[7px] text-[13px]" data-testid="kernel-param">
                <span className="font-mono">
                  {p.name}
                  {p.value !== undefined && <span className="text-muted">={p.value}</span>}
                </span>
                <span className="text-[12px] text-muted">{p.text ?? ''}</span>
              </div>
            ))}
          </section>
        </>
      )}

      {entryPreview && (
        <Modal open onClose={() => setEntryPreview(null)} title={`Boot-Eintrag für ${entryPreview.pkg} anlegen?`}>
          <p className="m-0 text-[13px]">
            Neue Datei <span className="font-mono">{entryPreview.path}</span> – eine Kopie des Standard-Eintrags mit denselben Parametern, nur Kernel und initramfs getauscht. Bestehende Einträge bleiben unverändert.
          </p>
          <pre className="joblog !min-h-0 whitespace-pre-wrap" aria-label="Neuer Eintrag">
            {entryPreview.content}
          </pre>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setEntryPreview(null)}>
              Abbrechen
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!busy}
              onClick={async () => {
                await change('entry', { createEntry: entryPreview.pkg }, `Boot-Eintrag für ${entryPreview.pkg} angelegt`)
                setEntryPreview(null)
              }}
            >
              Anlegen
            </button>
          </div>
        </Modal>
      )}

      {removeKernel && (
        <ConfirmDialog
          open
          title={`${removeKernel} entfernen?`}
          body={<p className="m-0 text-[13px]">Entfernt das Paket {removeKernel} (und die Headers, falls installiert) mit pacman. Der Boot-Eintrag zeigt danach ins Leere und lässt sich hier entfernen.</p>}
          confirm="Entfernen"
          danger
          onConfirm={() => {
            const flavor = removeKernel
            setRemoveKernel(null)
            void jobs.start({ kind: 'kernel-remove', flavor })
          }}
          onClose={() => setRemoveKernel(null)}
        />
      )}

      {reboot && (
        <ConfirmDialog
          open
          title={reboot.firmware ? 'In die UEFI-Einstellungen neu starten?' : reboot.entry ? 'Einmalig mit diesem Eintrag neu starten?' : 'Server neu starten?'}
          body={
            <div className="flex flex-col gap-2 text-[13px]">
              {reboot.entry && (
                <p className="m-0">
                  Startet einmal mit <span className="font-medium">{reboot.entry.title} {reboot.entry.version}</span>. Beim Neustart danach gilt wieder der Standard – klappt etwas nicht, reicht ein Reset.
                </p>
              )}
              {reboot.firmware && <p className="m-0">Der Server bleibt im Firmware-Menü, bis jemand vor Ort weitermacht – übers Netz ist er dann nicht erreichbar.</p>}
              <p className="m-0">Alle Container und Dienste werden beendet. Der Server ist für ein bis zwei Minuten nicht erreichbar, auch Quadeck nicht.</p>
              {jobs.running && <p className="m-0 text-[#e3b341]">„{jobs.running.title}“ läuft noch und würde abgebrochen.</p>}
            </div>
          }
          confirm={reboot.firmware ? 'In die Firmware neu starten' : 'Jetzt neu starten'}
          danger
          onConfirm={() => void doReboot()}
          onClose={() => setReboot(null)}
        />
      )}
    </>
  )
}
