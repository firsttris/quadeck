import { useCallback, useEffect, useState } from 'react'
import { diskSize } from '~/lib/format'
import {
  KERNEL_FLAVORS,
  copyEntryContent,
  copyEntryName,
  describeTimeout,
  isEditableEntry,
  newEntryContent,
  timeoutChoices,
  kernelRemoveProblem,
  parseCmdline,
  type BootEntry,
  type BootEntryFile,
  type BootState,
  type KernelFlavor,
} from '~/shared/boot'
import { useActions } from './Actions'
import { Glyph } from './Glyph'
import { useJobs } from './Jobs'
import { BootEntryEditor, RenameEntry, type EntryEditorInit } from './BootEntryEditor'
import { ConfirmDialog, Modal } from './Modal'
import { RowMenu } from './RowMenu'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'
import { rich } from '~/i18n'

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
  const [editor, setEditor] = useState<EntryEditorInit | null>(null)
  const [rename, setRename] = useState<string | null>(null)
  const [remove, setRemove] = useState<BootEntry | null>(null)
  const [test, setTest] = useState<BootEntry | null>(null)
  const [waiting, waitForServer] = useComeBack()

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/boot')
      const d = (await r.json()) as BootState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
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

  const entriesDir = () => {
    const e = state?.entries.find(isEditableEntry)
    return e?.path ? e.path.replace(/\/[^/]+$/, '') : `${state?.boot?.path ?? '/boot'}/loader/entries`
  }
  const taken = () => state?.entries.map((e) => e.id) ?? []

  /** Edit opens a copy for the default and the running entry: test it once before it becomes the default. */
  const openEntry = async (e: BootEntry, copy: boolean) => {
    try {
      const r = await fetch(`/api/boot?entry=${encodeURIComponent(e.id)}`)
      const f = (await r.json()) as BootEntryFile & { error?: string }
      if (!r.ok) throw new Error(f.error ?? m.common_http({ status: r.status }))
      if (copy || f.locked)
        setEditor({
          kind: 'create',
          title: m.boot_editor_copyTitle({ id: e.id }),
          name: copyEntryName(e.id, taken()),
          content: copyEntryContent(f.content, e.id),
          dir: entriesDir(),
          note: copy ? undefined : m.boot_editor_lockedNote({ id: e.id }),
        })
      else setEditor({ kind: 'edit', title: m.boot_editor_editTitle({ id: e.id }), name: e.id, content: f.content, dir: entriesDir(), file: f })
    } catch (err) {
      say((err as Error).message, 'bad')
    }
  }

  const newEntry = () => {
    let name = 'new-entry.conf'
    for (let i = 2; taken().includes(name); i++) name = `new-entry-${i}.conf`
    setEditor({ kind: 'create', title: m.boot_editor_newTitle(), name, content: newEntryContent(state?.entries.find((e) => e.isDefault)), dir: entriesDir() })
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
      <section className="panel flex flex-col items-center gap-2 p-10 text-center" aria-label={m.boot_rebooting()}>
        <Glyph name="restart" size={28} />
        <div className="font-medium">{m.boot_serverRestarting()}</div>
        <p className="m-0 text-[13px] text-muted">{m.boot_reloadsWhenBack()}</p>
      </section>
    )

  const sd = state?.loader === 'systemd-boot'
  const def = state?.entries.find((e) => e.isDefault)
  const oneshot = state?.entries.find((e) => e.isOneshot)
  const params = state ? parseCmdline(state.cmdline) : []

  return (
    <>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">{m.boot_reading()}</p>}
      {state && (
        <>
          {state.warnings.length > 0 && (
            <section className={`panel flex flex-col gap-1.5 px-[18px] py-4 ${state.warnings.some((w) => w.level === 'critical') ? 'alertcard' : ''}`} aria-label={m.boot_hints()}>
              {state.warnings.map((w) => (
                <p key={w.text} className={`m-0 text-[13px] ${WARN_COLOR[w.level]}`}>
                  {w.text}
                </p>
              ))}
            </section>
          )}

          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.boot_reboot()}>
              <h2 className="h2">{m.boot_reboot()}</h2>
              {rebootReason && <p className="m-0 text-[13px] text-[#e3b341]">{m.boot_recommended({ reason: rebootReason })}</p>}
              <p className="m-0 text-[13px] text-muted">
                {m.boot_rebootText({ entry: (def ? `${def.title}${def.version ? ` ${def.version}` : ''}` : undefined) ?? '', hasEntry: String(!!(def ? `${def.title}${def.version ? ` ${def.version}` : ''}` : undefined)) })}
                {jobs.running && <span className="text-[#e3b341]">{m.boot_jobRunning({ title: jobs.running.title })}</span>}
              </p>
              {oneshot && (
                <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]">
                  {m.boot_oneshotNext()}{' '}
                  <span className="font-medium">
                    {oneshot.title}
                    {oneshot.version ? ` ${oneshot.version}` : ''}
                  </span>
                  {!readonly && (
                    <button type="button" className="btn sm" disabled={!!busy} onClick={() => void change('oneshot', { cancelOneshot: true }, m.boot_oneshotCancelled())}>
                      {m.boot_undo()}
                    </button>
                  )}
                </p>
              )}
              {!readonly && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn primary" onClick={() => setReboot({})}>
                    <Glyph name="restart" size={15} /> {m.boot_rebootDots()}
                  </button>
                  {state.firmwareSetup && (
                    <button type="button" className="btn" onClick={() => setReboot({ firmware: true })}>
                      {m.boot_uefiDots()}
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="panel flex flex-col gap-2 p-[18px] text-[13px]" aria-label={m.boot_bootloader()}>
              <h2 className="h2">{m.boot_bootloader()}</h2>
              {state.loader === 'systemd-boot' ? (
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                  <dt className="text-muted">systemd-boot</dt>
                  <dd className="m-0 font-mono">
                    {state.runningVersion ?? '–'}
                    {state.espVersion && state.espVersion !== state.runningVersion ? m.boot_onEsp({ path: state.espVersion }) : ''}
                  </dd>
                  {state.firmware && (
                    <>
                      <dt className="text-muted">{m.boot_firmware()}</dt>
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
                      <dd className="m-0">{m.boot_freeOf({ free: diskSize(state.boot.free), size: diskSize(state.boot.size) })}</dd>
                    </>
                  )}
                  <dt className="text-muted">{m.boot_menu()}</dt>
                  <dd className="m-0 flex flex-wrap items-center gap-2">
                    {readonly ? (
                      describeTimeout(state.timeout)
                    ) : (
                      <select
                        className="field !w-auto max-w-full !py-1"
                        aria-label={m.boot_menuTimeout()}
                        value={state.timeout === undefined || state.timeout === 0 ? 'menu-hidden' : String(state.timeout)}
                        disabled={!!busy}
                        onChange={(e) => void change('timeout', { timeout: e.target.value }, m.boot_timeoutSaved())}
                      >
                        {!timeoutChoices().some((c) => c.value === String(state.timeout)) && state.timeout !== undefined && state.timeout !== 0 && <option value={String(state.timeout)}>{describeTimeout(state.timeout)}</option>}
                        {timeoutChoices().map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="text-[12px] text-muted">{state.timeoutSource === 'efi' ? m.boot_setByBootctl() : state.timeoutSource === 'loader.conf' ? m.boot_fromLoaderConf() : ''}</span>
                  </dd>
                </dl>
              ) : (
                <p className="m-0 text-muted">{state.loader === 'grub' ? m.boot_grub() : m.boot_noSystemdBoot()}</p>
              )}
              {sd && !readonly && state.warnings.some((w) => w.text.includes('bootctl update')) && (
                <button type="button" className="btn sm self-start" disabled={!!busy} onClick={() => void change('update', { update: true }, m.boot_updated())}>
                  {m.boot_updateLoader()}
                </button>
              )}
            </section>
          </div>

          {sd && (
            <section className="panel relative flex flex-col overflow-x-auto" aria-label={m.boot_entriesLabel()}>
              <div className="flex items-center justify-between gap-3 px-[18px] pt-4 pb-2">
                <h2 className="h2">{m.boot_entries()}</h2>
                {!readonly && state.entries.some(isEditableEntry) && (
                  <button type="button" className="btn sm" onClick={newEntry}>
                    {m.boot_editor_newDots()}
                  </button>
                )}
              </div>
              <table className="tbl">
                <tbody>
                  {state.entries.map((e) => (
                    <tr key={e.id} data-testid="boot-entry">
                      <td>
                        <div className="font-medium">{e.title}</div>
                        <div className="font-mono text-[12px] text-muted">{e.version ?? e.id}</div>
                        {e.missing.length > 0 && <div className="text-[12px] text-[#ff8a80]">{m.boot_missing({ files: e.missing.join(', ') })}</div>}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          {e.isDefault && <Pill tone="ok">{m.boot_default()}</Pill>}
                          {e.isSelected && <span className="chip">{m.boot_running()}</span>}
                          {e.isOneshot && <span className="chip q">{m.boot_nextBoot()}</span>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {!readonly && e.type !== 'auto' && (
                          <div className="inline-flex gap-1.5">
                            {!e.isDefault && (
                              <button type="button" className="btn sm" disabled={!!busy || e.missing.length > 0} onClick={() => void change('default', { default: e.id }, m.boot_nowDefault({ name: `${e.title} ${e.version ?? ''}` }))}>
                                {m.boot_makeDefault()}
                              </button>
                            )}
                            <button type="button" className="btn sm" disabled={e.missing.length > 0} onClick={() => setReboot({ entry: e })} aria-label={m.boot_bootOnceWith({ name: `${e.title} ${e.version ?? ''}` })}>
                              {m.boot_bootOnce()}
                            </button>
                            {isEditableEntry(e) && (
                              <RowMenu
                                label={m.boot_editor_actions({ title: e.title })}
                                items={[
                                  { label: e.isDefault || e.isSelected ? m.boot_editor_editCopy() : m.boot_editor_edit(), onSelect: () => void openEntry(e, false) },
                                  { label: m.boot_editor_copy(), onSelect: () => void openEntry(e, true) },
                                  { label: m.boot_editor_rename(), onSelect: () => setRename(e.id) },
                                  { label: m.common_deleteDots(), danger: true, disabled: e.isDefault || e.isSelected || e.isOneshot, separator: true, onSelect: () => setRemove(e) },
                                ]}
                              />
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
            <section className="panel relative flex flex-col overflow-x-auto" aria-label={m.boot_kernel()}>
              <div className="px-[18px] pt-4 pb-2">
                <h2 className="h2">{m.boot_kernel()}</h2>
                <p className="m-0 mt-1 text-[12px] text-muted">
                  {m.boot_kernelHint()}
                  {state.dkms ? m.boot_dkmsHint() : ''}
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
                            {k.running && <span className="chip">{m.boot_running()}</span>}
                            {k.installed ? <Pill tone="ok">{k.version ?? m.boot_installed()}</Pill> : <span className="text-[12px] text-muted">{m.boot_notInstalled()}</span>}
                            {k.installed && !k.entries.length && <Pill tone="warn">{m.boot_noEntry()}</Pill>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {!readonly && (
                            <div className="inline-flex gap-1.5">
                              {!k.installed && (
                                <button type="button" className="btn sm" disabled={!!jobs.running} onClick={() => void jobs.start({ kind: 'kernel-install', flavor: k.pkg })}>
                                  {m.boot_install()}
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
                                      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
                                      setEntryPreview({ pkg: k.pkg, ...d })
                                    } catch (e) {
                                      say((e as Error).message, 'bad')
                                    }
                                  }}
                                >
                                  {m.boot_createEntryDots()}
                                </button>
                              )}
                              {k.installed && (
                                <button type="button" className="btn sm" disabled={!!removeProblem || !!jobs.running} title={removeProblem} onClick={() => setRemoveKernel(k.pkg)} aria-label={m.boot_removeKernel({ pkg: k.pkg })}>
                                  {m.boot_removeDots()}
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

          <section className="panel flex flex-col" aria-label={m.boot_paramsLabel()}>
            <div className="px-[18px] pt-4 pb-2">
              <h2 className="h2">{m.boot_paramsTitle()}</h2>
              <p className="m-0 mt-1 text-[12px] text-muted">
                {m.boot_paramsFrom()} <span className="font-mono">/proc/cmdline</span>
                {m.boot_paramsChange()}{' '}
                {sd
                  ? rich(m.boot_paramsSd, {
                      options: <span className="font-mono">options</span>,
                      dir: <span className="font-mono">{state.boot?.path ?? '/boot'}/loader/entries/</span>,
                      cmdline: <span className="font-mono">/etc/kernel/cmdline</span>,
                    })
                  : rich(m.boot_paramsGrub, { file: <span className="font-mono">/etc/default/grub</span> })}
                {m.boot_paramsAfter()}
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
        <Modal open onClose={() => setEntryPreview(null)} title={m.boot_createEntryTitle({ pkg: entryPreview.pkg })}>
          <p className="m-0 text-[13px]">
            {m.boot_newFile()} <span className="font-mono">{entryPreview.path}</span>
            {m.boot_newFileText()}
          </p>
          <pre className="joblog !min-h-0 whitespace-pre-wrap" aria-label={m.boot_newEntry()}>
            {entryPreview.content}
          </pre>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setEntryPreview(null)}>
              {m.common_cancel()}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!busy}
              onClick={async () => {
                await change('entry', { createEntry: entryPreview.pkg }, m.boot_entryCreated({ pkg: entryPreview.pkg }))
                setEntryPreview(null)
              }}
            >
              {m.common_create()}
            </button>
          </div>
        </Modal>
      )}

      {editor && (
        <BootEntryEditor
          init={editor}
          onClose={() => setEditor(null)}
          onSaved={(id, s) => {
            setEditor(null)
            setState(s)
            say(m.boot_editor_saved({ id }))
            const e = s.entries.find((x) => x.id === id)
            if (e && !e.isDefault && !e.isSelected && !e.missing.length) setTest(e)
          }}
        />
      )}

      {rename && (
        <RenameEntry
          id={rename}
          onClose={() => setRename(null)}
          onDone={(to, s) => {
            say(m.boot_editor_renamed({ from: rename, to }))
            setRename(null)
            setState(s)
          }}
        />
      )}

      {remove && (
        <ConfirmDialog
          open
          title={m.boot_editor_deleteTitle({ id: remove.id })}
          body={<p className="m-0 text-[13px]">{m.boot_editor_deleteBody({ path: remove.path ?? remove.id })}</p>}
          confirm={m.common_delete()}
          danger
          onConfirm={() => {
            const e = remove
            setRemove(null)
            void change('entry', { removeEntry: e.id }, m.boot_entryRemoved({ title: e.title }))
          }}
          onClose={() => setRemove(null)}
        />
      )}

      {test && (
        <Modal open title={m.boot_editor_testTitle({ id: test.id })} onClose={() => setTest(null)}>
          <p className="m-0 text-[13px]">{m.boot_editor_testText()}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setTest(null)}>
              {m.boot_editor_later()}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setReboot({ entry: test })
                setTest(null)
              }}
            >
              {m.boot_bootOnce()}
            </button>
          </div>
        </Modal>
      )}

      {removeKernel && (
        <ConfirmDialog
          open
          title={m.boot_removeKernelTitle({ pkg: removeKernel })}
          body={<p className="m-0 text-[13px]">{m.boot_removeKernelBody({ pkg: removeKernel })}</p>}
          confirm={m.common_remove()}
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
          title={reboot.firmware ? m.boot_rebootUefiTitle() : reboot.entry ? m.boot_rebootOnceTitle() : m.boot_rebootServerTitle()}
          body={
            <div className="flex flex-col gap-2 text-[13px]">
              {reboot.entry && (
                <p className="m-0">
                  {m.boot_startsOnceWith()}{' '}
                  <span className="font-medium">
                    {reboot.entry.title} {reboot.entry.version}
                  </span>
                  {m.boot_startsOnceAfter()}
                </p>
              )}
              {reboot.firmware && <p className="m-0">{m.boot_firmwareStays()}</p>}
              <p className="m-0">{m.boot_allStopped()}</p>
              {jobs.running && <p className="m-0 text-[#e3b341]">{m.boot_jobAborted({ title: jobs.running.title })}</p>}
            </div>
          }
          confirm={reboot.firmware ? m.boot_rebootFirmware() : m.boot_rebootNow()}
          danger
          onConfirm={() => void doReboot()}
          onClose={() => setReboot(null)}
        />
      )}
    </>
  )
}
