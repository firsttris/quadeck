import { useEffect, useState } from 'react'
import { FEATURES, installCommand, type Feature, type ManagerId } from '~/shared/packages'
import { useActions } from './Actions'
import { BusyButton, useBusy } from './Busy'
import { Glyph } from './Glyph'
import { useJobs } from './Jobs'
import { m } from '~/paraglide/messages'

/**
 * „Not installed“ with a way out: one click installs the package through
 * the package job (live output, unlock), or the command for the console.
 */
export function InstallHint({ feature, what, onInstalled }: { feature: Feature; what: string; onInstalled: () => void }) {
  const jobs = useJobs()
  const { readonly } = useActions()
  const [manager, setManager] = useState<ManagerId | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const work = useBusy()

  useEffect(() => {
    fetch('/api/system/overview')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { manager?: ManagerId | null } | null) => setManager(d?.manager ?? null))
      .catch(() => {})
  }, [])

  // Reload once our install job has ended.
  useEffect(() => {
    if (jobId && jobs.running?.id !== jobId) {
      setJobId(null)
      onInstalled()
    }
  }, [jobs.running, jobs.finished, jobId, onInstalled])

  const f = FEATURES[feature]
  return (
    <div className="flex flex-col gap-2 px-[18px] py-3 text-[13px]" data-testid={`install-${feature}`}>
      <p className="m-0 text-muted">{what}</p>
      {manager ? (
        <>
          {!readonly && (
            <BusyButton
              className="btn primary sm self-start"
              busy={work.is('install')}
              busyLabel={m.common_starting()}
              disabled={!!jobs.running || jobs.starting}
              onClick={() =>
                void work.run('install', async () => {
                  const job = await jobs.start({ kind: 'install', feature })
                  if (job) setJobId(job.id)
                })
              }
            >
              <Glyph name="download" size={14} /> {m.shell_install_install({ pkgs: (f.packages[manager].join(', ')) })}
            </BusyButton>
          )}
          <div className="text-[12px] text-muted">
            {m.shell_install_console()}
            <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-fg select-all">{installCommand(manager, feature)}</code>
          </div>
          {manager === 'rpm-ostree' && <div className="text-[12px] text-[#e3b341]">{m.shell_install_ostree()}</div>}
          {manager === 'transactional-update' && <div className="text-[12px] text-[#e3b341]">{m.shell_install_transactional()}</div>}
        </>
      ) : (
        <div className="text-[12px] text-muted">
          {m.shell_install_pkg({ list: ((Object.values(f.packages)
              .flat()
              .filter((v, i, a) => a.indexOf(v) === i))).join(m.shell_install_or()) })}
        </div>
      )}
    </div>
  )
}
