import { createContext, useContext } from "react"
import type { AttentionView } from "../attention.vibe"

// What React components get: the feed's live queries to render and plain actions to call
// (features/attention/attention.ts).

const AttentionContext = createContext<AttentionView | null>(null)

export const AttentionProvider = AttentionContext.Provider

export const useAttention = (): AttentionView => {
  const attention = useContext(AttentionContext)
  if (attention === null) throw new Error("useAttention needs an AttentionProvider: main.tsx renders one")
  return attention
}
