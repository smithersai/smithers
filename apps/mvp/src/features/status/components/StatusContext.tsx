import { createContext, useContext } from "react"
import type { StatusView } from "../status.vibe"

// What React components get: agent status's live queries to render and plain actions to call
// (features/status/status.vibe).

const StatusContext = createContext<StatusView | null>(null)

export const StatusProvider = StatusContext.Provider

export const useStatus = (): StatusView => {
  const status = useContext(StatusContext)
  if (status === null) throw new Error("useStatus needs a StatusProvider: main.tsx renders one")
  return status
}
