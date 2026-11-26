import { createContext, useContext } from "react"
import type { FlowsUiView } from "../flowsUi.vibe"

// What React components get: your own flows' live queries to render and plain actions to call
// (features/flows-ui/flowsUi.ts).

const FlowsUiContext = createContext<FlowsUiView | null>(null)

export const FlowsUiProvider = FlowsUiContext.Provider

export const useFlowsUi = (): FlowsUiView => {
  const flows = useContext(FlowsUiContext)
  if (flows === null) throw new Error("useFlowsUi needs a FlowsUiProvider: main.tsx renders one")
  return flows
}
