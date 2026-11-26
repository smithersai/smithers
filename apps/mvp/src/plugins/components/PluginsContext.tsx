import { createContext, useContext } from "react"
import type { PluginsView } from "../ui.vibe"

// What React components get: the plugin host's contributions and state to render, and plain actions (src/plugins/ui.ts).

const PluginsContext = createContext<PluginsView | null>(null)

export const PluginsProvider = PluginsContext.Provider

export const usePlugins = (): PluginsView => {
  const plugins = useContext(PluginsContext)
  if (plugins === null) throw new Error("usePlugins needs a PluginsProvider: main.tsx renders one")
  return plugins
}
