import { useCallback,useSyncExternalStore,type ReactNode } from "react"
import { useController } from "./ControllerContext"
import { HelpBubble } from "./HelpBubble"
import { flowProps } from "./flows/FlowAction"
type AppStore = ReturnType<typeof useController>["store"]

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
  const controller = useController()
  const { store } = controller
  let registry = registries.get(store)
  if (!registry) { registry = createRegistry(store); registries.set(store, registry) }
  const first = useSyncExternalStore(registry.subscribe, registry.first, () => undefined)
  const dismiss = useCallback(() => {
    if (!store.session().hintsSeen?.includes(id)) controller.dismissHint(id)
  }, [controller, store, id])
  return { open: first === id, dismiss }
}

export function FirstSightHint({ id, content, children, placement }: { id: string; content: ReactNode; children: ReactNode; placement?: "flow" | "above" }) {
  const { open, dismiss } = useFirstSightHint(id)
  return <div data-first-sight-hint={id} onClickCapture={event => {
    if ((event.target as Element).closest("button, a[href]")) dismiss()
  }}>
    <HelpBubble id={`hint-${id}`} open={open} placement={placement} dismissOnEscape={false} restoreFocusOnDismiss={false} content={content} onDismiss={dismiss} dismissBinding={flowProps("app.hint.dismiss", id)}>{children}</HelpBubble>
  </div>
}

export function ChatHint() {
  return <><span className="hint-keyboard">Press ⌘K or Ctrl+K for Chat and commands.</span><span className="hint-touch">Open Chat for messages and commands.</span></>
}
