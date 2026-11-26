import { createContext, useContext } from "react"
import type { TerminalView } from "../terminal.vibe"

// What the terminal's components get: its live query and plain actions (src/features/terminal/terminal.ts).

const TerminalContext = createContext<TerminalView | null>(null)

export const TerminalProvider = TerminalContext.Provider

export const useTerminal = (): TerminalView => {
  const terminal = useContext(TerminalContext)
  if (terminal === null) throw new Error("useTerminal needs a TerminalProvider: main.tsx renders one")
  return terminal
}
