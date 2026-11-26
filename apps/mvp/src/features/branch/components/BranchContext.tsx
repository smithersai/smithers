import { createContext, useContext } from "react"
import type { BranchView } from "../branch.vibe"

// What the branch workspace's components get: its live query and plain actions (src/features/branch/branch.ts).

const BranchContext = createContext<BranchView | null>(null)

export const BranchProvider = BranchContext.Provider

export const useBranch = (): BranchView => {
  const branch = useContext(BranchContext)
  if (branch === null) throw new Error("useBranch needs a BranchProvider: main.tsx renders one")
  return branch
}
