import { Link } from '@tanstack/react-router'
import { m } from '~/paraglide/messages'
import { useActions } from './Actions'
import { PageHeader } from './PageHeader'

export type UnitsTab = 'list' | 'files' | 'usage'

/**
 * Title and tabs shared by the units list, the Quadlet files and the usage over time: three views
 * of the same units, so they sit side by side instead of behind a button in a corner.
 */
export function UnitsHeader({ tab, usage = true }: { tab: UnitsTab; usage?: boolean }) {
  const { readonly } = useActions()
  return (
    <>
      <PageHeader title="Units" subtitle={m.units_subtitle()}>
        {!readonly && (
          <>
            <Link to="/systemd" search={{ new: true }} className="btn sm">
              {m.units_newUnit()}
            </Link>
            <Link to="/quadlets" search={{ new: true }} className="btn sm">
              {m.units_newContainer()}
            </Link>
          </>
        )}
      </PageHeader>
      <div role="tablist" aria-label={m.units_tabs()} className="tabbar">
        <Link to="/units" search={{}} role="tab" aria-selected={tab === 'list'} className="tab">
          {m.units_tab_list()}
        </Link>
        <Link to="/quadlets" search={{}} role="tab" aria-selected={tab === 'files'} className="tab">
          {m.units_quadletFiles()}
        </Link>
        {usage && (
          <Link to="/units" search={{ view: 'usage' }} role="tab" aria-selected={tab === 'usage'} className="tab">
            {m.usage_tab()}
          </Link>
        )}
      </div>
    </>
  )
}
