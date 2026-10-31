import { createContext, useContext } from "react"
import type { TranscriptView } from "../transcript"

// What the Transcript panel's components get: its live queries and plain actions (src/features/transcript/transcript.ts).

const TranscriptContext = createContext<TranscriptView | null>(null)

export const TranscriptProvider = TranscriptContext.Provider

export const useTranscript = (): TranscriptView => {
  const transcript = useContext(TranscriptContext)
  if (transcript === null) throw new Error("useTranscript needs a TranscriptProvider: main.tsx renders one")
  return transcript
}
