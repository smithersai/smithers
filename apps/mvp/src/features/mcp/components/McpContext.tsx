import { createContext, useContext } from "react"
import type { McpView } from "../store.vibe"

// What React components get: MCP's live queries to render and plain actions to call (features/mcp/store.ts `Mcp`).

const McpContext = createContext<McpView | null>(null)

export const McpProvider = McpContext.Provider

export const useMcp = (): McpView => {
  const mcp = useContext(McpContext)
  if (mcp === null) throw new Error("useMcp needs a McpProvider: AppProviders.tsx renders one")
  return mcp
}

export const useMcpOptional = (): McpView | null => useContext(McpContext)
