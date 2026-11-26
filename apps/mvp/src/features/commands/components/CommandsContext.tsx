import { createContext, useContext } from "react"
import type { CommandsView } from "../commands.vibe"

// What React components get: the command menu's live query to render and plain actions to call
// (features/commands/commands.ts).

const CommandsContext = createContext<CommandsView | null>(null)

export const CommandsProvider = CommandsContext.Provider

export const useCommands = (): CommandsView => {
  const commands = useContext(CommandsContext)
  if (commands === null) throw new Error("useCommands needs a CommandsProvider: main.tsx renders one")
  return commands
}

/** Returns `CommandsView` when inside `CommandsProvider`, or `null` in minimal test harnesses. */
export const useOptionalCommands = (): CommandsView | null => useContext(CommandsContext)
