import { ElectricCollection, type ShapeSource } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Context, Duration, Effect, FiberHandle, Layer, Option, type Schedule, Stream } from "effect"
import { AuthStore } from "../auth/store"
import { REPOSITORIES_SHAPE_ROUTE } from "./contract"
import { aboutQuery, embedsQuery, fileQuery, manifestQuery, readmeQuery, refsQuery, treeQuery, viewQuery } from "./queries"
import { AboutRow, BlobRow, CloneRow, EmbedRow, emptyView, HeadRow, RefsRow, TreeRow, VIEW, ViewRow } from "./rows"
import { Repository } from "./schema"

// The repository feature's state on this tab (docs/features/repo.md#the-browser): the repositories Postgres has, synced
// by Electric and kept on the device; what this tab loaded of them, in memory; where the routed view is; and the live
// queries frontends read. Actions reach the network through `RepoClient`; nothing here does.

/** Where the repositories sync from, and how long Electric gets to deliver a clone RepoApi took. */
export interface RepoConfig {
  /** RepoApi's origin: the site's own. */
  readonly origin: string
  /** How long Electric gets to deliver the row of a clone RepoApi took before the request shows as failed. Default 15 s. */
  readonly confirmWithin?: Duration.Input
  /**
   * How long a navigation keeps the previous page while the next one's files load, before it shows the next page with
   * skeletons where they will be. Default 1 s.
   */
  readonly pageWait?: Duration.Input
  /** How long a failed shape request waits before it is sent again. Default `SyncPolicy.defaultPolicy`. */
  readonly retry?: Schedule.Schedule<unknown, ShapeSource.RequestFailed>
}

/** Whether sign-in's row says someone is signed in; `null` while it doesn't know. */
const signedInOf = (session: { readonly status: string }): boolean | null =>
  session.status === "signed_in" ? true : session.status === "signed_out" ? false : null

const make = Effect.fnUntraced(function* (config: RepoConfig) {
  const repositories = yield* ElectricCollection.make<Repository>({
    id: "repo-repositories",
    schema: Repository,
    getKey: (row) => row.id,
    syncMode: "eager",
    // Version 4 adds `refsChangedAt`; synced caches resync on a version change (decision 0021).
    persist: { schemaVersion: 4 },
    shape: {
      url: `${config.origin}${REPOSITORIES_SHAPE_ROUTE}`,
      columnMapper: ElectricCollection.snakeCamelMapper(),
      parser: { int8: (value: string) => Number(value) },
    },
    ...(config.retry === undefined ? {} : { retry: config.retry }),
  })
  const clones = yield* Collection.local<CloneRow, string>({ id: "repo-clones", schema: CloneRow, getKey: (row) => row.id })
  const trees = yield* Collection.local<TreeRow, string>({ id: "repo-trees", schema: TreeRow, getKey: (row) => row.key })
  const blobs = yield* Collection.local<BlobRow, string>({ id: "repo-blobs", schema: BlobRow, getKey: (row) => row.key })
  const refs = yield* Collection.local<RefsRow, string>({ id: "repo-refs", schema: RefsRow, getKey: (row) => row.key })
  const abouts = yield* Collection.local<AboutRow, string>({ id: "repo-abouts", schema: AboutRow, getKey: (row) => row.key })
  const heads = yield* Collection.local<HeadRow, string>({ id: "repo-heads", schema: HeadRow, getKey: (row) => row.key })
  const embeds = yield* Collection.local<EmbedRow, string>({ id: "repo-embeds", schema: EmbedRow, getKey: (row) => row.key })
  const view = yield* Collection.local<ViewRow, string>({
    id: "repo-view",
    schema: ViewRow,
    getKey: (row) => row.id,
    initialData: [emptyView],
  })

  // The repositories' shape's first answer, rows or a failure: until then the header offers no Clone for a repository
  // this device hasn't seen (`headerOf`).
  yield* repositories.sync.pipe(
    Stream.filter((event) => event._tag !== "Sent"),
    Stream.runHead,
    Effect.andThen(Effect.orDie(view.update(VIEW, (row) => void (row.answered = true)))),
    Effect.forkScoped,
  )

  // Who is signed in, from sign-in's own row when the app has sign-in: Clone gives way to the sign-in link.
  const auth = yield* Effect.serviceOption(AuthStore)
  if (Option.isSome(auth)) {
    yield* auth.value.sessionState.rows.pipe(
      Stream.runForEach((rows) =>
        // Sign-in's store always holds its one row.
        Effect.orDie(view.update(VIEW, (row) => void (row.signedIn = signedInOf(rows[0]!))))
      ),
      Effect.forkScoped,
    )
  }

  return {
    repositories,
    clones,
    trees,
    blobs,
    refs,
    abouts,
    heads,
    embeds,
    view,
    viewState: yield* viewQuery(view, repositories, clones, abouts),
    embedsState: yield* embedsQuery(embeds, repositories, abouts, trees, blobs),
    aboutState: yield* aboutQuery(view, abouts),
    manifestState: yield* manifestQuery(view, blobs),
    refsState: yield* refsQuery(view, refs),
    treeState: yield* treeQuery(view, trees),
    fileState: yield* fileQuery(view, blobs),
    readmeState: yield* readmeQuery(view, blobs),
    /** The one load the routed view runs: opening another location interrupts it. */
    loader: yield* FiberHandle.make<void, never>(),
    /** Where requests an action starts run, closed with the store. */
    scope: yield* Effect.scope,
    origin: config.origin,
    confirmWithin: config.confirmWithin ?? Duration.seconds(15),
    pageWait: config.pageWait ?? Duration.seconds(1),
  }
})

/**
 * The repository feature's state for one tab:
 * - `repositories`: every cloned repository, synced by Electric and kept on the device; read-only.
 * - `clones`: clones this tab asked for that Postgres doesn't show yet, or that RepoApi refused.
 * - `trees`, `blobs`: the file lists and files this tab loaded, by commit.
 * - `refs`: the branches and tags this tab loaded, by repository and sync.
 * - `abouts`: what GitHub says of each repository this tab opened, by id.
 * - `heads`: the ready heads RepoApi's refs named for repositories whose rows Electric hadn't delivered ready, by id.
 * - `embeds`: each repository's view in a conversation this tab loaded, by the view's id (src/features/repo/embed.ts).
 * - `view`: where the routed view is, one row.
 * - the live queries frontends read (queries.ts), `loader`, `scope`, and the settings.
 */
export class RepoStore extends Context.Service<RepoStore, Effect.Success<ReturnType<typeof make>>>()(
  "@smthrs/mvp/repo/RepoStore",
) {
  /** The store; its collections cleaned up, its load interrupted and its Electric shape closed with the scope. */
  static readonly layer = (config: RepoConfig) => Layer.effect(RepoStore, make(config))
}
