import { createContext, useContext } from "react"
import type { TodosView } from "../todos.vibe"

// What React components get: the TODOs layer's live queries to render and plain actions to call
// (features/todos/todos.ts).

const TodosContext = createContext<TodosView | null>(null)

export const TodosProvider = TodosContext.Provider

export const useTodos = (): TodosView => {
  const todos = useContext(TodosContext)
  if (todos === null) throw new Error("useTodos needs a TodosProvider: main.tsx renders one")
  return todos
}

/** Returns `TodosView` when inside `TodosProvider`, or `null` in minimal test harnesses. */
export const useOptionalTodos = (): TodosView | null => useContext(TodosContext)
