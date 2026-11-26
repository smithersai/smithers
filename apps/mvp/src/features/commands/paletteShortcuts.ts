import { Effect } from "effect"
import { runners } from "../../boundary.vibe"
import { togglePalette } from "./actions.vibe"
import type { CommandsStore } from "./store.vibe"

// `⌘P` / `Ctrl+P` (and `⌘⇧P` / `Ctrl+Shift+P`) toggles the global Command Palette & Go-to-File dialog from anywhere
// on `target`, stopping the browser's print dialog inside the capture phase.
export const paletteShortcuts = Effect.fnUntraced(function* (target: EventTarget) {
  const { runSync: run } = runners(yield* Effect.context<CommandsStore>(), "commands")
  const onKeyDown = (event: Event) => {
    const { key, metaKey, ctrlKey, altKey } = event as Partial<KeyboardEvent>
    if (event.defaultPrevented || altKey || !(metaKey || ctrlKey) || typeof key !== "string" || key.toLowerCase() !== "p") return
    event.preventDefault()
    run(togglePalette)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => target.addEventListener("keydown", onKeyDown, true)),
    () => Effect.sync(() => target.removeEventListener("keydown", onKeyDown, { capture: true })),
  )
})
