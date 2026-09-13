import { useCallback, type CSSProperties } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "./ControllerContext"
import { WORDMARK } from "./Wordmark"
import { ChromeBar } from "./tabs/ChromeBar"

const Mark = () => <pre aria-hidden="true">{WORDMARK.map((line, i) => <span key={i} style={{ "--row": i } as CSSProperties}>{line}{"\n"}</span>)}</pre>
export const SessionNavigationFallback = () => <header className="session-navigation"><div className="guide-wordmark" aria-label="Smithers"><Mark /></div></header>

/** Command-D (Control-D elsewhere) toggles dictation; every action has a key, and the browser lets a page own this one. */
export const dictationShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && (event.metaKey === true || event.ctrlKey === true) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d"
export const sidebarShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w" && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')

/** One global logo and navigation surface, including during the tutorial. */
export function SessionNavigation() {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const open = sessions[0]?.sidebarOpen === true
  const mount = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.repeat && event.key.toLowerCase() === "k" && !node.ownerDocument.querySelector(".guide-shell")) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (controller.store.session().paletteOpen && !event.shiftKey) controller.closePalette()
        else {
          controller.runCommand("palette.open", event.shiftKey ? controller.store.session().paletteLastQuery ?? "" : undefined)
          requestAnimationFrame(() => node.ownerDocument.querySelector<HTMLTextAreaElement>('.app-shell [data-testid="composer-input"]')?.focus())
        }
        return
      }
      if (dictationShortcut(event)) {
        event.preventDefault(); event.stopImmediatePropagation()
        controller.runCommand("chat.dictate")
        return
      }
      if (!sidebarShortcut(event)) return
      event.preventDefault(); event.stopImmediatePropagation()
      controller.runCommand("sidebar.toggle")
    }
    node.ownerDocument.addEventListener("keydown", keydown, true)
    return () => node.ownerDocument.removeEventListener("keydown", keydown, true)
  }, [controller])
  return <>
    <header className="session-navigation" ref={mount} data-sidebar-open={open}>
      <button type="button" className="guide-wordmark" aria-label="Smithers" aria-expanded={open} aria-controls="session-sidebar" aria-keyshortcuts="W" data-flow="sidebar.toggle" onClick={() => controller.runCommand("sidebar.toggle")}><Mark /></button>
    </header>
    {open && <div id="session-sidebar" className="session-sidebar"><ChromeBar /></div>}
  </>
}
