import { createContext, useContext } from "react"
import type { DomainsView } from "../domains.vibe"

// What React components get: custom domains' live queries to render and plain actions to call
// (features/domains/domains.ts).

const DomainsContext = createContext<DomainsView | null>(null)

export const DomainsProvider = DomainsContext.Provider

export const useDomains = (): DomainsView => {
  const domains = useContext(DomainsContext)
  if (domains === null) throw new Error("useDomains needs a DomainsProvider: main.tsx renders one")
  return domains
}
