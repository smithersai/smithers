import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Cache, Context, Effect, Exit, Layer, Option, Ref, Scope, Stream } from "effect"
import type { Comment, Item, ItemSummary } from "../issues/schema"
import { AuthStore } from "../auth/store"
import { repositoryAccessChanges, repositoryShapeSource, syncStatusAfter } from "../issues/source"
import { IssuesStore, syncStatusOf } from "../issues/store"
import { RepoStore } from "../repo/store"
import { CHECKS_SHAPE_ROUTE, PULL_COMMITS_SHAPE_ROUTE, PULLS_SHAPE_ROUTE, REVIEWS_SHAPE_ROUTE } from "./contract"
import {
  checksQuery,
  commentsQuery,
  commitsQuery,
  filesQuery,
  listQuery,
  pullQuery,
  reviewsQuery,
  viewQuery,
} from "./queries"
import { CheckRow, commitKey, FilesRow, PullCommitRow, PullRow, PullsView, ReviewRow, VIEW } from "./schema"
import { observePullShape } from "./shapeSync"

// Pull requests on this tab (decision 0012 §6, docs/features/pulls.md#the-browser): each repository's pull requests,
// their commits, reviews and checks in Postgres, synced by Electric per repository (`?repo=`, decision 0079 slice 1b)
// and kept on the device, beside that repository's issues (`IssuesStore.forRepo`), whose `items` and `comments` hold a
// pull request's title, body and conversation; the comparisons this tab read; and what the route shows.

/** Where pull requests sync from: ChatApi's origin. */
export interface PullsConfig {
  readonly origin: string
}

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/** A collection of `A` rows, synced or local: what the queries read. */
type Rows<A extends object> = Collection.Collection<A, any, any>

/** What the pull requests shape last said of access to a repository: the view's `pullStatus` and `installed`. */
interface PullStatus {
  readonly pullStatus: PullsView["pullStatus"]
  readonly installed: boolean
}

/**
 * One repository's pull requests on this tab: its shapes' rows, the live queries over them and its issues for the
 * routed page, what its pull requests shape last said of access (`status`), and `reconnect`.
 */
export interface RepoPulls {
  readonly id: string
  readonly pulls: Rows<PullRow>
  readonly commits: Rows<PullCommitRow>
  readonly reviews: Rows<ReviewRow>
  readonly checks: Rows<CheckRow>
  readonly list: Query<typeof listQuery>
  readonly pull: Query<typeof pullQuery>
  readonly comments: Query<typeof commentsQuery>
  readonly reviewList: Query<typeof reviewsQuery>
  readonly commitList: Query<typeof commitsQuery>
  readonly checkList: Query<typeof checksQuery>
  readonly status: Effect.Effect<PullStatus>
  readonly reconnect: Effect.Effect<void>
}

/**
 * The pull requests' state for one tab: `forRepo(id)`, repository `id`'s (`RepoPulls`), opened once with its issues;
 * `routed()`, the routed repository's, or `empty`'s, with no rows; `route(id)`, which says which repository the route
 * shows; the comparisons this tab read (`files`, `fileList`); and what the route shows (`view`, `viewState`).
 */
export class PullsStore extends Context.Service<
  PullsStore,
  {
    readonly files: Collection.Collection<FilesRow, string>
    readonly view: Collection.Collection<PullsView, string>
    readonly fileList: Query<typeof filesQuery>
    readonly viewState: Query<typeof viewQuery>
    readonly forRepo: (id: string) => Effect.Effect<RepoPulls>
    readonly routed: () => RepoPulls
    readonly route: (id: string) => Effect.Effect<void>
    readonly empty: RepoPulls
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/pulls/PullsStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. Needs the issues' store. */
  static readonly layer = (config: PullsConfig) => Layer.effect(PullsStore, make(config))
}

/** A row's key, its id, or a pull request's, its item: shared by the opened and the empty collections. */
const byId = (row: { readonly id: string }) => row.id
const byItem = (row: { readonly itemId: string }) => row.itemId

