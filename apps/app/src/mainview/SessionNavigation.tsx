import { useCallback, type CSSProperties } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "./ControllerContext"
import { WORDMARK } from "./Wordmark"
import { bindPressActions } from "./runtime/PressActions"
import { vimFocusAction } from "./runtime/VimNavigation"
import { GUIDE_KEYS } from "./onboarding/GuideButton"
import { ChromeBar } from "./tabs/ChromeBar"

const Mark = () => <pre aria-hidden="true">{WORDMARK.map((line, i) => <span key={i} style={{ "--row": i } as CSSProperties}>{line}{"\n"}</span>)}</pre>
export const SessionNavigationFallback = () => <header className="session-navigation"><div className="guide-wordmark" aria-label="Smithers"><Mark /></div></header>

/** Mode selection is a preference; it never starts microphone capture. */
export const modeShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === GUIDE_KEYS.mode && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
export const sidebarShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w" && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')

/** One global logo and navigation surface, including during the tutorial. */
export function SessionNavigation() {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const open = sessions[0]?.sidebarOpen === true
  const mount = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const doc = node.ownerDocument
    const root = node.closest<HTMLElement>('.session-shell') ?? node
    const toggleChat = () => {
      if (controller.store.session().paletteOpen) { controller.cancelDictation(); controller.closePalette() }
      else {
        controller.runCommand('chat.open')
        requestAnimationFrame(() => doc.querySelector<HTMLTextAreaElement>('.app-shell [data-testid="composer-input"]')?.focus())
      }
    }
    return bindPressActions({ root,
      enabled: () => !doc.querySelector('.guide-shell, .input-mode-menu'),
      resolveShortcut: event => {
        const key = event.key.toLowerCase()
        const action = (activate: () => void, shortcut = key) => ({
          element: [...root.querySelectorAll<HTMLElement>('[aria-keyshortcuts]')].find(button => button.getAttribute('aria-keyshortcuts')?.toLowerCase().split(' ').includes(shortcut)), activate,
        })
        if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'k') {
          if (event.shiftKey) return action(() => controller.runCommand('palette.open', controller.store.session().paletteLastQuery ?? ''))
          return action(toggleChat, event.metaKey ? 'meta+k' : 'control+k')
        }
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        if (key === GUIDE_KEYS.chat) return action(toggleChat)
        if (key === GUIDE_KEYS.mode) return action(() => root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"][aria-keyshortcuts="m"]')?.click())
        if (sidebarShortcut(event)) return action(() => controller.runCommand('sidebar.toggle'))
        if (controller.store.session().inputMode === 'vim') return vimFocusAction(root, key)
      },
    })

  }, [controller])
  return <>
    <header className="session-navigation" ref={mount} data-sidebar-open={open}>
      <button type="button" className="guide-wordmark" aria-label="Smithers" aria-expanded={open} aria-controls="session-sidebar" aria-keyshortcuts="W" data-flow="sidebar.toggle" onClick={() => controller.runCommand("sidebar.toggle")}><Mark /></button>

    </header>
    {open && <div id="session-sidebar" className="session-sidebar"><ChromeBar /></div>}
  </>
}
