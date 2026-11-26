import { createContext, useContext } from "react"
import type { WorkbenchView } from "./store"

const WorkbenchContext = createContext<WorkbenchView | null>(null)

export const WorkbenchProvider = WorkbenchContext.Provider

export const useWorkbench = (): WorkbenchView => {
  const workbench = useContext(WorkbenchContext)
  if (workbench === null) throw new Error("useWorkbench needs a WorkbenchProvider: AppProviders.tsx renders one")
  return workbench
}

export const useWorkbenchOptional = (): WorkbenchView | null => useContext(WorkbenchContext)
