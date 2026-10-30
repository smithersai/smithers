import { Bind, type Contribution, Host, JsonSchema, Load } from "@smthrs/plugin"
import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Cause, Context, Deferred, Effect, Exit, Layer, Metric, Option, PubSub, Result, Scope, Stream } from "effect"
import { codeOf } from "../errorCode"
import { issueUrl } from "../features/bugs/github"
import { BugsStore } from "../features/bugs/store"
import { isFeedName, parseFeedRepo } from "../features/feeds/contract"
import { FeedsStore } from "../features/feeds/store"
import { StatusStore } from "../features/status/store"
import { FlowDispatch } from "../flows/dispatch"
import { codeOfFailure } from "../flows/history"
import type { FlowName } from "../flows/registry"
import { BUILTIN, type BuiltIn } from "./builtin"
import { hostFacts } from "./facts"
import { Draft, draftKey, fresh, SHOWN, Shown, ViewState } from "./schema"
import { type Button, personOnly, textFields } from "./strip"

// The plugin host (decision 0017, docs/features/plugins.md): loads the built-in plugins' manifests through the public
// loader, `@smthrs/plugin`'s `Load`, and serves each plugin the one public contract, `PluginHost`, scoped to that
// plugin: it reads only the queries its contributions declare, selects only rows of them, and dispatches only events
// its views declare. An event whose flow is person-only (`run/answer`) is never dispatched for plugin code: the host's
// action strip draws it, and the person's press or key sends it with their own door. First-party plugins get nothing
// else; a plugin needing more makes the public contract grow.

type View = Contribution.View

/** Plugins loaded at boot, by `outcome` (`active`, `refused`), `tier` and refusal `reason`. */
export const loads = Metric.counter("smithers_plugin_loads", {
  description: "Plugins the host loaded at boot, by outcome, tier and refusal reason",
  incremental: true,
})

/** Contributions the active plugins brought, by `point`. */
export const contributionCount = Metric.counter("smithers_plugin_contributions", {
  description: "Contributions active plugins brought, by point",
  incremental: true,
})

/** Presses of the host's action strip, by `plugin`, `event`, `door` (`button`, `key`) and `outcome`. */
export const presses = Metric.counter("smithers_plugin_presses", {
  description: "Presses of the host's action strip, by plugin, event, door and outcome",
  incremental: true,
})

/** A live list of rows, as `PluginHost.query` answers: the current rows, and a way to hear they changed. */
export const liveOf = <R>(rows: Stream.Stream<ReadonlyArray<R>>) =>
  Effect.gen(function* () {
    let current: ReadonlyArray<R> = []
    const listeners = new Set<() => void>()
    yield* rows.pipe(
      Stream.runForEach((next) =>
        Effect.sync(() => {
          current = next
          for (const listener of listeners) listener()
        })
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    return {
      current: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    } satisfies Host.Live<R>
  })

/** Every view's strip state, as a live query. */
const stripsQuery = (views: Collection.Collection<ViewState, string>) =>
  LiveQuery.make((q) => q.from({ view: views.tanstack }))

/** Every note the strips hold, as a live query. */
const draftsQuery = (drafts: Collection.Collection<Draft, string>) =>
  LiveQuery.make((q) => q.from({ draft: drafts.tanstack }))

/** A core query a plugin may read: its rows and the field each row is keyed by. */
interface CoreQuery {
  readonly key: string
  readonly live: Host.Live<Readonly<Record<string, unknown>>>
  /** The same rows as a TanStack DB live query, for the host's own components. */
  readonly rows: StatusStore["Service"]["waits"]["tanstack"]
}

/** The core queries a plugin asks with `params`: a repository's feed index, and one of its documents. */
const FEED_INDEX = "core/feeds"
const FEED_DOCUMENT = "core/feed"

/** `params` in a stable order, to tell whether two selections asked a query the same way. */
const paramsKey = (params: Host.QueryParams | null) =>
  JSON.stringify(Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b)))

/** A local event the keymap delivered to a view. */
interface Delivered {
  readonly view: string
  readonly name: string
  readonly fields: unknown
}

