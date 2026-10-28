import { createContext, useContext } from "react"
import type { FirstRunView } from "../firstRun"

// What React components get: the first run's live row to render and the list's press to call
// (features/first-run/firstRun.ts).

const FirstRunContext = createContext<FirstRunView | null>(null)

export const FirstRunProvider = FirstRunContext.Provider

export const useFirstRun = (): FirstRunView => {
  const firstRun = useContext(FirstRunContext)
  if (firstRun === null) throw new Error("useFirstRun needs a FirstRunProvider: main.tsx renders one")
  return firstRun
}
