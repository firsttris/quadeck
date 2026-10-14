import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { Glyph } from '~/components/Glyph'
import { PageHeader } from '~/components/PageHeader'
import { HiddenServices, Services, useEditKey } from '~/components/Services'
import { useToast } from '~/components/Toast'
import { api } from '~/lib/api'
import { useLive } from '~/lib/live'
import { getDashboardLayout } from '~/lib/server-fns'
import { m } from '~/paraglide/messages'
import type { DashboardLayout, GridItem, IconSize } from '~/shared/layout'

export const Route = createFileRoute('/_app/services')({
  loader: () => getDashboardLayout(),
  component: ServicesPage,
})

/**
 * Only the services and links, over the whole width: the start page for opening apps. The tiles,
 * their layout and the icon size are the same as in the services widget on the overview.
 */
function ServicesPage() {
  const { snapshot } = useLive()
  const initial = Route.useLoaderData()
  const [layout, setLayout] = useState<DashboardLayout>(initial)
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')
  const say = useToast()
  useEditKey(() => setEditing((v) => !v))
  const count = snapshot.services.reduce((n, g) => n + g.items.length, 0)

  const saveTiles = useCallback(
    (bp: string, items: GridItem[]) => {
      setLayout((l) => {
        const byId = new Map((l.layouts.tiles[bp] ?? []).map((it) => [it.i, it]))
        for (const it of items) byId.set(it.i, it)
        return { ...l, layouts: { ...l.layouts, tiles: { ...l.layouts.tiles, [bp]: [...byId.values()] } } }
      })
      api('/api/layout', { body: { scope: 'tiles', breakpoint: bp, items } }).catch((e) => say(m.overview_edit_layoutNotSaved({ msg: (e as Error).message }), 'bad'))
    },
    [say],
  )
  const setIconSize = (iconSize: IconSize) => {
    setLayout((l) => ({ ...l, iconSize }))
    api('/api/layout', { body: { iconSize } }).catch((e) => say(m.overview_edit_layoutNotSaved({ msg: (e as Error).message }), 'bad'))
  }

  return (
    <>
      <PageHeader title={m.services_page_title()} subtitle={m.services_page_subtitle({ n: count })}>
        {!editing && (
          <input
            type="search"
            className="field sm w-full sm:w-60"
            placeholder={m.services_page_search()}
            aria-label={m.services_page_search()}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <button type="button" className={`btn sm ${editing ? 'primary' : ''}`} onClick={() => setEditing(!editing)} aria-pressed={editing} title={m.overview_edit_toggleTitle()}>
          <Glyph name={editing ? 'check' : 'edit'} size={14} strokeWidth={2} />
          {editing ? m.overview_edit_done() : m.overview_edit_edit()}
        </button>
      </PageHeader>
      {editing && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-accent/35 bg-accent/8 px-[14px] py-[10px] text-[13px] text-accent-soft" role="status">
          <span className="grow">{m.services_page_editHelp()}</span>
          <HiddenServices hidden={snapshot.hiddenServices} />
        </div>
      )}
      <div className="panel">
        <Services groups={snapshot.services} editing={editing} saved={layout.layouts.tiles} onSave={saveTiles} iconSize={layout.iconSize} onIconSize={setIconSize} heading={false} query={query} />
      </div>
    </>
  )
}
