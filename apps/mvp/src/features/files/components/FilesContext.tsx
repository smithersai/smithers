import { createContext, useContext } from "react"
import type { FilesView } from "../files.vibe"

// What React components get: file tabs' live query to render and plain actions to call (features/files/files.ts).

const FilesContext = createContext<FilesView | null>(null)

export const FilesProvider = FilesContext.Provider

export const useFiles = (): FilesView => {
  const files = useContext(FilesContext)
  if (files === null) throw new Error("useFiles needs a FilesProvider: main.tsx renders one")
  return files
}
