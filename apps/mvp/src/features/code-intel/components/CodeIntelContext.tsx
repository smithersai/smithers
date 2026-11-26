import { createContext, useContext } from "react"
import type { CodeIntelView } from "../codeIntel.vibe"

// What React components get: code intelligence's live query to render and plain actions to call
// (features/code-intel/codeIntel.ts).

const CodeIntelContext = createContext<CodeIntelView | null>(null)

export const CodeIntelProvider = CodeIntelContext.Provider

export const useCodeIntel = (): CodeIntelView => {
  const intel = useContext(CodeIntelContext)
  if (intel === null) throw new Error("useCodeIntel needs a CodeIntelProvider: main.tsx renders one")
  return intel
}
