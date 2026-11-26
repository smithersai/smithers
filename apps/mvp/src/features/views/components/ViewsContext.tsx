import { createContext, useContext } from "react"
import type { ViewsView } from "../views.vibe"

// What React components get: the views layer's live query to render and plain action to call
// (features/views/views.ts).

const ViewsContext = createContext<ViewsView | null>(null)

export const ViewsProvider = ViewsContext.Provider

export const useViews = (): ViewsView => {
  const views = useContext(ViewsContext)
  if (views === null) throw new Error("useViews needs a ViewsProvider: main.tsx renders one")
  return views
}