export class Plugins extends Context.Service<
  Plugins,
  {
    readonly contributions: Contribution.Contributions
    readonly refused: ReadonlyArray<Contribution.Refusal>
    readonly facts: Load.HostFacts
    readonly built: ReadonlyMap<string, BuiltIn>
    readonly core: ReadonlyMap<string, CoreQuery>
    /** `core/feeds` of each repository asked for so far, by its `owner/name` lowercased, for the strip to read. */
    readonly opened: Map<string, CoreQuery>
    /** Every repository's feeds, which `core/feeds` and `core/feed` read. */
    readonly feeds: FeedsStore["Service"]
    readonly shown: Collection.Collection<Shown, string>
    readonly views: Collection.Collection<ViewState, string>
    /** The strip's notes, by view and item, kept on the device. */
    readonly drafts: Collection.Collection<Draft, string>
    /** Every view's strip state, live, for the strip's component. */
    readonly strips: Effect.Success<ReturnType<typeof stripsQuery>>
    /** Every note, live, for the strip's text box. */
    readonly notes: Effect.Success<ReturnType<typeof draftsQuery>>
    readonly delivered: PubSub.PubSub<Delivered>
    /** Where the background work an action starts runs. */
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/plugins/Plugins") {
  /** Loads `builtins` (the app's list by default) and keeps the host's state while the scope lives. */
  static readonly layer = (builtins: ReadonlyArray<BuiltIn> = BUILTIN) =>
    Layer.effect(
      Plugins,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const facts = hostFacts()
        const loaded = yield* Load.load(facts, builtins.map(({ manifest }) => ({ tier: "built-in" as const, manifest })))
        yield* record(loaded)
        const built = new Map(
          builtins.flatMap((entry) => {
            const id = (entry.manifest as { readonly id?: unknown }).id
            return typeof id === "string" && loaded.contributions.plugins.some((plugin) => plugin.id === id)
              ? [[id, entry] as const]
              : []
          }),
        )
        const status = yield* StatusStore
        const bugs = yield* BugsStore
        const feeds = yield* FeedsStore
        const core = new Map<string, CoreQuery>([
          ["core/waits", {
            key: "runId",
            live: (yield* liveOf(status.waits.rows)) as CoreQuery["live"],
            rows: status.waits.tanstack,
          }],
          // The bug reports the viewer may see, newest first, each with GitHub's prefilled form for it
          // (docs/features/bugs.md). No strip acts on a report, so the strip never reads its rows.
          ["core/bug-reports", {
            key: "id",
            live: (yield* liveOf(
              Stream.map(bugs.newest.rows, (rows) => rows.map((row) => ({ ...row, github: issueUrl(row) }))),
            )) as CoreQuery["live"],
            rows: bugs.newest.tanstack as unknown as CoreQuery["rows"],
          }],
        ])
        const shown = yield* Collection.local<Shown, string>({
          id: "plugin-shown",
          schema: Shown,
          getKey: (row) => row.id,
          initialData: [{ id: SHOWN, view: null }],
        })
        const views = yield* Collection.local<ViewState, string>({
          id: "plugin-views",
          schema: ViewState,
          getKey: (row) => row.id,
        })
        const drafts = yield* Collection.persisted<Draft, string>({
          id: "plugin-drafts",
          schema: Draft,
          getKey: (row) => row.id,
          schemaVersion: 1,
        })
        const strips = yield* stripsQuery(views)
        const notes = yield* draftsQuery(drafts)
        const delivered = yield* PubSub.unbounded<Delivered>()
        return Plugins.of({
          contributions: loaded.contributions,
          refused: loaded.refused,
          facts,
          built,
          core,
          opened: new Map(),
          feeds,
          shown,
          views,
          drafts,
          strips,
          notes,
          delivered,
          scope,
        })
      }),
    )
}

