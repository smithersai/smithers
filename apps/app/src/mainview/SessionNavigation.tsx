import { useLiveQuery } from "@tanstack/react-db"
import { useCallback,type CSSProperties } from "react"
import { useController } from "./ControllerContext"
import { KeyboardNavigation } from "./KeyboardNavigation"
import { WORDMARK } from "./Wordmark"
import { flowAction } from "./flows/FlowAction"
import { flowArgs } from "./flows/FlowArgs"
import { GUIDE_KEYS } from "./onboarding/GuideButton"
import { bindPressActions } from "./runtime/PressActions"
import { ChromeBar } from "./tabs/ChromeBar"

const Mark = () => <pre aria-hidden="true">{WORDMARK.map((line, i) => <span key={i} style={{ "--row": i } as CSSProperties}>{line}{"\n"}</span>)}</pre>
export const SessionNavigationFallback = () => <header className="session-navigation" aria-label="Smithers"><h1 className="guide-wordmark" aria-label="Smithers" style={{ margin: 0 }}><Mark /></h1></header>

/** Mode selection is a preference; it never starts microphone capture. */
export const modeShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === GUIDE_KEYS.mode && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
export const sidebarShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w" && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')

/** One global logo and navigation surface. */
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
    const mobile = () => (doc.defaultView?.innerWidth ?? 1024) <= 600
    let closeFrame: number | undefined
    let returnFocus = false
    const closeDrawer = (focus = false) => {
      if (!mobile() || !controller.store.session().sidebarOpen) return
      returnFocus ||= focus
      if (closeFrame !== undefined) return
      // Collection observers run inside projection. Dispatch the chrome
      // command after that transaction has finished, never reentrantly.
      closeFrame = requestAnimationFrame(() => {
        closeFrame = undefined
        if (!node.isConnected) return
        const focusAfterClose = returnFocus
        returnFocus = false
        void controller.commands.run('sidebar.toggle', flowArgs('sidebar.toggle', { open: false })).then(() => {
          if (focusAfterClose && node.isConnected) requestAnimationFrame(() => node.querySelector<HTMLButtonElement>('button[aria-label="Smithers"]')?.focus())
        })
      })
    }
    const selection = controller.store.collections.transitions.subscribeChanges(changes => {
      if (changes.some(change => change.type === 'insert' && change.value.type === 'repo.selected')) closeDrawer(true)
    })
    const setupCards = controller.store.collections.cards.subscribeChanges(changes => {
      if (changes.some(change => change.type === 'insert' && change.value.kind === 'repository-setup')) closeDrawer(true)
    })
    const outside = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.('.session-sidebar,.session-navigation')) closeDrawer()
    }
    root.addEventListener('pointerdown', outside)
    const toggleChat = () => {
      controller.dismissHint("chat")
      if (controller.store.session().paletteOpen) {
        controller.closePalette(controller.store.session().draft)
        requestAnimationFrame(() => doc.querySelector<HTMLButtonElement>('.app-chat-controls [data-flow="chat.open"]')?.focus())
      }
      else {
        controller.runCommand('chat.open')
        requestAnimationFrame(() => doc.querySelector<HTMLTextAreaElement>('.app-shell [data-testid="composer-input"]')?.focus())
      }
    }
    const pressActions = bindPressActions({ root,
      enabled: () => !doc.querySelector('.input-mode-menu'),
      resolveShortcut: event => {
        const key = event.key.toLowerCase()
        const action = (activate: () => void, shortcut = key) => ({
          element: [...root.querySelectorAll<HTMLElement>('[aria-keyshortcuts]')].find(button => button.getAttribute('aria-keyshortcuts')?.toLowerCase().split(' ').includes(shortcut)), activate,
        })
        if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'k') {
          if (event.shiftKey) return action(() => controller.runCommand('palette.open', controller.store.session().paletteLastQuery ?? ''))
          return action(toggleChat, event.metaKey ? 'meta+k' : 'control+k')
        }
        if (key === 'escape' && mobile() && controller.store.session().sidebarOpen && !controller.store.session().paletteOpen
          && !doc.querySelector('[role="menu"]')) return action(() => closeDrawer(true), 'w')
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        if (key === GUIDE_KEYS.mode) return action(() => root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"][aria-keyshortcuts="m"]')?.click())
        if (sidebarShortcut(event)) return action(() => controller.runCommand('sidebar.toggle'))
      },
    })
    return () => { pressActions(); selection.unsubscribe(); setupCards.unsubscribe(); root.removeEventListener('pointerdown', outside); if (closeFrame !== undefined) cancelAnimationFrame(closeFrame) }

  }, [controller])
  return <>
    {sessions[0]?.inputMode === "vim" && <KeyboardNavigation />}
    <header className="session-navigation" aria-label="Smithers" data-keyboard-pane="Navigation" ref={mount} data-sidebar-open={open}>
      <h1 aria-label="Smithers" style={{ margin: 0 }}><button type="button" className="guide-wordmark" aria-label="Smithers" aria-expanded={open} aria-controls={open ? "session-sidebar" : undefined} aria-keyshortcuts="W" {...flowAction(controller.runCommand, "sidebar.toggle")}><Mark /></button></h1>
      {/* Signed in, the header carries no account chrome; Account lives in the sidebar and /account.show. */}
      {identity?.state !== "signed-in" && controller.commands.find("auth.sign-in") !== undefined && <div className="session-identity">
        <button type="button" className="chrome-action" data-testid="chrome-sign-in" {...flowAction(controller.runCommand, "auth.sign-in")}>Sign in with GitHub</button>
      </div>}
    </header>
    {open && <div id="session-sidebar" className="session-sidebar" data-keyboard-pane="Sidebar"><ChromeBar identityInHeader /></div>}
  </>
}
