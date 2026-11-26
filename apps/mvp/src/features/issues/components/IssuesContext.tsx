import { createContext, useContext } from "react"
import type { IssuesLayer } from "../issues.vibe"

// What React components get: the issues layer's live queries to render and plain actions to call
// (features/issues/issues.ts).

const IssuesContext = createContext<IssuesLayer | null>(null)

export const IssuesProvider = IssuesContext.Provider

export const useIssues = (): IssuesLayer => {
  const issues = useContext(IssuesContext)
  if (issues === null) throw new Error("useIssues needs an IssuesProvider: main.tsx renders one")
  return issues
}
