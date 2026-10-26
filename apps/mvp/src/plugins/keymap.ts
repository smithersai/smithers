import { Bind, Keys, When } from "@smthrs/plugin"
import { runners } from "../boundary"
import { Effect, Metric, Result } from "effect"
import { FlowDispatch } from "../flows/dispatch"
import type { FlowName } from "../flows/registry"
import { CHORD_WITHIN_MS } from "./contract"
import { deliver, Plugins, press, selectedOf, shownView } from "./plugins"
import { personOnly } from "./strip"

// The core keymap (decision 0017, core primitive 9): the one judge of every plugin's keybindings. A key runs a command
// (its flow, door `key`), presses the host's action strip for a person-only event, or delivers a local event to the
// view that declares it. A binding's `when` is checked against the view shown, the item it selected and whether a field
// has focus. A key with no modifier never fires while the person types in a field; `mod+enter` does, so a note sends
// from the text box. The strip's note declares `i`, which the one-key shortcuts focus (src/features/keys). Each key that fires is logged and
// counted by plugin and key, never with what the page shows.

/** Keys that fired a binding, by `plugin` and `key`. */
export const keyPresses = Metric.counter("smithers_plugin_keys", {
  description: "Plugin keybindings that fired, by plugin and key",
  incremental: true,
})

/** Where a key belongs to what has focus: a field or an editor. */
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])"

/** A key event as the keymap reads it. */
export const pressedOf = (event: Partial<KeyboardEvent>): Keys.Pressed => ({
  key: event.key!.toLowerCase(),
  meta: event.metaKey === true,
  ctrl: event.ctrlKey === true,
  alt: event.altKey === true,
  shift: event.shiftKey === true,
})

/**
 * What a stroke does, given the strokes just before it: the first binding whose keys it completes and whose `when`
 * holds, `partial` when it starts a two-stroke key, else nothing.
 */
export const resolve = (strokes: ReadonlyArray<Keys.Pressed>, focusInput: boolean, mac: boolean) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins
    const view = yield* shownView
    const item = view === undefined ? undefined : yield* selectedOf(view.id)
    const scope = { ...(view === undefined ? {} : { view: view.id }), ...(item === undefined ? {} : { item }), focusInput }
    const last = strokes.at(-1)!
    const typing = focusInput && !last.meta && !last.ctrl && !last.alt
    let partial = false
    for (const binding of plugins.contributions.keybindings) {
      if (typing || !When.evaluate(binding.when, scope)) continue
      for (const pressed of [strokes.slice(-2), strokes.slice(-1)]) {
        const match = Keys.match(binding.keys, pressed, { mac })
        if (match.matched) return { kind: "binding" as const, binding, index: match.index, view }
        if (match.partial && pressed.length === 1) partial = true
      }
    }
    return partial ? { kind: "partial" as const } : undefined
  })

/** Runs what `resolve` found. */
const fire = (found: Exclude<NonNullable<Effect.Success<ReturnType<typeof resolve>>>, { readonly kind: "partial" }>) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins
    const { binding, index, view } = found
    yield* Metric.update(Metric.withAttributes(keyPresses, { plugin: binding.plugin, key: binding.key }), 1)
    yield* Effect.logInfo("plugin.key").pipe(Effect.annotateLogs({ plugin: binding.plugin, key: binding.key }))
    if ("command" in binding) {
      const command = plugins.contributions.commands.find((candidate) => candidate.id === binding.command)!
      // A command's args are fixed values (the loader refuses a reference in them).
      const flows = yield* FlowDispatch
      yield* flows.dispatch(command.flow as FlowName, { ...command.args } as never, { door: "key" }).pipe(
        Effect.ignore,
        Effect.forkIn(plugins.scope),
      )
      return
    }
    // Its `when` names its view, which is the one shown (the loader checks the event is that view's).
    // A key fills fields only from `$key.index`, on a digit key: the loader checks both, so they always bind.
    const fields = Result.getOrThrow(
      Bind.bind(binding.fields, { item: undefined, event: {}, ...(index === undefined ? {} : { key: { index } }) }),
    )
    const event = view!.events.find((candidate) => candidate.name === binding.event)!
    if (!personOnly(event)) return yield* deliver(binding.view, event.name, fields)
    yield* press(binding.view, { event: event.name, fields: fields as Record<string, unknown>, label: "" }, "key")
  })

/** Binds the plugins' keys on `target` (the window) while the scope is open; `mac` maps `mod` to ⌘, else Ctrl. */
export const pluginKeys = Effect.fnUntraced(function* (target: EventTarget, mac: boolean) {
  const { runSync: run } = runners(yield* Effect.context<Plugins | FlowDispatch>(), "plugins")
  let recent: Array<{ readonly stroke: Keys.Pressed; readonly at: number }> = []
  const onKey = (event: Event) => {
    const key = event as Partial<KeyboardEvent>
    if (event.defaultPrevented || typeof key.key !== "string" || ["meta", "control", "alt", "shift"].includes(key.key.toLowerCase())) return
    const from = event.target as Partial<Element> | null
    const focusInput = typeof from?.closest === "function" && from.closest(FIELD) !== null
    const at = event.timeStamp
    recent = [...recent.filter((entry) => at - entry.at <= CHORD_WITHIN_MS), { stroke: pressedOf(key), at }].slice(-2)
    const found = run(resolve(recent.map((entry) => entry.stroke), focusInput, mac))
    if (found === undefined || found.kind === "partial") return
    // The browser's default for the key (typing a letter, a newline) must stop inside the event.
    event.preventDefault()
    recent = []
    run(fire(found))
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => target.addEventListener("keydown", onKey)),
    () => Effect.sync(() => target.removeEventListener("keydown", onKey)),
  )
})
