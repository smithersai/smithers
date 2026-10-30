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
 * What a query is asked for: named string values, such as the repository a
 * view is scoped to (`{ repo: "owner/name" }`). A query that takes none
 * ignores them; the host refuses `invalid_fields` when one it needs is
 * missing or malformed.
 *
 * @category models
 * @since 1.2.0
 */
export type QueryParams = Readonly<Record<string, string>>

/**
 * A row of a query a view reads, by its key, and the `params` the query was
 * asked with, when it takes any.
 *
 * @category models
 * @since 1.1.0
 */
export interface ItemRef {
  readonly query: string
  readonly key: string
  /** @since 1.2.0 */
  readonly params?: QueryParams
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
 * A repository a view is scoped to: `owner/name`.
 *
 * @category models
 * @since 1.1.0
 */
export interface Repository {
  readonly owner: string
  readonly name: string
}

/**
 * What a `component` render receives: its plugin's tab, and the repository
 * the page shows when it is a repository's page (a `repository`-scoped view,
 * or a `repo.tabs` slot entry).
 *
 * @category models
 * @since 1.1.0
 */
export interface Rendered<T> {
  readonly tab: T
  readonly repository?: Repository | undefined
}

/**
 * Where a view shows: `/app/<plugin>/<path>` for an `app` view, and
 * `/<owner>/<name>/-/<plugin>/<path>` for a `repository` view, which needs
 * its repository (`undefined` without one). The `-` segment keeps every
 * plugin path apart from the host's own repository pages.
 *
 * @category constructors
 * @since 1.1.0
 */
export const pathOf = (
  view: { readonly plugin: string; readonly scope: "app" | "repository"; readonly path: string },
  repository?: Repository
): string | undefined => {
  const rest = `${view.plugin}${view.path === "" ? "" : `/${view.path}`}`
  if (view.scope === "app") return `/app/${rest}`
  return repository === undefined ? undefined : `/${repository.owner}/${repository.name}/-/${rest}`
}

/**
 * The contract a plugin's UI reads and dispatches through. The app implements
 * it, scoped to the viewer and the plugin.
 *
 * @category models
 * @since 1.1.0
 */
export interface PluginHost {
  /**
   * Rows of a query the contribution declared in `reads`, scoped by the host
   * to the viewer and the plugin. `params` name what a query that takes them
   * is asked for (since 1.2.0).
   */
  readonly query: <R>(name: string, params?: QueryParams) => Effect.Effect<Live<R>, PluginRefused>
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
  /** Open a view the manifest declares; a `repository` view opens on `repository`, and without one does nothing. */
  readonly open: (view: string, repository?: Repository) => Effect.Effect<void>
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
