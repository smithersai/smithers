import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Clock, Context, Effect, Layer, Option, Ref, type Scope, Stream } from "effect"
import { ChatStore } from "../chat/store"
import { repoId } from "../repo/contract"
import {
  COMMENTS_SHAPE_ROUTE,
  ITEMS_SHAPE_ROUTE,
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
  syncedQuery,
  syncedRepositoriesQuery,
  triagePendingQuery,
  triageSettingsQuery,
  viewQuery,
} from "./queries"
import {
  Access,
  ACCESS,
  Comment,
  Draft,
  IssueView,
  Item,
  type QueuedWrite,
  type Requested,
  type Sending,
  SyncRow,
  syncKey,
  TriageSettings,
  VIEW,
  WriteRow,
} from "./schema"
import { observeIssueShape } from "./shapeSync"
import { ISSUE_WRITE, IssueWrites } from "./writes"

// Issues on this tab (decision 0012 §6, docs/features/issues.md#the-browser): the repository's issues, comments, sync
// state and the signed-in person's writes in Postgres, synced by Electric and kept on the device; this device's own
// writes (src/features/issues/writes.ts); the drafts, kept on the device; and what the route shows. The issue shapes
// start syncing once a page or a write needs them (`activate`), and then a follower drops each requested write whose
// GitHub row arrived.

/** Where the issues sync from: ChatApi's origin. A failed request waits `SyncPolicy.defaultPolicy`. */
export interface IssuesConfig {
  readonly origin: string
}

/** What a tab answers a write step: whether its outbox took the write. */
export interface Queued {
  readonly queued: boolean
}

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/**
 * The issues' state for one tab:
 * - `items`, `comments`, `sync`, `writes`: Postgres' rows, synced by Electric and kept on the device; read-only;
 * - `sending`, `requested`: this device's own writes (`IssueWrites`);
 * - `drafts`: the new-issue form's and each comment composer's text, kept on the device;
 * - `view`: what this tab's route shows, in memory;
 * - the live queries frontends read (queries.ts), and `scope`, where a press's dispatch runs;
 * - `activate`: starts the follower, once; `queue`: puts a write step's write in the device's outbox.
 */
export class IssuesStore extends Context.Service<
  IssuesStore,
  {
    readonly items: ElectricCollection.ElectricCollection<Item>
    readonly comments: ElectricCollection.ElectricCollection<Comment>
    readonly sync: ElectricCollection.ElectricCollection<SyncRow>
    readonly writes: ElectricCollection.ElectricCollection<WriteRow>
    readonly triageSettings: ElectricCollection.ElectricCollection<TriageSettings>
    readonly sending: Collection.Collection<Sending, string>
    readonly requested: Collection.Collection<Requested, string>
    readonly drafts: Collection.Collection<Draft, string>
    readonly view: Collection.Collection<IssueView, string>
    readonly access: Collection.Collection<Access, string>
    readonly list: Query<typeof listQuery>
    readonly allIssues: Query<typeof allIssuesQuery>
    readonly syncedRepositories: Query<typeof syncedRepositoriesQuery>
    readonly item: Query<typeof itemQuery>
    readonly conversation: Query<typeof conversationQuery>
    readonly synced: Query<typeof syncedQuery>
    readonly viewState: Query<typeof viewQuery>
    readonly accessState: Query<typeof accessQuery>
    readonly triage: Query<typeof triageSettingsQuery>
    readonly triagePending: Query<typeof triagePendingQuery>
    readonly scope: Scope.Scope
    readonly activate: Effect.Effect<void>
    readonly queue: (write: QueuedWrite) => Effect.Effect<Queued>
  }
>()("@smthrs/mvp/issues/IssuesStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. Needs chat's store's outbox. */
  static readonly layer = (config: IssuesConfig) => Layer.effect(IssuesStore, make(config))
}

