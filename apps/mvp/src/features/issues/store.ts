import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Cache, Clock, Context, Effect, Exit, Layer, Option, Ref, Scope, Stream } from "effect"
import { signedInChanges, signedInShapeSource } from "../auth/source"
import { AuthStore } from "../auth/store"
import { ChatStore } from "../chat/store"
import { role } from "../repo/actions"
import { RepoClient } from "../repo/api"
import { repoId } from "../repo/contract"
import { RepoStore } from "../repo/store"
import { repositoryAccessChanges, repositoryShapeSource, syncStatusAfter, type Transport } from "./source"
import {
  COMMENTS_SHAPE_ROUTE,
  ITEMS_SHAPE_ROUTE,
  ITEM_SUMMARIES_SHAPE_ROUTE,
  SYNC_SHAPE_ROUTE,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
  WRITES_SHAPE_ROUTE,
} from "./contract"
import {
  accessQuery,
  allIssuesQuery,
  conversationQuery,
  deliveredQuery,
  itemQuery,
  listQuery,
  type LiveRows,
  rowsQuery,
  syncedQuery,
  syncedRepositoriesQuery,
  triagePendingQuery,
  triageSettingsQuery,
  unsyncedQuery,
  viewQuery,
} from "./queries"
import {
  ACCESS,
  Access,
  Comment,
  Draft,
  IssueView,
  Item,
  ItemSummary,
  OpenedRepository,
  type QueuedWrite,
  type Requested,
  type Sending,
  syncKey,
  SyncRow,
  TriageSettings,
  VIEW,
  WriteRow,
} from "./schema"
import { observeIssueShape } from "./shapeSync"
import { ISSUE_WRITE, IssueWrites } from "./writes"

// Issues on this tab (decision 0012 §6, docs/features/issues.md#the-browser): each repository's issues, comments, sync
// state and triage settings in Postgres, synced by Electric per repository (`?repo=`, decision 0079 slice 1b) and kept
// on the device; the signed-in person's writes; this device's own writes (src/features/issues/writes.ts); the drafts,
// kept on the device; and what the route shows. A repository's shapes start syncing once a page or a write needs them
// (`forRepo`), and then a follower drops each requested write of that repository whose GitHub row arrived.

/** Where the issues sync from: ChatApi's origin. A failed request waits `SyncPolicy.defaultPolicy`. */
export interface IssuesConfig {
  readonly origin: string
}

/** What a tab answers a write step: whether its outbox took the write. */
export interface Queued {
  readonly queued: boolean
}

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/** A collection of `A` rows, synced or local: what the queries read. */
type Rows<A extends object> = Collection.Collection<A, any, any>

/**
 * One repository's issues on this tab: its shapes' rows, whether this person may read them (`access`), the live
 * queries over them for the routed page, and `reconnect`, which sends its shapes' waiting requests now.
 */
export interface RepoIssues {
  readonly id: string
  readonly items: Rows<ItemSummary>
  readonly details: Rows<Item>
  readonly requestDetails: Effect.Effect<void>
  readonly comments: Rows<Comment>
  readonly sync: Rows<SyncRow>
  readonly triageSettings: Rows<TriageSettings>
  readonly access: Collection.Collection<Access, string>
  /** Its issues and pull requests, and its sync rows, every row, live: a home's `issues` block reads them. */
  readonly itemRows: LiveRows<ItemSummary>
  readonly syncRows: LiveRows<SyncRow>
  /** Its issues and pull requests newest first, and its sync rows whose walk completed: its issues view in a conversation. */
  readonly newestFirst: Query<typeof allIssuesQuery>
  readonly walked: Query<typeof syncedRepositoriesQuery>
  readonly list: Query<typeof listQuery>
  readonly item: Query<typeof itemQuery>
  readonly conversation: Query<typeof conversationQuery>
  readonly synced: Query<typeof syncedQuery>
  readonly unsynced: Query<typeof unsyncedQuery>
  readonly triage: Query<typeof triageSettingsQuery>
  readonly triagePending: Query<typeof triagePendingQuery>
  readonly accessState: Query<typeof accessQuery>
  readonly reconnect: Effect.Effect<void>
}

