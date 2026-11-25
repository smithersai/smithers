/**
 * The catalog as a headless GUI: `{ queries, actions, hostStrip }`, with the
 * host contract's semantics from `@smthrs/plugin`.
 *
 * `queries` and `actions` are what a plugin's frame gets: they act as the
 * app, so `actions.dispatch` refuses every person-only flow. `hostStrip` is
 * the host-drawn action strip: `press` mints the person from the host's own
 * session, and is the only way a person-only flow runs.
 *
 * The frame half opens only the engine's frame door, and the strip only its
 * person door. Each reads just its own fields, so nothing a frame adds to its
 * options selects another door.
 *
 * @since 1.0.0
 */

import { type Live, PluginRefused } from "@smthrs/plugin/Host"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import * as Core from "./Core.ts"
import type * as Principal from "./Principal.ts"

/**
 * A run a dispatch started.
 *
 * @category models
 * @since 1.0.0
 */
export interface Dispatched {
  readonly runId: string
  readonly requested: Core.Requested
}

/**
 * What the host knows about a press: the door it came through, and whether
 * the person confirmed a protected act in the host's dialog.
 *
 * @category models
 * @since 1.0.0
 */
export interface Press {
  readonly door?: Principal.PersonDoor
  readonly confirmed?: boolean
}

/**
 * The headless GUI over one viewer and one plugin frame.
 *
 * @category models
 * @since 1.0.0
 */
export interface Gui {
  readonly queries: {
    readonly read: (name: string, params?: unknown) => Effect.Effect<Core.Page, PluginRefused | Core.CoreError>
    /** The current rows and a subscription, for `useSyncExternalStore`. */
    readonly live: (name: string, params?: unknown) => Effect.Effect<Live<Core.Json>, PluginRefused | Core.CoreError>
  }
  readonly actions: {
    /** The flows plugin code may dispatch. */
    readonly list: Effect.Effect<ReadonlyArray<Core.Entry>, Core.CoreError>
    /** Runs a flow as the app. A person-only flow refuses `person_only`. */
    readonly dispatch: (tag: string, fields?: unknown) => Effect.Effect<Dispatched, PluginRefused | Core.CoreError>
  }
  readonly hostStrip: {
    /** The person-only flows the host draws in its strip. */
    readonly items: Effect.Effect<ReadonlyArray<Core.Entry>, Core.CoreError>
    /** The person presses: runs a flow as the person, with a fresh receipt when a protected act was confirmed. */
    readonly press: (
      tag: string,
      fields?: unknown,
      press?: Press
    ) => Effect.Effect<Core.Requested, Core.CoreError | Principal.AuthRefused>
  }
  /** Every flow the person may run from the palette. */
  readonly palette: Effect.Effect<ReadonlyArray<Core.Entry>, Core.CoreError>
}

const refusals = {
  person_only: "person_only",
  receipt_required: "person_only",
  capability_exceeded: "outside_ceiling",
  invalid_payload: "invalid_fields",
  not_found: "undeclared_event"
} as const

/**
 * Builds the GUI. `frame` is the plugin frame's evidence; `person` is the
 * host's own session, which only the strip uses.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly engine: Core.Engine
  readonly frame: { readonly session: string; readonly plugin: string }
  readonly person: { readonly session: string }
}): Effect.Effect<Gui, Principal.AuthRefused> => {
  const { engine } = options
  // Read once, by name: no other field of `frame` or `person` is ever used.
  const frame = { session: options.frame.session, plugin: options.frame.plugin }
  const person = { session: options.person.session }
  return Effect.map(engine.openFrame(frame), (app): Gui => {
    const asPlugin = (kind: "flow" | "query") => (error: Core.CoreError): PluginRefused | Core.CoreError => {
      const reason = Object.hasOwn(refusals, error.reason)
        ? refusals[error.reason as keyof typeof refusals]
        : undefined
      if (reason === undefined) return error
      return new PluginRefused({
        plugin: frame.plugin,
        reason: kind === "query" && reason === "undeclared_event" ? "undeclared_query" : reason,
        detail: error.detail
      })
    }
    const read = (name: string, params?: unknown) =>
      app.read({ query: name, params }).pipe(Effect.mapError(asPlugin("query")))
    const flows = Effect.map(Core.entries(app), (all) => all.filter((entry) => entry.kind === "flow"))

    return {
      queries: {
        read,
        live: (name, params) =>
          Effect.map(read(name, params), (first): Live<Core.Json> => {
            let page = first
            const listeners = new Set<() => void>()
            let fiber: Fiber.Fiber<void, Core.CoreError> | undefined
            return {
              current: () => page.rows,
              subscribe: (listener) => {
                listeners.add(listener)
                fiber ??= Effect.runFork(Stream.runForEach(app.changes({ query: name, params }, page.cursor), (next) =>
                  Effect.sync(() => {
                    page = next
                    for (const each of Array.from(listeners)) each()
                  })))
                return () => {
                  listeners.delete(listener)
                  if (listeners.size === 0 && fiber !== undefined) {
                    Effect.runFork(Fiber.interrupt(fiber))
                    fiber = undefined
                  }
                }
              }
            }
          })
      },
      actions: {
        list: Effect.map(flows, (all) => all.filter(Core.delegable)),
        dispatch: (tag, fields) =>
          app.submit({ operation: tag, payload: fields }).pipe(
            Effect.map((requested): Dispatched => ({ runId: requested.runId, requested })),
            Effect.mapError(asPlugin("flow"))
          )
      },
      hostStrip: {
        items: Effect.map(flows, (all) => all.filter((entry) => !Core.delegable(entry))),
        press: (tag, fields, press = {}) =>
          Effect.gen(function*() {
            const evidence: Principal.PersonEvidence = {
              kind: "gui",
              door: press.door ?? "strip",
              session: person.session
            }
            const core = yield* engine.openPerson({ session: evidence.session, door: evidence.door })
            const intent: Core.Intent = { operation: tag, payload: fields }
            if (press.confirmed !== true) return yield* core.submit(intent)
            const receipt = yield* engine.confirm(evidence, intent)
            return yield* core.submit({ ...intent, receipt })
          })
      },
      palette: flows
    }
  })
}