const make = Effect.fnUntraced(function* (config: IssuesConfig) {
  const scope = yield* Effect.scope
  const chat = yield* ChatStore
  const { sending, requested } = yield* IssueWrites

  // Each shape is ChatApi's proxy of one table, kept on the device; `github_id` (int8) parsed to a number.
  const shape = (route: string) => ({
    url: `${config.origin}${route}`,
    columnMapper: ElectricCollection.snakeCamelMapper(),
    parser: { int8: (value: string) => Number(value) },
  })
  const kept = { syncMode: "eager", persist: { schemaVersion: 1 } } as const
  // Version 2: items carry their triage state and pin (decision 0012 §5).
  const items = yield* ElectricCollection.make<Item>({
    id: "issue-items",
    schema: Item,
    getKey: (row) => row.id,
    shape: shape(ITEMS_SHAPE_ROUTE),
    syncMode: "eager",
    persist: { schemaVersion: 3 },
  })
  yield* observeIssueShape(items.sync).pipe(Effect.forkScoped)
  const comments = yield* ElectricCollection.make<Comment>({
    id: "issue-comments",
    schema: Comment,
    getKey: (row) => row.id,
    shape: shape(COMMENTS_SHAPE_ROUTE),
    ...kept,
  })
  const sync = yield* ElectricCollection.make<SyncRow>({
    id: "issue-sync",
    schema: SyncRow,
    getKey: syncKey,
    shape: shape(SYNC_SHAPE_ROUTE),
    ...kept,
  })
  // Version 2: a Publish's or an Update branch's write names its branch (docs/features/branch-publish.md).
  const writes = yield* ElectricCollection.make<WriteRow>({
    id: "issue-writes",
    schema: WriteRow,
    getKey: (row) => row.id,
    shape: shape(WRITES_SHAPE_ROUTE),
    syncMode: "eager",
    persist: { schemaVersion: 2 },
  })
  const triageSettings = yield* ElectricCollection.make<TriageSettings>({
    id: "issue-triage-settings",
    schema: TriageSettings,
    getKey: (row) => row.repoId,
    shape: shape(TRIAGE_SETTINGS_SHAPE_ROUTE),
    ...kept,
  })
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

  const access = yield* Collection.local<Access, string>({
    id: "issue-access",
    schema: Access,
    getKey: (row) => row.id,
    initialData: [{ id: ACCESS, status: "unknown", installed: false }],
  })

  // The followers: a requested write whose GitHub row arrived goes, and the synced row shows in its place; and the
  // items shape's answers say whether this person may read the repository's issues at all.
  const delivered = yield* deliveredQuery(requested, items, comments, writes)
  const started = yield* Ref.make(false)
  const awaitingItems = yield* Ref.make(false)
  yield* items.sync.pipe(
    Stream.runForEach((event) => Effect.gen(function* () {
      const status = accessOf(event)
      if (status === undefined) return
      yield* Effect.ignore(access.update(ACCESS, (row) => {
        // A failed reconnect cannot undo a current authorization refusal and reveal a cached private item.
        if (status !== "unavailable" || (row.status !== "sign_in" && row.status !== "forbidden")) row.status = status
        // An installed batch stays readable through a failed live poll. A cold shape has no such receipt.
        if (status === "sign_in" || status === "forbidden") row.installed = false
      }))
      // A 2xx precedes installation. Restored rows can also make `preload` ready before the network answers.
      if (status !== "allowed" || (yield* Ref.getAndSet(awaitingItems, true))) return
      yield* items.currentApplied.pipe(
        Effect.flatMap(() => Effect.ignore(access.update(ACCESS, (row) => {
          row.installed = true
        }))),
        Effect.ensuring(Ref.set(awaitingItems, false)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })),
    Effect.forkIn(scope, { startImmediately: true }),
  )
  // A fast first batch can be followed by a live Sent before this listener subscribes. Its installed receipt remains
  // current until a refusal or failed request invalidates it. currentApplied only resumes for the latest accepted,
  // decoded and installed cursor (ElectricCollection.certify); a refused request cannot release either waiter.
  yield* items.currentApplied.pipe(
    Effect.flatMap(() => Effect.ignore(access.update(ACCESS, (row) => {
      row.status = "allowed"
      row.installed = true
    }))),
    Effect.forkIn(scope, { startImmediately: true }),
  )
  const activate = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return
    yield* delivered.rows.pipe(
      Stream.runForEach((rows) => Effect.forEach(rows, ({ id }) => Effect.ignore(requested.delete(id)), { discard: true })),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  /**
   * Puts `write` in the device's outbox once: a write it holds or the route took already is queued. This tab takes the
   * outbox's lead first, as a tab a person asks in does (decision 0002 §1), so the outbox admits it here. Answers
   * whether the outbox stored it.
   */
  const queue = (write: QueuedWrite) =>
    Effect.gen(function* () {
      yield* activate
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
    items,
    comments,
    sync,
    writes,
    triageSettings,
    sending,
    requested,
    drafts,
    view,
    access,
    list: yield* listQuery(view, items, requested, sending, writes),
    allIssues: yield* allIssuesQuery(items),
    syncedRepositories: yield* syncedRepositoriesQuery(sync),
    item: yield* itemQuery(view, items),
    conversation: yield* conversationQuery(view, items, comments, requested, sending, writes),
    synced: yield* syncedQuery(view, sync),
    viewState: yield* viewQuery(view, drafts),
    accessState: yield* accessQuery(access),
    triage: yield* triageSettingsQuery(view, triageSettings),
    triagePending: yield* triagePendingQuery(view, requested, sending, writes),
    scope,
    activate,
    queue,
  })
})

/** `owner/name`'s repository id; `RepoName` has checked its shape. */
export const repoIdOf = (repo: string): string => {
  const [owner, name] = repo.split("/") as [string, string]
  return repoId(owner, name)
}

/**
 * What one of the items shape's sync events says of access: allowed once a request succeeds; refused when ChatApi
 * stopped the shape with `401` (sign in) or `403` (no role); a failed request or other stop is unavailable until
 * another request succeeds. `Sent` says nothing new.
 */
export const accessOf = (event: ElectricCollection.SyncEvent): Access["status"] | undefined =>
  event._tag === "Succeeded"
    ? "allowed"
    : event._tag === "Stopped" && event.error.status === 401
    ? "sign_in"
    : event._tag === "Stopped" && event.error.status === 403
    ? "forbidden"
    : event._tag === "Failed" || event._tag === "Stopped"
    ? "unavailable"
    : undefined
