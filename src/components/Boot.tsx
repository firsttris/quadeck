import { useCallback, useEffect, useState } from 'react'
import { diskSize } from '~/lib/format'
import { useT } from '~/i18n'
import { KERNEL_FLAVORS, describeTimeout, timeoutChoices, kernelRemoveProblem, parseCmdline, type BootEntry, type BootState, type KernelFlavor } from '~/shared/boot'
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
  const t = useT()
  const b = t.boot
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
      if (!r.ok) throw new Error(d.error ?? t.common.http(r.status))
      setState(d)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [t])
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
      <section className="panel flex flex-col items-center gap-2 p-10 text-center" aria-label={b.rebooting}>
        <Glyph name="restart" size={28} />
        <div className="font-medium">{b.serverRestarting}</div>
        <p className="m-0 text-[13px] text-muted">{b.reloadsWhenBack}</p>
      </section>
    )

  const sd = state?.loader === 'systemd-boot'
  const def = state?.entries.find((e) => e.isDefault)
  const oneshot = state?.entries.find((e) => e.isOneshot)
  const params = state ? parseCmdline(state.cmdline) : []

  return (
    <>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">{b.reading}</p>}
      {state && (
        <>
          {state.warnings.length > 0 && (
            <section className={`panel flex flex-col gap-1.5 px-[18px] py-4 ${state.warnings.some((w) => w.level === 'critical') ? 'alertcard' : ''}`} aria-label={b.hints}>
              {state.warnings.map((w) => (
                <p key={w.text} className={`m-0 text-[13px] ${WARN_COLOR[w.level]}`}>
                  {w.text}
                </p>
              ))}
            </section>
          )}

          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="panel flex flex-col gap-3 p-[18px]" aria-label={b.reboot}>
              <h2 className="h2">{b.reboot}</h2>
              {rebootReason && <p className="m-0 text-[13px] text-[#e3b341]">{b.recommended(rebootReason)}</p>}
              <p className="m-0 text-[13px] text-muted">
                {b.rebootText(def ? `${def.title}${def.version ? ` ${def.version}` : ''}` : undefined)}
                {jobs.running && <span className="text-[#e3b341]">{b.jobRunning(jobs.running.title)}</span>}
              </p>
              {oneshot && (
                <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]">
                  {b.oneshotNext}{' '}
                  <span className="font-medium">
                    {oneshot.title}
                    {oneshot.version ? ` ${oneshot.version}` : ''}
                  </span>
                  {!readonly && (
                    <button type="button" className="btn sm" disabled={!!busy} onClick={() => void change('oneshot', { cancelOneshot: true }, b.oneshotCancelled)}>
                      {b.undo}
                    </button>
                  )}
                </p>
              )}
              {!readonly && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn primary" onClick={() => setReboot({})}>
                    <Glyph name="restart" size={15} /> {b.rebootDots}
                  </button>
                  {state.firmwareSetup && (
                    <button type="button" className="btn" onClick={() => setReboot({ firmware: true })}>
                      {b.uefiDots}
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="panel flex flex-col gap-2 p-[18px] text-[13px]" aria-label={b.bootloader}>
              <h2 className="h2">{b.bootloader}</h2>
              {state.loader === 'systemd-boot' ? (
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                  <dt className="text-muted">systemd-boot</dt>
                  <dd className="m-0 font-mono">
                    {state.runningVersion ?? '–'}
                    {state.espVersion && state.espVersion !== state.runningVersion ? b.onEsp(state.espVersion) : ''}
                  </dd>
                  {state.firmware && (
                    <>
                      <dt className="text-muted">{b.firmware}</dt>
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
                      <dd className="m-0">{b.freeOf(diskSize(state.boot.free), diskSize(state.boot.size))}</dd>
                    </>
                  )}
                  <dt className="text-muted">{b.menu}</dt>
                  <dd className="m-0 flex flex-wrap items-center gap-2">
                    {readonly ? (
                      describeTimeout(state.timeout)
                    ) : (
                      <select
                        className="field !w-auto max-w-full !py-1"
                        aria-label={b.menuTimeout}
                        value={state.timeout === undefined || state.timeout === 0 ? 'menu-hidden' : String(state.timeout)}
                        disabled={!!busy}
                        onChange={(e) => void change('timeout', { timeout: e.target.value }, b.timeoutSaved)}
                      >
                        {!timeoutChoices().some((c) => c.value === String(state.timeout)) && state.timeout !== undefined && state.timeout !== 0 && <option value={String(state.timeout)}>{describeTimeout(state.timeout)}</option>}
                        {timeoutChoices().map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="text-[12px] text-muted">{state.timeoutSource === 'efi' ? b.setByBootctl : state.timeoutSource === 'loader.conf' ? b.fromLoaderConf : ''}</span>
                  </dd>
                </dl>
              ) : (
                <p className="m-0 text-muted">{state.loader === 'grub' ? b.grub : b.noSystemdBoot}</p>
              )}
              {sd && !readonly && state.warnings.some((w) => w.text.includes('bootctl update')) && (
                <button type="button" className="btn sm self-start" disabled={!!busy} onClick={() => void change('update', { update: true }, b.updated)}>
                  {b.updateLoader}
                </button>
              )}
            </section>
          </div>

          {sd && (
            <section className="panel relative flex flex-col overflow-x-auto" aria-label={b.entriesLabel}>
              <h2 className="h2 px-[18px] pt-4 pb-2">{b.entries}</h2>
              <table className="tbl">
                <tbody>
                  {state.entries.map((e) => (
                    <tr key={e.id} data-testid="boot-entry">
                      <td>
                        <div className="font-medium">{e.title}</div>
                        <div className="font-mono text-[12px] text-muted">{e.version ?? e.id}</div>
                        {e.missing.length > 0 && <div className="text-[12px] text-[#ff8a80]">{b.missing(e.missing.join(', '))}</div>}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          {e.isDefault && <Pill tone="ok">{b.default}</Pill>}
                          {e.isSelected && <span className="chip">{b.running}</span>}
                          {e.isOneshot && <span className="chip q">{b.nextBoot}</span>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {!readonly && e.type !== 'auto' && (
                          <div className="inline-flex gap-1.5">
                            {!e.isDefault && (
                              <button type="button" className="btn sm" disabled={!!busy || e.missing.length > 0} onClick={() => void change('default', { default: e.id }, b.nowDefault(`${e.title} ${e.version ?? ''}`))}>
                                {b.makeDefault}
                              </button>
                            )}
                            {e.missing.length > 0 && !e.isDefault && !e.isSelected ? (
                              <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => void change('entry', { removeEntry: e.id }, b.entryRemoved(e.title))} aria-label={b.removeEntryFor(e.title)}>
                                {b.removeEntry}
                              </button>
                            ) : (
                              <button type="button" className="btn sm" disabled={e.missing.length > 0} onClick={() => setReboot({ entry: e })} aria-label={b.bootOnceWith(`${e.title} ${e.version ?? ''}`)}>
                                {b.bootOnce}
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
            <section className="panel relative flex flex-col overflow-x-auto" aria-label={b.kernel}>
              <div className="px-[18px] pt-4 pb-2">
                <h2 className="h2">{b.kernel}</h2>
                <p className="m-0 mt-1 text-[12px] text-muted">
                  {b.kernelHint}
                  {state.dkms ? b.dkmsHint : ''}
                </p>
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
                            {k.running && <span className="chip">{b.running}</span>}
                            {k.installed ? <Pill tone="ok">{k.version ?? b.installed}</Pill> : <span className="text-[12px] text-muted">{b.notInstalled}</span>}
                            {k.installed && !k.entries.length && <Pill tone="warn">{b.noEntry}</Pill>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {!readonly && (
                            <div className="inline-flex gap-1.5">
                              {!k.installed && (
                                <button type="button" className="btn sm" disabled={!!jobs.running} onClick={() => void jobs.start({ kind: 'kernel-install', flavor: k.pkg })}>
                                  {b.install}
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
                                      if (!r.ok) throw new Error(d.error ?? t.common.http(r.status))
                                      setEntryPreview({ pkg: k.pkg, ...d })
                                    } catch (e) {
                                      say((e as Error).message, 'bad')
                                    }
                                  }}
                                >
                                  {b.createEntryDots}
                                </button>
                              )}
                              {k.installed && (
                                <button type="button" className="btn sm" disabled={!!removeProblem || !!jobs.running} title={removeProblem} onClick={() => setRemoveKernel(k.pkg)} aria-label={b.removeKernel(k.pkg)}>
                                  {b.removeDots}
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

          <section className="panel flex flex-col" aria-label={b.paramsLabel}>
            <div className="px-[18px] pt-4 pb-2">
              <h2 className="h2">{b.paramsTitle}</h2>
              <p className="m-0 mt-1 text-[12px] text-muted">
                {b.paramsFrom} <span className="font-mono">/proc/cmdline</span>
                {b.paramsChange}{' '}
                {sd
                  ? b.paramsSd(<span className="font-mono">options</span>, <span className="font-mono">{state.boot?.path ?? '/boot'}/loader/entries/</span>, <span className="font-mono">/etc/kernel/cmdline</span>)
                  : b.paramsGrub(<span className="font-mono">/etc/default/grub</span>)}
                {b.paramsAfter}
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
        <Modal open onClose={() => setEntryPreview(null)} title={b.createEntryTitle(entryPreview.pkg)}>
          <p className="m-0 text-[13px]">
            {b.newFile} <span className="font-mono">{entryPreview.path}</span>
            {b.newFileText}
          </p>
          <pre className="joblog !min-h-0 whitespace-pre-wrap" aria-label={b.newEntry}>
            {entryPreview.content}
          </pre>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setEntryPreview(null)}>
              {t.common.cancel}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!busy}
              onClick={async () => {
                await change('entry', { createEntry: entryPreview.pkg }, b.entryCreated(entryPreview.pkg))
                setEntryPreview(null)
              }}
            >
              {t.common.create}
            </button>
          </div>
        </Modal>
      )}

      {removeKernel && (
        <ConfirmDialog
          open
          title={b.removeKernelTitle(removeKernel)}
          body={<p className="m-0 text-[13px]">{b.removeKernelBody(removeKernel)}</p>}
          confirm={t.common.remove}
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
          title={reboot.firmware ? b.rebootUefiTitle : reboot.entry ? b.rebootOnceTitle : b.rebootServerTitle}
          body={
            <div className="flex flex-col gap-2 text-[13px]">
              {reboot.entry && (
                <p className="m-0">
                  {b.startsOnceWith}{' '}
                  <span className="font-medium">
                    {reboot.entry.title} {reboot.entry.version}
                  </span>
                  {b.startsOnceAfter}
                </p>
              )}
              {reboot.firmware && <p className="m-0">{b.firmwareStays}</p>}
              <p className="m-0">{b.allStopped}</p>
              {jobs.running && <p className="m-0 text-[#e3b341]">{b.jobAborted(jobs.running.title)}</p>}
            </div>
          }
          confirm={reboot.firmware ? b.rebootFirmware : b.rebootNow}
          danger
          onConfirm={() => void doReboot()}
          onClose={() => setReboot(null)}
        />
      )}
    </>
  )
}
