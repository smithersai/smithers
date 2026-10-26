import { Effect, Metric } from "effect"
import { runners } from "../../boundary"

// One-key shortcuts (docs/features/todos.md#from-an-issue), as GitHub's single letters: a key presses the button on the
// page that declares it in `aria-keyshortcuts`, such as Make TODO's `t` on an issue's page, or focuses the field that
// declares it, such as the plugin strip's note on `i` (docs/features/plugins.md#the-action-strip). The page declares what its
// keys do and a screen reader announces them; no route or feature is named here, so a key works wherever its button
// shows. A key does nothing while a person types in a field, holds ⌘, Ctrl or Alt, or works in a dialog or a menu,
// or when an element already handled it. Each press is counted by key and logged, never with what the page shows.

/** Presses of a one-key shortcut, by `key`. */
export const shortcutPresses = Metric.counter("smithers_web_shortcut_presses", {
  description: "One-key shortcuts pressed, by key",
  incremental: true,
})

/** Elements a key focuses instead of clicking. */
const FIELDS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"])

/** Where a key belongs to what has focus: a field, an editor, a dialog or a menu. */
const OWNED = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role=dialog], [role=menu]"

/** The visible, enabled element on `root` that declares `key` in `aria-keyshortcuts`, if any. */
export const buttonFor = (root: ParentNode, key: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>("[aria-keyshortcuts]")].find(
    (element) =>
      element.getAttribute("aria-keyshortcuts")!.split(" ").includes(key) &&
      !element.matches(":disabled, [aria-disabled='true']") &&
      element.getClientRects().length > 0,
  )

/** Binds the one-key shortcuts on `target` (the window) while the scope is open. */
export const buttonShortcuts = Effect.fnUntraced(function* (target: EventTarget) {
  const { runSync: run } = runners(yield* Effect.context<never>(), "keys")
  const onKey = (event: Event) => {
    const { key, metaKey, ctrlKey, altKey } = event as Partial<KeyboardEvent>
    if (event.defaultPrevented || metaKey || ctrlKey || altKey || typeof key !== "string" || key.length !== 1) return
    const from = event.target as Partial<Element> & Partial<Node> | null
    if (typeof from?.closest === "function" && from.closest(OWNED) !== null) return
    const root = from?.ownerDocument ?? (from as Document | null)
    if (root === null || typeof root?.querySelectorAll !== "function") return
    const button = buttonFor(root, key)
    if (button === undefined) return
    // The browser's default for the key (typing, or a find-as-you-type) must stop inside the event.
    event.preventDefault()
    // A field's "press" is taking focus, so the person types in it next.
    if (FIELDS.has(button.tagName)) button.focus()
    else button.click()
    run(
      Metric.update(Metric.withAttributes(shortcutPresses, { key }), 1).pipe(
        Effect.andThen(Effect.logInfo("keys.press").pipe(Effect.annotateLogs({ key, feature: "keys" }))),
      ),
    )
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => target.addEventListener("keydown", onKey)),
    () => Effect.sync(() => target.removeEventListener("keydown", onKey)),
  )
})
