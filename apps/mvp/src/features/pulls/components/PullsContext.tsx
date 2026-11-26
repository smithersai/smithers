import { createContext, useContext } from "react"
import type { PullsLayer } from "../pulls.vibe"

// What React components get: the pull requests layer's live queries to render and plain actions to call
// (features/pulls/pulls.ts).

const PullsContext = createContext<PullsLayer | null>(null)

export const PullsProvider = PullsContext.Provider

export const usePulls = (): PullsLayer => {
  const pulls = useContext(PullsContext)
  if (pulls === null) throw new Error("usePulls needs a PullsProvider: main.tsx renders one")
  return pulls
}
