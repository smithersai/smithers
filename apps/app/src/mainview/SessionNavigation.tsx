import { useCallback, type CSSProperties } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "./ControllerContext"
import { WORDMARK } from "./Wordmark"
import { bindPressActions } from "./runtime/PressActions"
import { KeyboardNavigation } from "./KeyboardNavigation"
import { GUIDE_KEYS } from "./onboarding/GuideButton"
import { ChromeBar } from "./tabs/ChromeBar"
import { toastActionShortcut } from "./ToastAction"

const Mark = () => <pre aria-hidden="true">{WORDMARK.map((line, i) => <span key={i} style={{ "--row": i } as CSSProperties}>{line}{"\n"}</span>)}</pre>
export const SessionNavigationFallback = () => <header className="session-navigation"><div className="guide-wordmark" aria-label="Smithers"><Mark /></div></header>

/** Mode selection is a preference; it never starts microphone capture. */
export const modeShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === GUIDE_KEYS.mode && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
export const sidebarShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w" && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')

/** One global logo and navigation surface, including during the tutorial. */
export function SessionNavigation() {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: identities } = useLiveQuery(controller.store.collections.identitySessions)
  const identity = identities[0]
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
        const toastAction = toastActionShortcut(event, root)
        if (toastAction) return toastAction
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
      },
    })

  }, [controller])
  return <>
    {sessions[0]?.inputMode === "vim" && <KeyboardNavigation />}
    <header className="session-navigation" data-keyboard-pane="Navigation" ref={mount} data-sidebar-open={open}>
      <button type="button" className="guide-wordmark" aria-label="Smithers" aria-expanded={open} aria-controls={open ? "session-sidebar" : undefined} aria-keyshortcuts="W" data-flow="sidebar.toggle" onClick={() => controller.runCommand("sidebar.toggle")}><Mark /></button>
      <div className="session-identity">
        {identity?.state === "signed-in" ?
          controller.commands.find("account.show") !== undefined && <button type="button" className="chrome-action" data-testid="chrome-account" data-flow="account.show" onClick={() => controller.runCommand("account.show")}>Account (@{identity.login})</button> :
          controller.commands.find("auth.sign-in") !== undefined && <button type="button" className="chrome-action" data-testid="chrome-sign-in" data-flow="auth.sign-in" onClick={() => controller.runCommand("auth.sign-in")}>Sign in with GitHub</button>}
      </div>
    </header>
    {open && <div id="session-sidebar" className="session-sidebar" data-keyboard-pane="Sidebar"><ChromeBar identityInHeader /></div>}
  </>
}
