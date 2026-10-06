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
}

export const EMPTY_LAYOUT: DashboardLayout = { layouts: { page: {}, tiles: {} }, hidden: [], widgets: [] }
