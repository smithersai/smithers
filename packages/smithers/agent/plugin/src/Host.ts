/**
 * The host contract: what a plugin's UI reads and dispatches through.
 *
 * The app implements {@link PluginHost}; a built-in's tab layer requires it
 * and gives its components `{ queries, actions }`. The host owns person-only
 * actions: an event whose flow is person-only is drawn in the host's action
 * strip and never dispatched by plugin code.
 *
 * @since 1.1.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"

/**
 * Why the host refused a plugin's request.
 *
 * @category models
 * @since 1.1.0
 */
export const RefusedReason = Schema.Literals([
  "person_only",
  "undeclared_query",
  "undeclared_event",
  "not_in_reads",
  "invalid_fields",
  "unknown_view",
  "no_item",
  "outside_ceiling"
])

/**
 * Why the host refused a plugin's request.
 *
 * @category models
 * @since 1.1.0
 */
export type RefusedReason = typeof RefusedReason.Type

/**
 * The host refused a plugin's request: a query it did not declare, an event
 * whose flow is person-only, fields its payload schema rejects.
 *
 * @category errors
 * @since 1.1.0
 */
export class PluginRefused extends Schema.TaggedError<PluginRefused>()("plugin/PluginRefused", {
  plugin: Schema.String,
  reason: RefusedReason,
  detail: Schema.String
}) {}

/**
 * A framework-free live source: the current rows, and a subscription that
 * calls back when they change. React adapters read it with
 * `useSyncExternalStore`.
 *
 * @category models
 * @since 1.1.0
 */
export interface Live<R> {
  readonly current: () => ReadonlyArray<R>
  /** Calls `listener` after every change; the returned function unsubscribes. */
  readonly subscribe: (listener: () => void) => () => void
}

/**
 * A row of a query a view reads, by its key.
 *
 * @category models
 * @since 1.1.0
 */
export interface ItemRef {
  readonly query: string
  readonly key: string
}

/**
 * An event a view declares.
 *
 * @category models
 * @since 1.1.0
 */
export interface EventRef {
  readonly view: string
  readonly name: string
}

/**
 * How a dispatched run ended: `Done`, or `Failed` with the failure's stable
 * code (a refusal's code, else its kind), never its message. A schema, so a
 * framed app's bridge carries it as data.
 *
 * @category models
 * @since 1.1.0
 */
export const Settled = Schema.Union([
  Schema.TaggedStruct("Done", {}),
  Schema.TaggedStruct("Failed", { code: Schema.String })
])

/**
 * How a dispatched run ended.
 *
 * @category models
 * @since 1.1.0
 */
export type Settled = typeof Settled.Type

/**
 * The run a dispatch started, and how it ended: `settled` waits for its end,
 * so a view can say a run failed, why, and offer to run it again.
 *
 * @category models
 * @since 1.1.0
 */
export interface Dispatched {
  readonly runId: string
  readonly settled: Effect.Effect<Settled>
}

/**
 * A declared local event the host's keymap delivered to a view.
 *
 * @category models
 * @since 1.1.0
 */
export interface Delivered {
  readonly name: string
  readonly fields: unknown
}

/**
 * The contract a plugin's UI reads and dispatches through. The app implements
 * it, scoped to the viewer and the plugin.
 *
 * @category models
 * @since 1.1.0
 */
export interface PluginHost {
  /** Rows of a query the contribution declared in `reads`, scoped by the host to the viewer and the plugin. */
  readonly query: <R>(name: string) => Effect.Effect<Live<R>, PluginRefused>
  /** The item the person is looking at: the host's action strip acts on it. Must be a row of the view's `reads`. */
  readonly select: (item: ItemRef) => Effect.Effect<void, PluginRefused>
  /** Prefill an event's fields in the action strip. Nothing runs until the person presses. */
  readonly propose: (event: EventRef, fields: unknown) => Effect.Effect<void, PluginRefused>
  /**
   * Run an event whose flow is not person-only: the host fills `$item` and
   * `$event` and mints the invocation context. Answers once the run started,
   * with its id and `settled`, which waits for its end.
   */
  readonly dispatch: (event: EventRef, fields: unknown) => Effect.Effect<Dispatched, PluginRefused>
  /** Open a view the manifest declares. */
  readonly open: (view: string) => Effect.Effect<void>
  /**
   * The declared local events of `view` the host's keymap delivered, in order
   * (`j`, `k`). Person-only events are never delivered.
   */
  readonly events: (view: string) => Stream.Stream<Delivered>
}

/**
 * The service a built-in's tab layer requires.
 *
 * @category services
 * @since 1.1.0
 */
export const PluginHost: Context.Service<PluginHost, PluginHost> = Context.Service<PluginHost>(
  "@smthrs/plugin/PluginHost"
)

/**
 * What a built-in's tab layer gives its components: the queries they read and
 * the actions they call. Components never import Effect.
 *
 * @category models
 * @since 1.1.0
 */
export interface PluginTab<Q, A> {
  readonly queries: Q
  readonly actions: A
}
