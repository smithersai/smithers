import { createContext, useContext } from "react"
import type { DocsView } from "../docs.vibe"

// What React components get: the docs layer's live query to render and its actions (features/docs/docs.ts).

const DocsContext = createContext<DocsView | null>(null)

export const DocsProvider = DocsContext.Provider

export const useDocs = (): DocsView => {
  const docs = useContext(DocsContext)
  if (docs === null) throw new Error("useDocs needs a DocsProvider: main.tsx renders one")
  return docs
}
