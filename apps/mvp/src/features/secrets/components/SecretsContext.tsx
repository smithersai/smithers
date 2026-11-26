import { createContext, useContext } from "react"
import type { SecretsLayer } from "../secrets.vibe"

// What React components get: the secrets layer's live queries to render and plain actions to call
// (features/secrets/secrets.ts).

const SecretsContext = createContext<SecretsLayer | null>(null)

export const SecretsProvider = SecretsContext.Provider

export const useSecrets = (): SecretsLayer => {
  const secrets = useContext(SecretsContext)
  if (secrets === null) throw new Error("useSecrets needs a SecretsProvider: main.tsx renders one")
  return secrets
}
