import { createContext, useContext } from "react"
import type { RunsView } from "../runs.vibe"

// What React components get: the runs layer's live queries to render and plain actions to call (features/runs/runs.ts).

const RunsContext = createContext<RunsView | null>(null)

export const RunsProvider = RunsContext.Provider

export const useRuns = (): RunsView => {
  const runs = useContext(RunsContext)
  if (runs === null) throw new Error("useRuns needs a RunsProvider: main.tsx renders one")
  return runs
}