/**
 * The issues' state for one tab:
 * - `writes`: the signed-in person's writes in Postgres, synced by Electric and kept on the device; read-only;
 * - `sending`, `requested`: this device's own writes (`IssueWrites`);
 * - `drafts`: the new-issue form's and each comment composer's text, kept on the device;
 * - `view`: what this tab's route shows, in memory, and `viewState`, its live query;
 * - `forRepo(id)`: repository `id`'s issues (`RepoIssues`), opened once; `opened(id)`, the same if a page or a write
 *   opened them; `routed()`, the routed repository's, or `empty`, a repository nobody opened, with no rows;
 * - `route(id)`: says which repository the route shows; `scope`, where a press's dispatch runs;
 * - `queue`: puts a write step's write in the device's outbox.
 */
export class IssuesStore extends Context.Service<
  IssuesStore,
  {
    readonly writes: ElectricCollection.ElectricCollection<WriteRow>
    readonly sending: Collection.Collection<Sending, string>
    readonly requested: Collection.Collection<Requested, string>
    readonly drafts: Collection.Collection<Draft, string>
    readonly view: Collection.Collection<IssueView, string>
    readonly viewState: Query<typeof viewQuery>
    readonly forRepo: (id: string, number?: number) => Effect.Effect<RepoIssues>
    readonly opened: (id: string) => RepoIssues | undefined
    readonly openedState: LiveRows<OpenedRepository>
    readonly routed: () => RepoIssues
    readonly route: (id: string, number?: number) => Effect.Effect<void>
    readonly empty: RepoIssues
    readonly scope: Scope.Scope
    readonly queue: (write: QueuedWrite) => Effect.Effect<Queued>
  }
>()("@smthrs/mvp/issues/IssuesStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. Needs chat's store's outbox. */
  static readonly layer = (config: IssuesConfig) => Layer.effect(IssuesStore, make(config))
}

/** A row's key, its id, or its repository for a repository's one row: shared by the opened and the empty collections. */
const byId = (row: { readonly id: string }) => row.id
const byRepo = (row: { readonly repoId: string }) => row.repoId