/** One `plugin.load` record per plugin: a span, a log line and a count, with its id and outcome, never its text. */
const record = (loaded: Load.Loaded) =>
  Effect.gen(function* () {
    for (const plugin of loaded.contributions.plugins) {
      const fields = { plugin: plugin.id, version: plugin.version, tier: plugin.tier, outcome: "active" }
      yield* Metric.update(Metric.withAttributes(loads, { outcome: "active", tier: plugin.tier, reason: "none" }), 1)
      yield* Effect.logInfo("plugin.load").pipe(Effect.annotateLogs(fields), Effect.withSpan("plugin.load", { attributes: fields }))
    }
    for (const refusal of loaded.refused) {
      const fields = { plugin: refusal.plugin ?? "unknown", outcome: "refused", reason: refusal.reason }
      yield* Metric.update(Metric.withAttributes(loads, { outcome: "refused", tier: "built-in", reason: refusal.reason }), 1)
      yield* Effect.logError("plugin.refused").pipe(
        Effect.annotateLogs({ ...fields, path: refusal.path ?? "" }),
        Effect.withSpan("plugin.load", { attributes: fields }),
      )
    }
    const points = { views: loaded.contributions.views, slots: loaded.contributions.slots, commands: loaded.contributions.commands, keybindings: loaded.contributions.keybindings }
    for (const [point, entries] of Object.entries(points)) {
      if (entries.length > 0) yield* Metric.update(Metric.withAttributes(contributionCount, { point }), entries.length)
    }
  })

/** The view declared with `id`, if any. */
export const viewById = (contributions: Contribution.Contributions, id: string): View | undefined =>
  contributions.views.find((view) => view.id === id)

/**
 * The view `plugin` declares at `path` in `scope`, if any: an `app` view shows at `/app/<plugin>/<path>`, a `repository`
 * view at `/<owner>/<repo>/-/<plugin>/<path>`.
 */
export const viewAt = (
  contributions: Contribution.Contributions,
  plugin: string,
  path: string,
  scope: View["scope"] = "app",
): View | undefined => contributions.views.find((view) => view.plugin === plugin && view.scope === scope && view.path === path)

/** Where a view shows; a `repository` view shows on `repository` and has no path without one. */
export const pathOf = (view: View, repository?: Host.Repository): string | undefined => Host.pathOf(view, repository)

/** Every query `plugin`'s contributions declare in `reads`. */
const readsOf = (contributions: Contribution.Contributions, plugin: string): ReadonlySet<string> =>
  new Set(
    [...contributions.views, ...contributions.slots].filter((entry) => entry.plugin === plugin).flatMap((entry) => entry.reads ?? []),
  )

/** View `id`'s strip state, made fresh when it has none, changed by `change`. */
const touch = (id: string, change: (row: ViewState) => Partial<ViewState>) =>
  Effect.gen(function* () {
    const { views } = yield* Plugins
    const current = yield* views.get(id)
    if (Option.isNone(current)) {
      const base = fresh(id)
      yield* views.insert({ ...base, ...change(base) })
      return
    }
    yield* views.update(id, (draft) => void Object.assign(draft, change(current.value)))
  }).pipe(Effect.orDie)

/**
 * Core query `name` as the strip reads it: a fixed one, or one a plugin asked with `params` (`core/feeds`); `undefined`
 * for any other, `core/feed` included, whose rows a view only shows.
 */
export const readable = (
  plugins: Plugins["Service"],
  name: string,
  params: Host.QueryParams | null,
): CoreQuery | undefined =>
  plugins.core.get(name) ??
    (name === FEED_INDEX ? plugins.opened.get(parseFeedRepo(params?.repo ?? "") ?? "") : undefined)

/**
 * Query `name` for a plugin, asked with `params`: a fixed core query's rows; `core/feeds`, the index of the repository
 * `params.repo` names (`owner/name`), opened once and kept for the strip; `core/feed`, its document `params.name`, synced
 * only while the view listens. Fails with what is wrong: `query` for one the host doesn't serve, else the parameter it
 * needs that is missing or malformed.
 */
export const queryOf = (name: string, params: Host.QueryParams | undefined) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins
    const fixed = plugins.core.get(name)
    if (fixed !== undefined) return fixed.live
    if (name !== FEED_INDEX && name !== FEED_DOCUMENT) return yield* Effect.fail("query" as const)
    const { repo: asked = "", name: document = "" } = params ?? {}
    const repo = parseFeedRepo(asked)
    if (repo === undefined) return yield* Effect.fail("repo" as const)
    if (name === FEED_DOCUMENT) {
      if (!isFeedName(document)) return yield* Effect.fail("name" as const)
      return plugins.feeds.document(repo, document) as unknown as CoreQuery["live"]
    }
    const known = plugins.opened.get(repo)
    if (known !== undefined) return known.live
    const index = yield* plugins.feeds.index(repo)
    const query: CoreQuery = {
      key: "id",
      live: (yield* liveOf(index.byName.rows).pipe(Scope.provide(plugins.scope))) as CoreQuery["live"],
      rows: index.byName.tanstack as unknown as CoreQuery["rows"],
    }
    plugins.opened.set(repo, query)
    return query.live
  })

