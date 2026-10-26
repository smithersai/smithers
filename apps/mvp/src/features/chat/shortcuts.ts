import { Effect } from "effect"
import { runners } from "../../boundary"
import { closeComposer, toggleComposer } from "./actions"
import type { ChatStore } from "./store"

// ⌘K (Ctrl+K) toggles the composer and Esc hides it from anywhere on `target`, whatever has focus, as in the old app's
// controlFocus.ts (removed 2026-10-21). The listeners are bound while the scope is open, and run
// each action with the services they were bound with. `preventDefault` runs in the listener, because ⌘K's browser
// default can only be stopped inside the event, so ⌘K listens as the event goes down. Esc listens as it comes back up,
// after the element it was pressed in: one that handled Esc itself, such as the command menu closing, prevented its
// default, and the composer stays.
export const chatShortcuts = Effect.fnUntraced(function* (target: EventTarget) {
  const { runSync: run } = runners(yield* Effect.context<ChatStore>(), "chat")
  // Some keydown events carry no key, such as Chrome's autofill.
  const keyOf = (event: Event) => (event as Partial<KeyboardEvent>).key
  const onToggle = (event: Event) => {
    const { metaKey, ctrlKey } = event as Partial<KeyboardEvent>
    const key = keyOf(event)
    if (typeof key !== "string" || !(metaKey || ctrlKey) || key.toLowerCase() !== "k") return
    event.preventDefault()
    run(toggleComposer("shortcut"))
  }
  const onEscape = (event: Event) => {
    if (keyOf(event) === "Escape" && !event.defaultPrevented) run(closeComposer)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      target.addEventListener("keydown", onToggle, true)
      target.addEventListener("keydown", onEscape)
    }),
    () =>
      Effect.sync(() => {
        target.removeEventListener("keydown", onToggle, { capture: true })
        target.removeEventListener("keydown", onEscape)
      }),
  )
})