const make = Effect.fnUntraced(function* (config: IssuesConfig) {
  const scope = yield* Effect.scope
  const chat = yield* ChatStore
  const { sending, requested } = yield* IssueWrites
  const persistence = yield* Persistence.Persistence
  const source = yield* ShapeSource.ShapeSource
  const auth = yield* AuthStore
  const repos = yield* RepoStore
  const client = yield* RepoClient

  // Each shape is ChatApi's proxy of one table, kept on the device; `github_id` (int8) parsed to a number. A
  // repository's names it with `?repo=`.
  const shape = (route: string, id?: string) => ({
    url: `${config.origin}${route}${id === undefined ? "" : `?repo=${encodeURIComponent(id.slice("github/".length))}`}`,
    columnMapper: ElectricCollection.snakeCamelMapper(),
    parser: { int8: (value: string) => Number(value) },
  })
  const kept = { syncMode: "eager", persist: { schemaVersion: 1 } } as const
  // Version 2: a Publish's or an Update branch's write names its branch (docs/features/branch-publish.md).
  const writes = yield* ElectricCollection.make<WriteRow>({
    id: "issue-writes",
    schema: WriteRow,
    getKey: (row) => row.id,
    shape: shape(WRITES_SHAPE_ROUTE),
    syncMode: "eager",
    persist: { schemaVersion: 2 },
  }).pipe(Effect.provideService(ShapeSource.ShapeSource, signedInShapeSource(source, auth)))
  const drafts = yield* Collection.persisted<Draft, string>({
    id: "issue-drafts",
    schema: Draft,
    getKey: (row) => row.id,
    schemaVersion: 1,
  })
  const view = yield* Collection.local<IssueView, string>({
    id: "issue-view",
    schema: IssueView,
    getKey: (row) => row.id,
    initialData: [{ id: VIEW, owner: "", name: "", repoId: "", number: null, draftKey: "", submitting: false }],
  })

  const requestedDetails = yield* Collection.local<OpenedRepository, string>({
    id: "issue-detail-demand",
    schema: OpenedRepository,
    getKey: byId,
  })

  /** The live queries over one repository's rows, for the routed page. */
  const queriesOf = (
    items: Rows<ItemSummary>,
    details: Rows<Item>,
    comments: Rows<Comment>,
    sync: Rows<SyncRow>,
    triageSettings: Rows<TriageSettings>,
    access: Collection.Collection<Access, string>,
  ) =>
    Effect.all({
      itemRows: rowsQuery(items),
      syncRows: rowsQuery(sync),
      newestFirst: allIssuesQuery(items),
      walked: syncedRepositoriesQuery(sync),
      list: listQuery(view, items, requested, sending, writes),
      item: itemQuery(view, details),
      conversation: conversationQuery(view, items, comments, requested, sending, writes),
      synced: syncedQuery(view, sync),
      unsynced: unsyncedQuery(sync),
      triage: triageSettingsQuery(view, triageSettings),
      triagePending: triagePendingQuery(view, requested, sending, writes),
      accessState: accessQuery(access),
    })

  /** Repository `id`'s access row, unknown until the session and its role answer. */
  const accessFor = (id: string) =>
    Collection.local<Access, string>({
      id: `issue-access:${id}`,
      schema: Access,
      getKey: (row) => row.id,
      initialData: [{ id: ACCESS, status: "unknown", installed: false }],
    })

  // A repository nobody opened: no rows, never a request.
  const emptyItems = yield* Collection.local<ItemSummary, string>({ id: "issue-items-none", schema: ItemSummary, getKey: byId })
  const emptyDetails = yield* Collection.local<Item, string>({ id: "issue-details-none", schema: Item, getKey: byId })
  const emptyComments = yield* Collection.local<Comment, string>({ id: "issue-comments-none", schema: Comment, getKey: byId })
  const emptySync = yield* Collection.local<SyncRow, string>({ id: "issue-sync-none", schema: SyncRow, getKey: syncKey })
  const emptyTriage = yield* Collection.local<TriageSettings, string>({
    id: "issue-triage-settings-none",
    schema: TriageSettings,
    getKey: byRepo,
  })
  const emptyAccess = yield* accessFor("none")
  const empty: RepoIssues = {
    id: "",
    items: emptyItems,
    details: emptyDetails,
    requestDetails: Effect.void,
    comments: emptyComments,
    sync: emptySync,
    triageSettings: emptyTriage,
    access: emptyAccess,
    ...(yield* queriesOf(emptyItems, emptyDetails, emptyComments, emptySync, emptyTriage, emptyAccess)),
    reconnect: Effect.void,
  }

  const followAvailability = (collection: ElectricCollection.ElectricCollection<ItemSummary> | ElectricCollection.ElectricCollection<Item>, access: Collection.Collection<Access, string>) =>
    Effect.gen(function* () {
      const installed = yield* Ref.make(false)
      const lastTransport = yield* Ref.make<Transport>("allowed")
      const publish = Effect.gen(function* () {
        const status = yield* Ref.get(lastTransport)
        const hasRows = yield* Ref.get(installed)
        yield* Effect.ignore(access.update(ACCESS, (row) => {
          row.status = syncStatusAfter(row.status, status)
          row.installed = hasRows && ["allowed", "unavailable", "elsewhere"].includes(row.status)
        }))
      })
      const certify = Effect.gen(function* () {
        yield* Ref.set(installed, true)
        yield* publish
      })
      // Each projection retains its own installed receipt across navigations.
      yield* view.changes({ initial: true }).pipe(
        Stream.runForEach(() => publish),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      const awaiting = yield* Ref.make(false)
      yield* collection.sync.pipe(
        Stream.runForEach((event) => Effect.gen(function* () {
          const status = syncStatusOf(event)
          if (status === undefined) return
          yield* Ref.set(lastTransport, status)
          yield* publish
          if (status !== "allowed" || (yield* Ref.getAndSet(awaiting, true))) return
          yield* collection.currentApplied.pipe(
            Effect.andThen(certify),
            Effect.ensuring(Ref.set(awaiting, false)),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        })),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* collection.currentApplied.pipe(
        Effect.andThen(certify),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

  /**
   * Opens repository `id`'s shapes, its access follower and its delivered follower, in the store's scope. Each request
   * waits for the device's authority on `id` (decision 0110), never another repository's.
   */
  const open = (id: string) =>
    Effect.gen(function* () {
      const authority = repositoryAccessChanges(auth, repos, id)
      const guarded = repositoryShapeSource(source, authority)
      // Lists retain all count/search facts; large bodies and comments wait for a detail page.
      const items = yield* ElectricCollection.make<ItemSummary>({
        id: `issue-summaries:${id}`,
        schema: ItemSummary,
        getKey: byId,
        shape: shape(ITEM_SUMMARIES_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, guarded))
      const bodyDemand = ShapeSource.gated(source, Stream.zipLatestWith(
        authority,
        requestedDetails.changes({ initial: true }).pipe(Stream.mapEffect(() => Effect.map(requestedDetails.get(id), Option.isSome))),
        (status, needed) => status === "allowed" && needed,
      ))
      const details = yield* ElectricCollection.make<Item>({
        id: `issue-items:${id}`,
        schema: Item,
        getKey: byId,
        shape: shape(ITEMS_SHAPE_ROUTE, id),
        syncMode: "eager",
        persist: { schemaVersion: 3 },
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, bodyDemand))
      yield* observeIssueShape(items.sync).pipe(Effect.annotateLogs({ projection: "summary" }), Effect.forkIn(scope, { startImmediately: true }))
      const comments = yield* ElectricCollection.make<Comment>({
        id: `issue-comments:${id}`,
        schema: Comment,
        getKey: byId,
        shape: shape(COMMENTS_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, bodyDemand))
      const sync = yield* ElectricCollection.make<SyncRow>({
        id: `issue-sync:${id}`,
        schema: SyncRow,
        getKey: syncKey,
        shape: shape(SYNC_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, guarded))
      const triageSettings = yield* ElectricCollection.make<TriageSettings>({
        id: `issue-triage-settings:${id}`,
        schema: TriageSettings,
        getKey: byRepo,
        shape: shape(TRIAGE_SETTINGS_SHAPE_ROUTE, id),
        ...kept,
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, ShapeSource.gated(
        source,
        Stream.zipLatestWith(signedInChanges(auth), authority, (signedIn, status) => signedIn && status === "allowed"),
      )))
      const access = yield* accessFor(id)
      // The session and the repository's role decide whether this person may read its issues at all. A tab with no
      // answer for it yet asks ChatApi (a route asks too, `repo.role`): until then nothing is requested.
      if (Option.isNone(yield* repos.roles.get(id))) {
        const [, owner = "", name = ""] = id.split("/")
        yield* role(owner, name).pipe(
          Effect.provideService(RepoStore, repos),
          Effect.provideService(RepoClient, client),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      }
      yield* authority.pipe(
        Stream.runForEach((status) => Effect.ignore(access.update(ACCESS, (row) => {
          row.status = status
          if (status !== "allowed") row.installed = false
        }))),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // Availability follows the shape the page reads. A summary receipt never certifies a missing detail body.
      yield* followAvailability(items, access)
      yield* observeIssueShape(details.sync).pipe(Effect.annotateLogs({ projection: "detail" }), Effect.forkIn(scope, { startImmediately: true }))
      // The follower: a requested write of this repository whose GitHub row arrived goes, and the synced row shows in
      // its place.
      const delivered = yield* deliveredQuery(requested, items, comments, writes)
      yield* delivered.rows.pipe(
        Stream.runForEach((rows) => Effect.forEach(rows, ({ id }) => Effect.ignore(requested.delete(id)), { discard: true })),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      const repo: RepoIssues = {
        id,
        items,
        details,
        requestDetails: Effect.ignore(requestedDetails.insert({ id })),
        comments,
        sync,
        triageSettings,
        access,
        ...(yield* queriesOf(items, details, comments, sync, triageSettings, access)),
        reconnect: Effect.all([items.reconnect, details.reconnect, comments.reconnect, sync.reconnect, triageSettings.reconnect], {
          discard: true,
        }),
      }
      repositories.set(id, repo)
      yield* Effect.ignore(openedRepositories.insert({ id }))
      return repo
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(Persistence.Persistence, persistence),
      Effect.provideService(ShapeSource.ShapeSource, source),
      Effect.orDie,
    )
  // The repositories opened so far, by id, for frontends to read at once; each opens once (`opening`). Their ids, live,
  // redraw a view that waits for its repository's issues.
  const repositories = new Map<string, RepoIssues>()
  const openedRepositories = yield* Collection.local<OpenedRepository, string>({
    id: "issue-opened",
    schema: OpenedRepository,
    getKey: (row) => row.id,
  })
  const opening = yield* Cache.makeWith(open, {
    capacity: Number.MAX_SAFE_INTEGER,
    timeToLive: (exit) => Exit.isFailure(exit) ? 0 : Infinity,
  })
  const itemOpening = yield* Cache.makeWith((key: string) => Effect.gen(function* () {
    const split = key.lastIndexOf("#")
    const id = key.slice(0, split)
    const number = Number(key.slice(split + 1))
    const repo = yield* Cache.get(opening, id)
    const authority = repositoryAccessChanges(auth, repos, id)
    const guarded = repositoryShapeSource(source, authority)
    const selectedShape = (route: string) => ({ ...shape(route, id), url: `${shape(route, id).url}&number=${number}` })
    const details = yield* ElectricCollection.make<Item>({
      id: `issue-items:${key}`, schema: Item, getKey: byId,
      shape: selectedShape(ITEMS_SHAPE_ROUTE), syncMode: "eager", persist: { schemaVersion: 3 },
    }).pipe(Effect.provideService(ShapeSource.ShapeSource, guarded))
    const comments = yield* ElectricCollection.make<Comment>({
      id: `issue-comments:${key}`, schema: Comment, getKey: byId,
      shape: selectedShape(COMMENTS_SHAPE_ROUTE), ...kept,
    }).pipe(Effect.provideService(ShapeSource.ShapeSource, guarded))
    const access = yield* accessFor(key)
    const knownAccess = Option.getOrThrow(yield* repo.access.get(ACCESS))
    yield* access.update(ACCESS, (row) => { row.status = knownAccess.status })
    yield* authority.pipe(Stream.runForEach((status) => Effect.ignore(access.update(ACCESS, (row) => {
      row.status = status
      if (status !== "allowed") row.installed = false
    }))), Effect.forkIn(scope, { startImmediately: true }))
    yield* followAvailability(details, access)
    yield* observeIssueShape(details.sync).pipe(Effect.annotateLogs({ projection: "item" }), Effect.forkIn(scope, { startImmediately: true }))
    const delivered = yield* deliveredQuery(requested, repo.items, comments, writes)
    yield* delivered.rows.pipe(
      Stream.runForEach((rows) => Effect.forEach(rows, ({ id }) => Effect.ignore(requested.delete(id)), { discard: true })),
      Effect.forkIn(scope, { startImmediately: true }),
    )
    const selected: RepoIssues = {
      ...repo, details, comments, access,
      ...(yield* queriesOf(repo.items, details, comments, repo.sync, repo.triageSettings, access)),
      reconnect: Effect.all([repo.reconnect, details.reconnect, comments.reconnect], { discard: true }),
    }
    return selected
  }).pipe(Scope.provide(scope), Effect.provideService(Persistence.Persistence, persistence), Effect.orDie), {
    capacity: Number.MAX_SAFE_INTEGER,
    timeToLive: (exit) => Exit.isFailure(exit) ? 0 : Infinity,
  })
  const forRepo = (id: string, number?: number) => number === undefined
    ? Cache.get(opening, id) : Cache.get(itemOpening, `${id}#${number}`)
  let routedRepo = empty
  const routed = () => routedRepo

  /**
   * Puts `write` in the device's outbox once: a write it holds or the route took already is queued. Its repository's
   * issues open first, so the follower drops it once its row arrives. This tab takes the outbox's lead first, as a tab
   * a person asks in does (decision 0002 §1), so the outbox admits it here. Answers whether the outbox stored it.
   */
  const queue = (write: QueuedWrite) =>
    Effect.gen(function* () {
      yield* forRepo(repoIdOf(write.repo))
      if (Option.isSome(yield* sending.get(write.id)) || Option.isSome(yield* requested.get(write.id))) {
        return { queued: true }
      }
      yield* chat.lead
      const row: Sending = {
        ...write,
        repoId: repoIdOf(write.repo),
        queuedAt: yield* Clock.currentTimeMillis,
        v: 3,
      }
      const admitted = yield* chat.outbox
        .transact(ISSUE_WRITE, { idempotencyKey: write.id }, Effect.asVoid(sending.insert(row)))
        .pipe(Effect.flatMap((taken) => taken.admitted), Effect.result)
      return { queued: admitted._tag === "Success" }
    })

  return IssuesStore.of({
    writes,
    sending,
    requested,
    drafts,
    view,
    viewState: yield* viewQuery(view, drafts),
    forRepo,
    opened: (id) => repositories.get(id),
    openedState: yield* rowsQuery(openedRepositories),
    routed,
    route: (id, number) => Effect.map(forRepo(id, number), (repo) => { routedRepo = repo }),
    empty,
    scope,
    queue,
  })
})

/** `owner/name`'s repository id; `RepoName` has checked its shape. */
export const repoIdOf = (repo: string): string => {
  const [owner, name] = repo.split("/") as [string, string]
  return repoId(owner, name)
}

/**
 * What one of a shape's sync events says of its availability, never of authority (decision 0110): it answered; it
 * stopped `404`, a repository the deployment doesn't act on (decision 0079 slice 1b); or it failed or stopped otherwise.
 * `Sent` says nothing new.
 */
export const syncStatusOf = (event: ElectricCollection.SyncEvent): Transport | undefined =>
  event._tag === "Succeeded"
    ? "allowed"
    : event._tag === "Stopped" && event.error.status === 404
    ? "elsewhere"
    : event._tag === "Failed" || event._tag === "Stopped"
    ? "unavailable"
    : undefined
