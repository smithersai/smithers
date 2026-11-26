import { createContext, useContext } from "react"
import type { HomeView } from "../home.vibe"

// What React components get: the home layer's live queries to render (features/home/home.ts).

const HomeContext = createContext<HomeView | null>(null)

export const HomeProvider = HomeContext.Provider

export const useHome = (): HomeView => {
  const home = useContext(HomeContext)
  if (home === null) throw new Error("useHome needs a HomeProvider: main.tsx renders one")
  return home
}