/** View `id`'s strip state now. */
export const stateOf = (id: string) =>
  Effect.gen(function* () {
    const { views } = yield* Plugins
    return Option.getOrElse(yield* views.get(id), () => fresh(id))
  })

/** The row view `id` selected, as its query has it now, if it is still there. */
export const selectedOf = (id: string) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins
    const state = yield* stateOf(id)
    const query = state.query === null ? undefined : readable(plugins, state.query, state.params)
    return query?.live.current().find((row) => row[query.key] === state.item)
  })

/** The plugin view shown now, if any. */
export const shownView = Effect.gen(function* () {
  const { shown, contributions } = yield* Plugins
  const row = yield* shown.get(SHOWN)
  const id = Option.getOrUndefined(row)?.view ?? null
  return id === null ? undefined : viewById(contributions, id)
})

/** Shows view `id` (`null` for none): the route that draws it calls this, and its leaving clears it. */
export const show = (id: string | null) =>
  Effect.gen(function* () {
    const { shown } = yield* Plugins
    yield* shown.update(SHOWN, (row) => void (row.view = id))
  }).pipe(Effect.orDie)

/** The note view `id` holds for `item`. */
const draftOf = (id: string, item: string) =>
  Effect.gen(function* () {
    const { drafts } = yield* Plugins
    return Option.match(yield* drafts.get(draftKey(id, item)), { onNone: () => "", onSome: (row) => row.text })
  })

/** Keeps the text box's note for the item view `id` selected; with nothing selected there is no note to keep. */
export const setDraft = (id: string, text: string) =>
  Effect.gen(function* () {
    const { drafts } = yield* Plugins
    const { item } = yield* stateOf(id)
    if (item === null) return
    const key = draftKey(id, item)
    if (Option.isSome(yield* drafts.get(key))) yield* drafts.update(key, (row) => void (row.text = text))
    else yield* drafts.insert({ id: key, text })
  }).pipe(Effect.orDie)

/** A row as the person saw it: its own fields, without TanStack DB's virtual `$` ones, in a stable order. */
const seen = (row: Readonly<Record<string, unknown>>) =>
  JSON.stringify(Object.keys(row).filter((key) => !key.startsWith("$")).sort().map((key) => [key, row[key]]))


/**
 * The person pressed `button` on view `id`'s strip, by pointer (`button`) or key (`key`): runs its event's flow for the
 * selected item with the button's fields and the draft in every text field, in the background. The strip shows
 * Sending until the run settles; a second press meanwhile does nothing, so two presses record one answer. A run that
 * fails shows as failed, keeping the draft, until the next press.
 */
export const press = (
  id: string,
  button: Button,
  door: "button" | "key",
  drawn?: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins
    const view = viewById(plugins.contributions, id)
    const event = view?.events.find((candidate) => candidate.name === button.event)
    const item = yield* selectedOf(id)
    const state = yield* stateOf(id)
    if (view === undefined || event === undefined || !("flow" in event) || !event.personOnly) return
    if (item === undefined || state.item === null || state.sending) return
    const key = state.item
    // A button acts on the item it was drawn for: if that item moved on (answered elsewhere, a new version), nothing runs.
    if (drawn !== undefined && seen(drawn) !== seen(item)) {
      return yield* Effect.andThen(
        Metric.update(Metric.withAttributes(presses, { plugin: view.plugin, event: event.name, door, outcome: "stale" }), 1),
        Effect.logInfo("plugin.press").pipe(Effect.annotateLogs({ plugin: view.plugin, view: id, event: event.name, door, outcome: "stale" })),
      )
    }
    const fields: Record<string, unknown> = { ...button.fields }
    const note = yield* draftOf(id, key)
    for (const field of textFields(event)) fields[field] = note
    // A press whose flow didn't run or failed is a failure, Warn by its code; every other outcome is Info.
    const outcome = (value: string, failure?: unknown) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(presses, { plugin: view.plugin, event: event.name, door, outcome: value }), 1),
        (value === "failed" ? Effect.logWarning : Effect.logInfo)("plugin.press").pipe(Effect.annotateLogs({
          feature: "plugins",
          plugin: view.plugin,
          view: id,
          event: event.name,
          door,
          outcome: value,
          ...(value === "failed" ? { errorCode: codeOf(failure) } : {}),
        })),
      )
    const payload = Bind.bind(event.args, { item, event: fields })
    if (Option.isSome(misfit(event.payload, fields)) || Result.isFailure(payload)) {
      yield* touch(id, () => ({ failed: true }))
      return yield* outcome("invalid")
    }
    yield* touch(id, () => ({ sending: true, failed: false }))
    const flows = yield* FlowDispatch
    yield* flows.dispatch(event.flow as FlowName, payload.success as never, { door }).pipe(
      // A flow that ran and failed is a failure like one that didn't run: either is named by its code.
      Effect.flatMap((dispatched) => dispatched._tag === "Done" ? Effect.void : Effect.fail(dispatched.error)),
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit)
          ? Effect.andThen(
            Effect.andThen(touch(id, () => ({ sending: false })), dropDraft(id, key)),
            outcome("done"),
          )
          : Effect.andThen(touch(id, () => ({ sending: false, failed: true })), outcome("failed", Cause.squash(exit.cause)))
      ),
      Effect.forkIn(plugins.scope),
    )
  })

