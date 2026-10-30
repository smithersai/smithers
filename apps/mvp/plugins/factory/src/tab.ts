import { Host } from "@smthrs/plugin"
import { Effect, Exit, Scope } from "effect"
import { type AskRow, type FeedDocument, type Feeds, feedsOf, repoOf } from "./feeds"
import { statusOf, type Status, VIEWS, type ViewId } from "./model"

// The factory's tab (decision 0126 §9): one per app, built by the host on first use. It reads a repository's feed
// documents through `Feeds` (./feeds.ts), the one seam to the core's queries, and gives the views each repository's
// status and the document the person opened (a lane's transcript, a commit's diff, a review). It keeps no clock: a
// view counts durations to the status's own time, and the status's age ticks on @smthrs/ui's shared `RelativeTime`.
// It never answers an ask: `feed/answer` is person-only, and the host's strip sends it for the ask the person selects.

/** One value, live: what it is now, and a way to hear it changed. */
export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

/** A value that changes, and tells its listeners. */
const cell = <A>(initial: A) => {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    current: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set: (next: A) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

/** What a view has of a repository's feed: loading, refused by the host, or its status. */
export type Feed =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Refused"; readonly reason: string }
  | { readonly _tag: "Ready"; readonly status: Status; readonly documents: number }

/** A document the person opened beside a view: what it is, and its body once it arrived. */
export interface Opened {
  readonly kind: "transcript" | "diff" | "report"
  /** The lane, the commit, or the report's title. */
  readonly title: string
  /** The document's name: `transcript/<lane>`, `diff/<commit>`, `report/...`, `needs`. */
  readonly name: string
  /** Its body; `undefined` until the collector pushed it, `null` when the host refused it. */
  readonly body: unknown
}

/** What the factory's components read and do. */
export interface FactoryTab {
  readonly queries: {
    /** A repository's status, live; the same value for the same repository. */
    readonly feed: (repository: Host.Repository) => Watched<Feed>
    /** A repository's open asks, live. */
    readonly asks: (repository: Host.Repository) => Watched<ReadonlyArray<AskRow>>
    /** The ask the strip answers: the person's pick, else the first open one. */
    readonly selected: Watched<string | null>
    /** The document opened beside the view, if any. */
    readonly opened: Watched<Opened | null>
  }
  readonly actions: {
    /** Where one of the factory's views shows on `repository`, for its link. */
    readonly href: (view: ViewId, repository: Host.Repository) => string
    /** Opens one of the factory's views on `repository`. */
    readonly open: (view: ViewId, repository: Host.Repository) => void
    /** Opens document `name` of `repository` beside the view, titled `title`. */
    readonly read: (repository: Host.Repository, kind: Opened["kind"], name: string, title: string) => void
    /** Closes the opened document. */
    readonly close: () => void
    /** Selects `ask`: the strip under the view answers it. */
    readonly select: (ask: AskRow) => void
    /** Navigates to a page of the app (the repository's docs or pull requests) through the view's `go` event. */
    readonly go: (view: ViewId, to: string) => void
  }
}

/** Where view `id` shows on `repository`. */
export const hrefOf = (id: ViewId, repository: Host.Repository): string =>
  Host.pathOf({ plugin: "factory", scope: "repository", path: VIEWS.find((view) => view.id === id)!.path }, repository)!

/** The feed a list of documents makes. */
export const feedOf = (rows: ReadonlyArray<FeedDocument>): Feed => ({ _tag: "Ready", status: statusOf(rows), documents: rows.length })

/** The tab over `feeds` and `host`, in the scope it is built in. */
export const make = (host: Host.PluginHost, feeds: Feeds) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = Effect.runForkWith(yield* Effect.context<never>())

    /** A live value per repository, built once, in the tab's scope. */
    const perRepository = <A>(
      initial: A,
      open: (repository: Host.Repository, set: (value: A) => void) => Effect.Effect<void>,
    ) => {
      const built = new Map<string, Watched<A>>()
      return (repository: Host.Repository): Watched<A> => {
        const key = repoOf(repository)
        const known = built.get(key)
        if (known !== undefined) return known
        const value = cell(initial)
        built.set(key, value)
        run(Effect.forkIn(open(repository, value.set), scope))
        return value
      }
    }

    /** Follows `live` into `set` until the tab's scope closes, each change mapped by `map`. */
    const follow = <R, A>(live: Host.Live<R>, set: (value: A) => void, map: (rows: ReadonlyArray<R>) => A) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          set(map(live.current()))
          return live.subscribe(() => set(map(live.current())))
        }),
        (stop) => Effect.sync(stop),
      )

    const feed = perRepository<Feed>({ _tag: "Loading" }, (repository, set) =>
      feeds.index(repository).pipe(
        Effect.flatMap((live) => Effect.andThen(Scope.provide(follow(live, set, feedOf), scope), Effect.void)),
        Effect.catch((refused) => Effect.sync(() => set({ _tag: "Refused", reason: refused.reason }))),
      ))

    const selected = cell<string | null>(null)
    const select = (ask: AskRow) => {
      selected.set(ask.key)
      run(Effect.ignore(feeds.select(ask)))
    }
    // When the selected ask leaves (answered here or on another device), the strip moves to the first one open.
    const settle = (rows: ReadonlyArray<AskRow>) => {
      const first = rows[0]
      if (first !== undefined && !rows.some((row) => row.key === selected.current())) select(first)
      return rows
    }
    const asks = perRepository<ReadonlyArray<AskRow>>([], (repository, set) =>
      feeds.asks(repository).pipe(
        Effect.flatMap((live) => Effect.andThen(Scope.provide(follow(live, set, settle), scope), Effect.void)),
        Effect.ignore,
      ))

    const opened = cell<Opened | null>(null)
    // The opened document's scope: an on-demand document is followed only while it shows (decision 0126 §5).
    let reading: Scope.Closeable | undefined
    const close = () => {
      const closing = reading
      reading = undefined
      opened.set(null)
      if (closing !== undefined) run(Scope.close(closing, Exit.void))
    }
    const read = (repository: Host.Repository, kind: Opened["kind"], name: string, title: string) => {
      close()
      const own = Scope.makeUnsafe()
      reading = own
      const shown: Opened = { kind, title, name, body: undefined }
      opened.set(shown)
      const set = (body: unknown) => {
        if (reading === own) opened.set({ ...shown, body })
      }
      run(
        feeds.document(repository, name).pipe(
          Effect.flatMap((live) => Scope.provide(follow(live, set, (rows) => rows[0]?.body), own)),
          Effect.catch(() => Effect.sync(() => set(null))),
        ),
      )
    }
    yield* Effect.addFinalizer(() => Effect.sync(close))

    return {
      queries: { feed, asks, selected, opened },
      actions: {
        href: (view, repository) => hrefOf(view, repository),
        open: (view, repository) => void run(host.open(view, repository)),
        read,
        close,
        select,
        go: (view, to) => void run(host.dispatch({ view, name: "go" }, { to }).pipe(Effect.ignore)),
      },
    } satisfies FactoryTab
  })

/** The tab: built by the host in the plugin's scope on first use. */
export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  return yield* make(host, feedsOf(host))
})
