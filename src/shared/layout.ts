// Dashboard layout as stored and exchanged with the UI.
// Two scopes: "page" (the cards on the overview) and "tiles" (service and
// link tiles inside the Services card, keyed by service key). Each scope keeps
// one layout per breakpoint. h = 0 means "automatic height" (measured).

export type LayoutScope = 'page' | 'tiles'

export interface GridItem {
  i: string
  x: number
  y: number
  w: number
  h: number
}

import type { WidgetInstance } from './widgets'

export interface DashboardLayout {
  layouts: Record<LayoutScope, Record<string, GridItem[]>>
  hidden: string[] // ids of hidden cards
  /** Widgets added from the catalog, in the order they were added. */
  widgets: WidgetInstance[]
  /** Size of the icons on the service tiles, for all of them. */
  iconSize: IconSize
}

export const ICON_SIZES = ['sm', 'md', 'lg'] as const
export type IconSize = (typeof ICON_SIZES)[number]
export const isIconSize = (v: unknown): v is IconSize => ICON_SIZES.includes(v as IconSize)

export const EMPTY_LAYOUT: DashboardLayout = { layouts: { page: {}, tiles: {} }, hidden: [], widgets: [], iconSize: 'md' }
