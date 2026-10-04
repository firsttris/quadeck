import { useState } from 'react'
import { api } from '~/lib/api'
import { num } from '~/lib/format'
import { STANDBY_MINUTES, WAKE_WARN_PER_DAY, type ApmMode, type DiskPower, type PowerSetting, type PowerState, type StandbyMinutes } from '~/shared/power'
import { useActions } from './Actions'
import { Modal } from './Modal'
import { Dot } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

export type PowerInfo = PowerState & { wakes: Record<string, number> }

const standby = (n: StandbyMinutes) => (n === 0 ? m.power_never() : n < 60 ? m.power_afterMin({ n }) : m.power_afterHours({ n: n / 60 }))
const apmLabel = (a: ApmMode) => pickMsg({ disk: m.power_apm_disk, save: m.power_apm_save, perf: m.power_apm_perf }, a)
const apmHelp = (a: ApmMode) => pickMsg({ disk: m.power_apmHelp_disk, save: m.power_apmHelp_save, perf: m.power_apmHelp_perf }, a)

/** The "Standby" line on a disk card. */
export function PowerRow({ disk, wakes, onEdit }: { disk: DiskPower; wakes?: number; onEdit?: () => void }) {
  const tooOften = wakes !== undefined && wakes > WAKE_WARN_PER_DAY
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-3 text-[13px]" data-testid="disk-power">
      <span className="label-caps">{m.power_title()}</span>
      <span className="flex items-center gap-1.5">
        <Dot tone={disk.state === 'active' ? 'ok' : 'idle'} />
        {pickMsg({ active: m.power_state_active, standby: m.power_state_standby, unknown: m.power_state_unknown }, disk.state)}
      </span>
      <span className="text-subtle">{disk.setting ? standby(disk.setting.minutes) : m.power_notSet()}</span>
      {wakes !== undefined && <span className={tooOften ? 'text-[#e3b341]' : 'text-subtle'}>{m.power_wakes({ n: num(wakes, wakes < 10 ? 1 : 0) })}</span>}
      <span className="grow" />
      {onEdit && (
        <button type="button" className="btn sm" onClick={onEdit} aria-label={m.power_editFor({ name: disk.name })}>
          {m.power_edit()}
        </button>
      )}
    </div>
  )
}

/** Standby time and APM for one disk; saved as a udev rule by serial. */
export function PowerDialog({ disk, info, onClose, onSaved }: { disk: DiskPower; info: PowerInfo; onClose: () => void; onSaved: (s: PowerInfo) => void }) {
  const guarded = useGuardedApi()
  const say = useToast()
  const { readonly } = useActions()
  const [setting, setSetting] = useState<PowerSetting>(disk.setting ?? { minutes: 20, apm: 'disk' })
  const [users, setUsers] = useState<{ command: string; unit?: string; files: number }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const wakes = info.wakes[disk.name]
  const blocked = disk.system ? m.power_blockedSystem() : disk.raid ? m.power_blockedRaid() : !disk.serial ? m.power_blockedSerial() : undefined

  const save = async (s: PowerSetting | null) => {
    setBusy(true)
    try {
      const r = await guarded<PowerState>('/api/disks/power', { body: { serial: disk.serial, setting: s } })
      if (r) {
        say(s ? m.power_saved({ name: disk.name, when: standby(s.minutes) }) : m.power_removed({ name: disk.name }))
        onSaved({ ...r, wakes: info.wakes })
        onClose()
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  const lookUsers = async () => {
    try {
      setUsers((await api<{ users: { command: string; unit?: string; files: number }[] }>(`/api/disks/power?users=${encodeURIComponent(disk.name)}`, { method: 'GET' })).users)
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  return (
    <Modal open title={m.power_dialogTitle({ name: disk.name, model: disk.model ?? '' })} onClose={onClose}>
      <p className="m-0 text-[13px] text-muted">
        {pickMsg({ active: m.power_state_active, standby: m.power_state_standby, unknown: m.power_state_unknown }, disk.state)}
        {disk.apmNow !== undefined ? ` · ${m.power_apmNow({ value: String(disk.apmNow) })}` : ''}
        {wakes !== undefined ? ` · ${m.power_wakes({ n: num(wakes, wakes < 10 ? 1 : 0) })}` : ''}
      </p>
      {wakes !== undefined && wakes > WAKE_WARN_PER_DAY && <p className="m-0 text-[13px] text-[#e3b341]">{m.power_tooOften()}</p>}
      {blocked ? (
        <p className="m-0 text-[13px]">{blocked}</p>
      ) : (
        <>
          <label className="flex flex-col gap-1.5 text-[13px]">
            {m.power_standbyAfter()}
            <select className="field" value={setting.minutes} disabled={readonly} onChange={(e) => setSetting({ ...setting, minutes: Number(e.target.value) as StandbyMinutes })}>
              {STANDBY_MINUTES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? m.power_never() : standby(n)}
                </option>
              ))}
            </select>
          </label>
          <p className="m-0 text-[12px] text-muted">{m.power_standbyHelp()}</p>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={readonly}>
            <legend className="mb-1.5 p-0 text-[13px]">{m.power_apm()}</legend>
            {(['disk', 'save', 'perf'] as const).map((a) => (
              <label key={a} className="flex items-start gap-2 text-[13px]">
                <input type="radio" name="apm" className="mt-0.5" checked={setting.apm === a} onChange={() => setSetting({ ...setting, apm: a })} />
                <span>
                  {apmLabel(a)}
                  <span className="block text-[12px] text-muted">{apmHelp(a)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {disk.usb && <p className="m-0 text-[12px] text-[#e3b341]">{m.power_usb()}</p>}
          {info.foreign.length > 0 && <p className="m-0 text-[12px] text-[#e3b341]">{m.power_foreign({ files: info.foreign.join(', ') })}</p>}
        </>
      )}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex items-center gap-2">
          <span className="grow text-[13px]">{m.power_awake()}</span>
          <button type="button" className="btn sm" onClick={() => void lookUsers()}>
            {m.power_look()}
          </button>
        </div>
        {users && users.length === 0 && <p className="m-0 text-[12px] text-muted">{m.power_noUsers()}</p>}
        {users && users.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label={m.power_awake()}>
            {users.map((u) => (
              <li key={`${u.command}-${u.unit}`} className="flex gap-2">
                <span className="font-mono">{u.command}</span>
                {u.unit && <span className="text-muted">{u.unit}</span>}
                <span className="grow" />
                <span className="text-subtle">{m.power_files({ n: u.files })}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-[12px] text-muted">{m.power_awakeHelp()}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {disk.setting && !readonly && (
          <button type="button" className="btn danger" disabled={busy} onClick={() => void save(null)}>
            {m.power_remove()}
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        {!blocked && !readonly && (
          <button type="button" className="btn primary" disabled={busy || !info.installed} onClick={() => void save(setting)}>
            {m.common_save()}
          </button>
        )}
      </div>
      <p className="m-0 font-mono text-[11px] text-muted">{info.rulesPath}</p>
    </Modal>
  )
}
