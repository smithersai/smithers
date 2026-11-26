import { createContext, useContext } from "react"
import type { WebView } from "../web.vibe"

// What React components get: the web pages layer's plain actions to call (features/web/web.ts).

const WebContext = createContext<WebView | null>(null)

export const WebProvider = WebContext.Provider

export const useWeb = (): WebView => {
  const web = useContext(WebContext)
  if (web === null) throw new Error("useWeb needs a WebProvider: main.tsx renders one")
  return web
}
