import { useCallback, useSyncExternalStore, type ReactNode } from "react"
import { useController } from "./ControllerContext"
import { HelpBubble } from "./HelpBubble"
import type { AppStore } from "./state/AppStore"

/** Visibility is a projection of mounted controls and durable dismissal receipts. */
const registries = new WeakMap<AppStore, ReturnType<typeof createRegistry>>()
function createRegistry(store: AppStore) {
  const listeners = new Set<() => void>()
  let subscription: { unsubscribe(): void } | undefined
  let scheduled = false
  const notify = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => { scheduled = false; for (const listener of listeners) listener() }, 0)
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      subscription ??= store.collections.sessions.subscribeChanges(notify)
      notify()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { subscription?.unsubscribe(); subscription = undefined }
        notify()
      }
    },
    first() {
      const seen = store.session().hintsSeen ?? []
      if (typeof document === "undefined") return undefined
      return [...document.querySelectorAll<HTMLElement>("[data-first-sight-hint]")]
        .find(node => !node.closest("[hidden], [inert], [aria-hidden=true]") && !seen.includes(node.dataset.firstSightHint!))?.dataset.firstSightHint
    },
  }
}

export function useFirstSightHint(id: string) {
  const { store } = useController()
  let registry = registries.get(store)
  if (!registry) { registry = createRegistry(store); registries.set(store, registry) }
  const first = useSyncExternalStore(registry.subscribe, registry.first, () => undefined)
  const dismiss = useCallback(() => {
    if (!store.session().hintsSeen?.includes(id)) store.dispatch({ type: "hint.dismissed", actor: "user", id })
  }, [store, id])
  return { open: first === id, dismiss }
}

export function FirstSightHint({ id, content, children }: { id: string; content: ReactNode; children: ReactNode }) {
  const { open, dismiss } = useFirstSightHint(id)
  return <div data-first-sight-hint={id} onClickCapture={event => {
    if ((event.target as Element).closest("button, a[href]")) dismiss()
  }}>
    <HelpBubble id={`hint-${id}`} open={open} content={content} onDismiss={dismiss}>{children}</HelpBubble>
  </div>
}

export function ChatHint() {
  return <><span className="hint-keyboard">Press ⌘K or Ctrl+K for Chat and commands.</span><span className="hint-touch">Open Chat for messages and commands.</span></>
}