const make = Effect.fnUntraced(function* (config: PullsConfig) {
  const scope = yield* Effect.scope
  const issues = yield* IssuesStore
  const persistence = yield* Persistence.Persistence
  const source = yield* ShapeSource.ShapeSource
  const auth = yield* AuthStore
  const repos = yield* RepoStore
  const shape = (route: string, id: string) => ({
    url: `${config.origin}${route}?repo=${encodeURIComponent(id.slice("github/".length))}`,
    columnMapper: ElectricCollection.snakeCamelMapper(),
    parser: { int8: (value: string) => Number(value) },
  })
  const kept = { syncMode: "eager", persist: { schemaVersion: 1 } } as const
  const files = yield* Collection.local<FilesRow, string>({ id: "pull-files", schema: FilesRow, getKey: (row) => row.id })
  const view = yield* Collection.local<PullsView, string>({
    id: "pull-view",
    schema: PullsView,
    getKey: (row) => row.id,
    initialData: [{
      id: VIEW,
      owner: "",
      name: "",
      repoId: "",
      number: null,
      tab: "conversation",
      merging: false,
      mergeWriteId: null,
      mergeRefused: null,
      installed: false,
      pullStatus: "unknown",
    }],
  })

  /** The live queries over one repository's rows and its issues, for the routed page. */
  const queriesOf = (
    items: Rows<ItemSummary>,
    details: Rows<Item>,
    comments: Rows<Comment>,
    pulls: Rows<PullRow>,
    commits: Rows<PullCommitRow>,
    reviews: Rows<ReviewRow>,
    checks: Rows<CheckRow>,
  ) =>
    Effect.all({
      list: listQuery(view, items, pulls),
      pull: pullQuery(view, details, pulls),
      comments: commentsQuery(view, items, comments),
      reviewList: reviewsQuery(view, items, reviews),
      commitList: commitsQuery(view, items, commits),
      checkList: checksQuery(view, items, pulls, checks),
    })

  // A repository nobody opened: no rows, never a request.
  const emptyPulls = yield* Collection.local<PullRow, string>({ id: "pull-rows-none", schema: PullRow, getKey: byItem })
  const emptyCommits = yield* Collection.local<PullCommitRow, string>({ id: "pull-commits-none", schema: PullCommitRow, getKey: commitKey })
  const emptyReviews = yield* Collection.local<ReviewRow, string>({ id: "pull-reviews-none", schema: ReviewRow, getKey: byId })
  const emptyChecks = yield* Collection.local<CheckRow, string>({ id: "pull-checks-none", schema: CheckRow, getKey: byId })
  const empty: RepoPulls = {
    id: "",
    pulls: emptyPulls,
    commits: emptyCommits,
    reviews: emptyReviews,
    checks: emptyChecks,
    ...(yield* queriesOf(issues.empty.items, issues.empty.details, issues.empty.comments, emptyPulls, emptyCommits, emptyReviews, emptyChecks)),
    status: Effect.succeed({ pullStatus: "unknown", installed: false }),
    reconnect: Effect.void,
  }

  let routedId = ""
  /** Sets the view's access to `status` when `id` is the routed repository: another repository's shape never does. */
  const showStatus = (id: string, change: (row: PullStatus) => PullStatus) => (status: Ref.Ref<PullStatus>) =>
    Effect.gen(function* () {
      const next = yield* Ref.updateAndGet(status, change)
      if (id !== routedId) return
      yield* Effect.ignore(view.update(VIEW, (row) => {
        row.pullStatus = next.pullStatus
        row.installed = next.installed
      }))
    })

  /**
   * Opens repository `id`'s shapes, with its issues, and the followers of its authority and its pull requests shape, in
   * the store's scope. Each request waits for the device's authority on `id` (decision 0110), never another repository's.
   */
  const open = (id: string) =>
    Effect.gen(function* () {
      const repoIssues = yield* issues.forRepo(id)
      const authority = repositoryAccessChanges(auth, repos, id)
      const guarded = repositoryShapeSource(source, authority)
      // A pull request's commits, reviews and checks open only while the route shows one (decision 0112): the
      // repository's pages and its list of pull requests never ask for them.
      const detail = ShapeSource.gated(
        source,
        Stream.zipLatestWith(authority, detailShown(view), (status, shown) => status === "allowed" && shown),
      )
      const pulls = yield* ElectricCollection.make<PullRow>({
        id: `pull-rows:${id}`,
        schema: PullRow,
        getKey: byItem,
        shape: shape(PULLS_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, guarded))
      yield* observePullShape(pulls.sync).pipe(Effect.forkIn(scope, { startImmediately: true }))
      const commits = yield* ElectricCollection.make<PullCommitRow>({
        id: `pull-commits:${id}`,
        schema: PullCommitRow,
        getKey: commitKey,
        shape: shape(PULL_COMMITS_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, detail))
      const reviews = yield* ElectricCollection.make<ReviewRow>({
        id: `pull-reviews:${id}`,
        schema: ReviewRow,
        getKey: byId,
        shape: shape(REVIEWS_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, detail))
      const checks = yield* ElectricCollection.make<CheckRow>({
        id: `pull-checks:${id}`,
        schema: CheckRow,
        getKey: byId,
        shape: shape(CHECKS_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, detail))
      const status = yield* Ref.make<PullStatus>({ pullStatus: "unknown", installed: false })
      // The session and the repository's role decide whether this person may read its pull requests at all.
      yield* authority.pipe(
        Stream.runForEach((decided) =>
          showStatus(id, (row) => ({ pullStatus: decided, installed: decided === "allowed" && row.installed }))(status)
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // The pull requests shape's answers say only whether it is available, once the device allowed it.
      const awaitingPulls = yield* Ref.make(false)
      yield* pulls.sync.pipe(
        Stream.runForEach((event) => Effect.gen(function* () {
          const answered = syncStatusOf(event)
          if (answered === undefined) return
          yield* showStatus(id, (row) => ({ ...row, pullStatus: syncStatusAfter(row.pullStatus, answered) }))(status)
          if (answered !== "allowed") return
          if (yield* Ref.getAndSet(awaitingPulls, true)) return
          yield* pulls.currentApplied.pipe(
            Effect.flatMap(() => showStatus(id, (row) => ({ ...row, installed: row.pullStatus === "allowed" }))(status)),
            Effect.ensuring(Ref.set(awaitingPulls, false)),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        })),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // The first batch can finish while the other pull collections are being built. Its current installed receipt
      // survives a later live Sent event. currentApplied certifies only the latest accepted, decoded and installed
      // cursor; a refusal invalidates that cursor and cannot release either waiter (ElectricCollection.certify).
      yield* pulls.currentApplied.pipe(
        Effect.flatMap(() => showStatus(id, (row) => ({ ...row, installed: row.pullStatus === "allowed" }))(status)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      const repo: RepoPulls = {
        id,
        pulls,
        commits,
        reviews,
        checks,
        ...(yield* queriesOf(repoIssues.items, repoIssues.details, repoIssues.comments, pulls, commits, reviews, checks)),
        status: Ref.get(status),
        reconnect: Effect.all([pulls.reconnect, commits.reconnect, reviews.reconnect, checks.reconnect], { discard: true }),
      }
      repositories.set(id, repo)
      return repo
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(Persistence.Persistence, persistence),
      Effect.provideService(ShapeSource.ShapeSource, source),
      Effect.orDie,
    )
  // The repositories opened so far, by id; each opens once (`opening`).
  const repositories = new Map<string, RepoPulls>()
  const opening = yield* Cache.makeWith(open, {
    capacity: Number.MAX_SAFE_INTEGER,
    timeToLive: (exit) => Exit.isFailure(exit) ? 0 : Infinity,
  })

  return PullsStore.of({
    files,
    view,
    fileList: yield* filesQuery(files),
    viewState: yield* viewQuery(view, issues.writes),
    forRepo: (id) => Cache.get(opening, id),
    routed: () => repositories.get(routedId) ?? empty,
    route: (id) =>
      Effect.gen(function* () {
        routedId = id
        // What this repository's shape last said, shown at once: a page opened again needs no new answer.
        const known = yield* (yield* Cache.get(opening, id)).status
        yield* Effect.ignore(view.update(VIEW, (row) => {
          row.pullStatus = known.pullStatus
          row.installed = known.installed
        }))
      }),
    empty,
    scope,
  })
})

/** Whether the route shows one pull request: its number, current first, then each change. */
export const detailShown = (view: Collection.Collection<PullsView, string>): Stream.Stream<boolean> =>
  view.changes({ initial: true }).pipe(
    Stream.mapEffect(() => view.get(VIEW)),
    Stream.map((row) => Option.isSome(row) && row.value.number !== null),
    Stream.changes,
  )