/** Drops view `id`'s note for `item`, once its answer went. */
const dropDraft = (id: string, item: string) =>
  Effect.gen(function* () {
    const { drafts } = yield* Plugins
    yield* drafts.delete(draftKey(id, item)).pipe(Effect.ignore)
  })

/** Delivers a local event to the view that declares it: `j` and `k`. */
export const deliver = (view: string, name: string, fields: unknown) =>
  Effect.gen(function* () {
    const { delivered } = yield* Plugins
    yield* PubSub.publish(delivered, { view, name, fields })
  })

/** Why `fields` don't fit an event's payload, if they don't: none when it declares no payload. */
const misfit = (payload: JsonSchema.Resolved | undefined, fields: unknown) =>
  payload === undefined ? Option.none<string>() : JsonSchema.validate(payload, fields)

/** A declared failure's stable code: its `code` when it carries one (a refusal's), else its kind. */
const failureCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : codeOfFailure(error) ?? "failed"

/**
 * How a plugin's dispatched run ended, as `Dispatched.settled` answers it: `Done`, or `Failed` with its stable code:
 * the flow's declared failure's (`BugRefused`'s `authentication`), dispatch's refusal or reason, or `interrupted`.
 * Never a message.
 */
export const settledOf = (
  exit: Exit.Exit<
    { readonly _tag: "Done" } | { readonly _tag: "Failed"; readonly error: unknown },
    { readonly reason: string; readonly refusal?: string | undefined }
  >,
): Host.Settled => {
  if (Exit.isSuccess(exit)) {
    return exit.value._tag === "Done" ? { _tag: "Done" } : { _tag: "Failed", code: failureCode(exit.value.error) }
  }
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error)) return { _tag: "Failed", code: error.value.refusal ?? error.value.reason }
  return { _tag: "Failed", code: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "defect" }
}

/** Refuses a request plugin `plugin` made of its host: logged once by the reason, never the detail, then failed. */
const refuse = (plugin: string, reason: Host.PluginRefused["reason"], detail: string) =>
  Effect.logWarning("plugin.request").pipe(
    Effect.annotateLogs({ feature: "plugins", plugin, outcome: "refused", reason }),
    Effect.andThen(Effect.fail(new Host.PluginRefused({ plugin, reason, detail }))),
  )

/**
 * `PluginHost` for `plugin`, over this host: the one contract its tab reads and acts through (decision 0017, "The host
 * contract"). Every request is checked against what the plugin's own manifest declares.
 */
