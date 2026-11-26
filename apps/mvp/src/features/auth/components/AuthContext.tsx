import { createContext, useContext } from "react"
import type { AuthView } from "../auth.vibe"

// What React components get: sign-in's live query to render and plain actions to call (features/auth/auth.ts).

const AuthContext = createContext<AuthView | null>(null)

export const AuthProvider = AuthContext.Provider

export const useAuth = (): AuthView => {
  const auth = useContext(AuthContext)
  if (auth === null) throw new Error("useAuth needs an AuthProvider: main.tsx renders one")
  return auth
}
