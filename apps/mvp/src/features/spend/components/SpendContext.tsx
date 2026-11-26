import { createContext, useContext } from "react"
import type { SpendView } from "../spend.vibe"

// What React components get: spend alerts' live query to render and a plain action to call (features/spend/spend.ts).

const SpendContext = createContext<SpendView | null>(null)

export const SpendProvider = SpendContext.Provider

export const useSpend = (): SpendView => {
  const spend = useContext(SpendContext)
  if (spend === null) throw new Error("useSpend needs a SpendProvider: main.tsx renders one")
  return spend
}