export const hostFor = (plugin: string) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins
    const context = yield* Effect.context<Plugins | FlowDispatch>()
    const provide = <A, E>(effect: Effect.Effect<A, E, Plugins | FlowDispatch>) => Effect.provide(effect, context)
    const reads = readsOf(plugins.contributions, plugin)
    /** The event `name` of the plugin's own view `id`. */
    const eventOf = (ref: Host.EventRef) => {
      const view = viewById(plugins.contributions, ref.view)
      const event = view?.plugin === plugin ? view.events.find((candidate) => candidate.name === ref.name) : undefined
      return event === undefined ? refuse(plugin, "undeclared_event", ref.name) : Effect.succeed({ view: view!, event })
    }
    return {
      query: <R>(name: string, params?: Host.QueryParams) =>
        Effect.gen(function* () {
          if (!reads.has(name)) return yield* refuse(plugin, "undeclared_query", name)
          // A declared query is one the host serves (`Load` checks `reads` against its facts): only a parameter fails.
          const live = yield* provide(queryOf(name, params)).pipe(
            Effect.catch((param) => refuse(plugin, "invalid_fields", `${name} needs ${param}`)),
          )
          return live as unknown as Host.Live<R>
        }),
      select: (item: Host.ItemRef) =>
        Effect.gen(function* () {
          // Every view of this plugin that reads the item's query acts on it: the strip under it shows its actions.
          const targets = plugins.contributions.views.filter((view) => view.plugin === plugin && (view.reads ?? []).includes(item.query))
          const params = item.params ?? null
          const query = readable(plugins, item.query, params)
          if (targets.length === 0 || query === undefined) return yield* refuse(plugin, "not_in_reads", item.query)
          if (!query.live.current().some((row) => row[query.key] === item.key)) return yield* refuse(plugin, "not_in_reads", "no such row")
          for (const view of targets) {
            yield* provide(touch(view.id, (row) =>
              row.item === item.key && row.query === item.query && paramsKey(row.params) === paramsKey(params)
                ? {}
                : { query: item.query, params, item: item.key, failed: false }
            ))
          }
        }),
      propose: (ref: Host.EventRef, fields: unknown) =>
        Effect.gen(function* () {
          const { event } = yield* eventOf(ref)
          if (!("flow" in event) || !event.personOnly) {
            return yield* refuse(plugin, "undeclared_event", "only the strip's events are proposed")
          }
          const invalid = misfit(event.payload, fields)
          if (Option.isSome(invalid)) return yield* refuse(plugin, "invalid_fields", invalid.value)
          const text = textFields(event).map((field) => (fields as Record<string, unknown>)[field]).find((value) => typeof value === "string")
          if (typeof text === "string") yield* provide(setDraft(ref.view, text))
        }),
      dispatch: (ref: Host.EventRef, fields: unknown) =>
        Effect.gen(function* () {
          const { view, event } = yield* eventOf(ref)
          if (!("flow" in event)) return yield* refuse(plugin, "undeclared_event", "a local event stays in its view")
          if (personOnly(event)) return yield* refuse(plugin, "person_only", event.flow)
          const invalid = misfit(event.payload, fields)
          if (Option.isSome(invalid)) return yield* refuse(plugin, "invalid_fields", invalid.value)
          const item = yield* provide(selectedOf(view.id))
          const payload = Bind.bind(event.args, { item, event: fields })
          if (Result.isFailure(payload)) return yield* refuse(plugin, "invalid_fields", payload.failure)
          const runId = crypto.randomUUID()
          const flows = yield* provide(FlowDispatch)
          // The view hears how its run ended, failed or interrupted included, so it never says Sending for good.
          const settled = yield* Deferred.make<Host.Settled>()
          yield* flows.dispatch(event.flow as FlowName, payload.success as never, { door: "view", executionId: runId }).pipe(
            Effect.onExit((exit) => Deferred.succeed(settled, settledOf(exit))),
            Effect.ignore,
            Effect.forkIn(plugins.scope),
          )
          return { runId, settled: Deferred.await(settled) }
        }),
      open: (id: string, repository?: Host.Repository) =>
        Effect.gen(function* () {
          const view = viewById(plugins.contributions, id)
          const to = view?.plugin === plugin ? pathOf(view, repository) : undefined
          if (to === undefined) return
          const flows = yield* provide(FlowDispatch)
          yield* flows.dispatch("app/navigate", { to }, { door: "view" }).pipe(Effect.ignore, Effect.forkIn(plugins.scope))
        }),
      events: (id: string) =>
        viewById(plugins.contributions, id)?.plugin === plugin
          ? Stream.fromPubSub(plugins.delivered).pipe(
            Stream.filter((event) => event.view === id),
            Stream.map(({ name, fields }) => ({ name, fields })),
          )
          : Stream.empty,
    } satisfies Host.PluginHost
  })
