import { makePins, pinnedQuery } from "../pins/store"
import { observeLoad } from "./load"
import { makeLane, followSummaries } from "../timeline/store"
import { answerCannotFinish } from "./answerEnd"
import { ElectricCollection, type ShapeSource } from "@smthrs/effect-electric"
import { Collection, Outbox, Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Metric,
  Option,
  Ref,
  type Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { type DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { ChatDraftsStore, ChatUnsentStore, outboxUpgrade } from "../../device/registry"
import type { ChatDraftV1 } from "../../device/history"
import { OutboxWrites } from "../../outbox"
import { ViewsStore } from "../views/store"
import { ChatClient } from "./api"
import { PAGE_SIZE, SHAPE_ROUTE } from "./contract"
import { askFailures, connectionDrops, firstAnswerText } from "./metrics"
import {
  composerQuery,
  connectionQuery,
  conversationQuery,
  historyQuery,
  latestQuery,
  placeQuery,
  queuedQuery,
  shownQuery,
} from "./queries"
import { FormValues } from "../views/schema"
import {
  Asking,
  COMPOSER,
  Composer,
  CONNECTION,
  Connection,
  HISTORY,
  History,
  Message,
  PLACE,
  Place,
  Source,
  Unsent,
  type UnsentReason,
  type QuestionSubmitted,
} from "./schema"

/**
 * Where this tab syncs from, its deadlines and its sync policy. It asks through `ChatClient`, syncs through
 * `ShapeSource`, and keeps its rows through `Persistence`: the services the layer is given.
 */
export interface ChatConfig {
  /** Electric's shape for `messages`, served by ChatApi's proxy, which fixes the table. */
  readonly shapeUrl: string
  /** How long Electric gets to deliver a question ChatApi took before the send counts as failed. Default 15 s. */
  readonly confirmWithin?: Duration.Input
  /**
   * How long shape requests or sends may keep failing, with the browser online, before the pill says the device is
   * offline, with Retry. Default 10 s.
   */
  readonly unreachableAfter?: Duration.Input
  /** How long a failed shape request waits before it is sent again. Default `SyncPolicy.defaultPolicy`. */
  readonly retry?: Schedule.Schedule<unknown, ShapeSource.RequestFailed>
  /** How many of the most recent messages the conversation shows, and how many more "Load earlier" adds. */
  readonly pageSize?: number
}

/**
 * What the host gives chat: the outbox's entry point, storage and network detector; the lock service that elects the
 * tab leading the outbox (`@smthrs/platform-browser`'s `WebLock`); and whether the browser says it is online now
 * (`navigator.onLine`).
 */
export interface ChatHost {
  readonly outbox: Omit<Outbox.Options<never>, "collections" | "mutations" | "leader">
  readonly lock: Outbox.Lock
  readonly isOnline: () => boolean
}

/** The Web Lock the tab leading the outbox holds. */
export const OUTBOX_LOCK = "smithers-outbox"

/** ChatApi's shape on `origin`, as the browser reaches it. */
export const chatConfig = (origin: string, options: Omit<ChatConfig, "shapeUrl">): ChatConfig => ({
  shapeUrl: `${origin}${SHAPE_ROUTE}`,
  ...options,
})

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/**
 * One branch's conversation on this tab (decision 0013 §1): its messages and views in Postgres, synced by Electric and
 * kept on the device, with the live queries a frontend reads and this tab's window of it. The home conversation `/app`
 * shows is the store's own `messages`, `conversation`, `latest`, `shown`, `queued` and `history`.
 */
export interface ConversationState {
  readonly conversationId: string
  readonly pinned: Query<typeof pinnedQuery>
  readonly messages: ElectricCollection.ElectricCollection<Message>
  readonly conversation: Query<typeof conversationQuery>
  readonly latest: Query<typeof latestQuery>
  readonly shown: Query<typeof shownQuery>
  readonly queued: Query<typeof queuedQuery>
  readonly history: Collection.Collection<History, string>
  readonly historyState: Query<typeof historyQuery>
}

/**
 * Chat's state for one tab:
 * - `messages`: the conversation in Postgres, synced by Electric and kept on the device; read-only.
 * - `asking`: questions the outbox holds, as the optimistic rows of their writes; in memory, restored by the outbox.
 * - `unsent`: questions the server refused or the outbox couldn't take; kept on the device.
 * - `drafts`: the composer's draft in each conversation whose prompt isn't shared; kept on the device, so a reload finds
 *   it.
 * - `composer`, `connection`, `history`: this tab's own state, in memory.
 * - `outbox`: the durable outbox every ask goes through.
 * - the live queries frontends read (queries.ts), and `scope`, where background work an action starts runs.
 */
export class ChatStore extends Context.Service<
  ChatStore,
  {
    readonly pinState: Effect.Success<ReturnType<typeof makePins>>
    readonly pinned: Query<typeof pinnedQuery>
    readonly messages: ElectricCollection.ElectricCollection<Message>
    readonly asking: Collection.Collection<Asking, string>
    readonly unsent: Collection.Collection<Unsent, string>
    readonly drafts: Collection.Collection<ChatDraftV1, string>
    readonly composer: Collection.Collection<Composer, string>
    readonly connection: Collection.Collection<Connection, string>
    readonly history: Collection.Collection<History, string>
    readonly outbox: Outbox.Service
    readonly conversation: Query<typeof conversationQuery>
    readonly latest: Query<typeof latestQuery>
    readonly shown: Query<typeof shownQuery>
    readonly queued: Query<typeof queuedQuery>
    readonly composerState: Query<typeof composerQuery>
    readonly connectionState: Query<typeof connectionQuery>
    readonly historyState: Query<typeof historyQuery>
    /** Which conversation this tab shows and asks in: a branch's, or `null` for the home conversation. One row. */
    readonly place: Collection.Collection<Place, string>
    readonly placeState: Query<typeof placeQuery>
    /** A branch conversation, opened on first use and kept for as long as the store lives. */
    readonly open: (conversationId: string) => Effect.Effect<ConversationState>
    /** A branch conversation opened before, if any: what a frontend reads without waiting. */
    readonly opened: (conversationId: string) => ConversationState | undefined
    /**
     * Has `build` run for each branch conversation opened, those open now and each one `open` opens from now on, before
     * `open` returns it: a feature keeps its own state per conversation beside chat's, whole by the time a tab shows it.
     */
    readonly forEachOpened: (build: (opened: ConversationState) => Effect.Effect<void>) => Effect.Effect<void>
    readonly scope: Scope.Scope
    readonly pageSize: number
    /** When this tab last queued a question: each takes a later `queuedAt`, so questions asked in one millisecond keep their order. */
    readonly lastQueuedAt: Ref.Ref<number>
    readonly draftRevision: Ref.Ref<number>
    readonly pendingAsks: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<QuestionSubmitted>>>
    /** The browser went offline (`true`) or online (`false`). */
    readonly browserOffline: (offline: boolean) => Effect.Effect<void>
    /** Whether the browser says it is online: `isOnline` at boot, then its `online` and `offline` events. */
    readonly browserOnline: SubscriptionRef.SubscriptionRef<boolean>
    /** Retry: syncs and sends now, and gives failing requests `unreachableAfter` again. */
    readonly retryNow: Effect.Effect<void>
    /**
     * Makes this tab lead the outbox at once, as the tab a person is using does (decision 0002 §1), and completes once
     * it leads. The tab that led sends nothing more until it leads again.
     */
    readonly lead: Effect.Effect<void>
  }
>()("@smthrs/mvp/chat/ChatStore") {
  /**
   * The store; its collections cleaned up, its outbox stopped and its Electric shape closed when the scope closes. It
   * dispatches each question ChatApi takes to this device's agent through `FlowDispatch`, and its outbox sends the
   * other features' writes too (`OutboxWrites`).
   */
  static readonly layer = (config: ChatConfig, host: ChatHost) => Layer.effect(ChatStore, make(config, host))
}

/**
 * What a refused send keeps the question as, by ChatApi's status: 400, 401 (signed out) and 403 (not a Member) are
 * `refused`, 409 `conflict`, 413 `too_large`. Any other failure is sent again.
 */
const refusal = (status: number | undefined): UnsentReason | undefined =>
  status === 400 || status === 401 || status === 403
    ? "refused"
    : status === 409
      ? "conflict"
      : status === 413
        ? "too_large"
        : undefined

/**
 * Keeps a question on the device as unsent, once: a send replayed after a crash finds it there. The row shows at once;
 * the Effect it returns waits until the device has stored it.
 */
export const keepUnsent = (unsent: Collection.Collection<Unsent, string>, row: Asking, reason: UnsentReason) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* unsent.get(row.id))) return Effect.void
    const kept = yield* unsent.insert({
      id: row.id,
      answerId: row.answerId,
      text: row.text,
      queuedAt: row.queuedAt,
      reason,
      ...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
      ...(row.source === undefined ? {} : { source: row.source }),
      ...(row.data === undefined ? {} : { data: row.data }),
    })
    return Effect.orDie(kept.persisted)
  }).pipe(Effect.orDie)

/** What a parked question's row must still say for Retry to ask it again: its ids, its text and when it was asked. */
const ParkedQuestion = Schema.Struct({
  id: Schema.String,
  answerId: Schema.String,
  text: Schema.String,
  queuedAt: Schema.Number,
  conversationId: Schema.optional(Schema.String),
  source: Schema.optional(Source),
  data: Schema.optional(FormValues),
})

/**
 * Shows a question the outbox parked as Not sent, with Retry and Discard (`not_admitted`): true once it is kept, false
 * when its row doesn't say enough to ask it again, so it stays parked.
 */
export const keepParked = (unsent: Collection.Collection<Unsent, string>, write: Outbox.Parked) =>
  Effect.gen(function* () {
    const row = Schema.decodeUnknownOption(ParkedQuestion)(write.rows[0])
    if (Option.isNone(row)) return false
    yield* Effect.flatten(keepUnsent(unsent, { ...row.value, v: 2 }, "not_admitted"))
    yield* Effect.logWarning("question parked").pipe(Effect.annotateLogs({ reason: write.reason, questionId: row.value.id }))
    return true
  })

/**
 * What the connection pill follows, besides the questions queued: the browser's `offline` event, the last shape request
 * (`pending` until one is answered), why Electric stopped the shape, whether sends are failing, and whether failures
 * have lasted `unreachableAfter`.
 */
interface Signals {
  readonly offline: boolean
  readonly shape: "pending" | "ok" | "failing" | "stopped"
  readonly stopReason: "refused" | "invalid_response" | null
  readonly sending: boolean
  readonly overdue: boolean
  /** This tab's engine worker failed. */
  readonly engine: boolean
}

const make = Effect.fnUntraced(function* (config: ChatConfig, host: ChatHost) {
  const scope = yield* Effect.scope
  const flows = yield* FlowDispatch
  const confirmWithin = config.confirmWithin ?? Duration.seconds(15)
  const unreachableAfter = config.unreachableAfter ?? Duration.seconds(10)
  const pageSize = config.pageSize ?? PAGE_SIZE

  // One lane for the home and the branch conversation: their summaries take turns on the engine together.
  const summaryLane = yield* makeLane
  const composer = yield* Collection.local<Composer, string>({
    id: "chat-composer",
    schema: Composer,
    getKey: (row) => row.id,
    initialData: [{ id: COMPOSER, open: false, focusRequested: false, draft: "", saved: true }],
  })
  const connection = yield* Collection.local<Connection, string>({
    id: "chat-connection",
    schema: Connection,
    getKey: (row) => row.id,
    initialData: [{ id: CONNECTION, status: host.isOnline() ? "up" : "offline", retry: false }],
  })
  const history = yield* Collection.local<History, string>({
    id: "chat-history",
    schema: History,
    getKey: (row) => row.id,
    initialData: [{ id: HISTORY, opened: false, limit: pageSize, earlier: false }],
  })
  const asking = yield* Collection.local<Asking, string>({ id: "chat-asking", schema: Asking, getKey: (row) => row.id })
  const place = yield* Collection.local<Place, string>({
    id: "chat-place",
    schema: Place,
    getKey: (row) => row.id,
    initialData: [{ id: PLACE, conversationId: null, shared: false }],
  })
  const unsent = yield* Collection.persisted(ChatUnsentStore)
  const drafts = yield* Collection.persisted(ChatDraftsStore)
  const messages = yield* ElectricCollection.make<Message>({
    id: "chat-messages",
    schema: Message,
    getKey: (row) => row.id,
    syncMode: "eager",
    // 2: `attempts` is gone (server answering went with it) and an answer can fail `unfinished`. 5: an answer's summary.
    persist: { schemaVersion: 5 },
    shape: {
      url: config.shapeUrl,
      columnMapper: ElectricCollection.snakeCamelMapper(),
      parser: { int8: (value: string) => Number(value) },
    },
    ...(config.retry === undefined ? {} : { retry: config.retry }),
  })
  const pinState = yield* makePins(new URL(config.shapeUrl).origin, messages)

  // --- Sending: the outbox's `ask` mutation (docs/decisions/0002-local-first.md §3) ---

  // Waits until the question shows in the device's rows, of its own conversation (the home one, or the branch's it was
  // asked in): there already (a resend, 200), or once Electric delivers it. It arrives through this tab's shape when
  // this tab writes the device's rows, or from the tab that does (Collection.make's one writer), so the wait is on the
  // row, never on this tab's own stream. Rows arrive only once the device has restored the conversation, so the wait
  // counts from then, and the restore waits as long at most: a device store in memory restores from the network.
  yield* observeLoad(messages).pipe(Effect.forkIn(scope, { startImmediately: true }))

  const delivered = (row: Asking) =>
    Effect.gen(function* () {
      const synced = row.conversationId === undefined ? messages : (yield* open(row.conversationId)).messages
      yield* Effect.ignore(Effect.timeout(synced.restored, confirmWithin))
      yield* synced.awaitRow((message) => message.id === row.id, confirmWithin)
    })

  // This device's agent answers the question ChatApi took: `chat/Answer`, with the answer's id as its execution id. It
  // waits until the engine has recorded the run, so the outbox keeps the question until a run exists to answer it; the
  // run goes on in the background. The engine starts an execution once, so a resend that dispatches it again starts no
  // second run. A start that fails (no engine in this tab, refused, the tab closing) is sent again; the dispatch has
  // logged and counted it. A run refused because the app changed under it (parked under one build, resumed under the
  // next: `plan_changed`, or `payload_changed` when its recorded payload no longer decodes), or confirmed cancelled,
  // cannot finish, so
  // `chat/Close` settles its answer failed, under its own execution id; a resend finds a run refused before, so it
  // closes answers left streaming by an earlier build too.
  const answer = (row: Asking) =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void, DispatchFailed>()
      yield* flows.dispatch("chat/Answer", { answerId: row.answerId }, {
        door: "composer",
        executionId: row.answerId,
        admitted,
      }).pipe(
        // expected: an answer that cannot finish is closed instead
        Effect.catchIf(
          answerCannotFinish,
          () => flows.dispatch("chat/Close", { answerId: row.answerId }, {
            door: "composer", executionId: `${row.answerId}/close`,
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      )
      yield* Deferred.await(admitted).pipe(
        Effect.tapError(({ reason }) =>
          Effect.logWarning("answer not started").pipe(Effect.annotateLogs({ reason }))
        ),
        Effect.mapError(() => new Outbox.Retry({})),
      )
    })

  // Sends one queued question. A refusal (400, 401, 403, 409, 413) keeps it as unsent and stops; anything else is sent
  // again. It is done once ChatApi took it, this device's engine recorded the run that answers it, and Electric
  // delivered it.
  const send = ({ rows }: { readonly rows: ReadonlyArray<unknown> }) => {
    const row = rows[0] as Asking
    return Effect.gen(function* () {
      const client = yield* ChatClient
      const taken = yield* client.ask({
        id: row.id,
        answerId: row.answerId,
        text: row.text,
        ...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
        ...(row.source === undefined ? {} : { source: row.source }),
        ...(row.data === undefined ? {} : { data: row.data }),
      }).pipe(
        Effect.catchTag("QuestionNotTaken", (error): Effect.Effect<never, Outbox.Retry | Outbox.Refused> => {
          const reason = refusal(error.status)
          return reason === undefined
            ? Effect.fail(new Outbox.Retry(error.status === undefined ? {} : { status: error.status }))
            : keepUnsent(unsent, row, reason).pipe(
                Effect.flatten,
                Effect.andThen(Metric.update(Metric.withAttributes(askFailures, { reason }), 1)),
                Effect.andThen(
                  Effect.logWarning("question not sent").pipe(Effect.annotateLogs({ reason, status: error.status })),
                ),
                Effect.andThen(Effect.fail(new Outbox.Refused({ status: error.status! }))),
              )
        }),
      )
      yield* Effect.annotateCurrentSpan({ taken: taken._tag })
      yield* answer(row)
      yield* delivered(row).pipe(Effect.mapError(() => new Outbox.Retry({})))
      yield* Effect.logInfo("question stored").pipe(Effect.annotateLogs({ taken: taken._tag }))
    }).pipe(
      Effect.annotateLogs({ feature: "chat", questionId: row.id, answerId: row.answerId }),
      Effect.withSpan("chat.ask.send", { attributes: { questionId: row.id, answerId: row.answerId } }),
    )
  }

  const leader = yield* Outbox.lockLeader({ lock: host.lock, name: OUTBOX_LOCK })
  // The device's one outbox: chat's questions, and the writes other features hand over (src/outbox.ts).
  const others = yield* OutboxWrites
  const outbox = Context.get(
    yield* Layer.build(
      Outbox.layer({
        ...host.outbox,
        leader,
        collections: { ...others.collections, asking },
        mutations: { ...others.mutations, ask: send },
        // Writes an older build stored are upgraded before the outbox loads them, or parked (decision 0021 §4): a
        // parked question shows Not sent, with Retry and Discard.
        upgrade: outboxUpgrade,
        parked: { ...others.parked, ask: (write) => keepParked(unsent, write) },
      }),
    ),
    Outbox.Outbox,
  )

  // --- The conversation, as frontends read it ---

  // The conversation's views, synced beside its messages (src/features/views/store.ts).
  const viewsStore = yield* ViewsStore
  const { views } = viewsStore
  const conversation = yield* conversationQuery(messages, unsent, asking, views)
  const latest = yield* latestQuery(conversation, pageSize)
  const queued = yield* queuedQuery(conversation)

  // --- Branch conversations (decision 0013 §1): one shape and one collection each, opened when a page needs one ---

  const branches = new Map<string, ConversationState>()
  const builders: Array<(opened: ConversationState) => Effect.Effect<void>> = []
  const persistence = yield* Persistence.Persistence
  const openBranch = (conversationId: string) =>
    Effect.gen(function* () {
      const branchMessages = yield* ElectricCollection.make<Message>({
        id: `chat-messages:${conversationId}`,
        schema: Message,
        getKey: (row) => row.id,
        syncMode: "eager",
        persist: { schemaVersion: 5 },
        shape: {
          url: `${config.shapeUrl}?conversation=${encodeURIComponent(conversationId)}`,
          columnMapper: ElectricCollection.snakeCamelMapper(),
          parser: { int8: (value: string) => Number(value) },
        },
        ...(config.retry === undefined ? {} : { retry: config.retry }),
      })
      yield* observeLoad(branchMessages).pipe(Effect.forkIn(scope, { startImmediately: true }))
      const branchViews = yield* viewsStore.forConversation(conversationId)
      const branchHistory = yield* Collection.local<History, string>({
        id: `chat-history:${conversationId}`,
        schema: History,
        getKey: (row) => row.id,
        initialData: [{ id: HISTORY, opened: false, limit: pageSize, earlier: false }],
      })
      const branchConversation = yield* conversationQuery(branchMessages, unsent, asking, branchViews, conversationId)
      const branchLatest = yield* latestQuery(branchConversation, pageSize)
      // The rail summarizes what this conversation's window shows (src/features/timeline/store.ts).
      yield* followSummaries(branchLatest, branchMessages, flows, summaryLane).pipe(Effect.forkIn(scope))
      const opened: ConversationState = {
        pinned: yield* pinnedQuery(pinState.effective, branchMessages, pinState.pending, conversationId),
        conversationId,
        messages: branchMessages,
        conversation: branchConversation,
        latest: branchLatest,
        shown: yield* shownQuery(branchLatest),
        queued: yield* queuedQuery(branchConversation),
        history: branchHistory,
        historyState: yield* historyQuery(branchHistory),
      }
      yield* branchConversation.rows.pipe(
        Stream.runForEach((rows) => markEarlier(branchHistory, rows.length)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // Opened once the device's rows are restored, or, when it has none of this conversation yet (a branch this device
      // never showed), once the shape has synced: switching to a branch never shows the empty state for a frame before
      // the conversation it has arrives.
      yield* branchMessages.restored.pipe(
        Effect.andThen(branchMessages.toArray),
        Effect.flatMap((rows) => (rows.length > 0 ? Effect.void : branchMessages.preload)),
        // expected: restore failures are logged by Collection
        Effect.catch(() => branchMessages.preload),
        Effect.andThen(branchHistory.update(HISTORY, (row) => void (row.opened = true))),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* Effect.forEach(builders, (build) => build(opened), { discard: true })
      branches.set(conversationId, opened)
      yield* Effect.logInfo("chat conversation opened").pipe(Effect.annotateLogs({ conversationId }))
      return opened
    }).pipe(Scope.provide(scope), Effect.provideService(Persistence.Persistence, persistence), Effect.orDie)
  // One at a time, so two callers opening one conversation open it once.
  const opening = yield* Semaphore.make(1)
  const open = (conversationId: string): Effect.Effect<ConversationState> =>
    Effect.suspend(() => {
      const known = branches.get(conversationId)
      return known !== undefined
        ? Effect.succeed(known)
        : Semaphore.withPermits(opening, 1)(Effect.suspend(() => {
          const raced = branches.get(conversationId)
          return raced !== undefined ? Effect.succeed(raced) : openBranch(conversationId)
        }))
    })

  // --- The connection pill (schema.ts `Connection`), from the browser, the shape and the outbox ---

  const state = yield* Ref.make<Signals>({
    offline: !host.isOnline(),
    shape: "pending",
    stopReason: null,
    sending: false,
    overdue: false,
    engine: false,
  })
  const browserOnline = yield* SubscriptionRef.make(host.isOnline())
  const deadline = yield* FiberHandle.make<void, never>()
  // A request sent after failures, or after a restart, that hasn't failed within `reachedAfter` reached Electric: a live
  // request is held there until Postgres changes, so it may not answer for a long time.
  const reachedAfter = Duration.seconds(1)
  const reaching = yield* FiberHandle.make<void, never>()

  const connectionNow = Effect.map(connection.get(CONNECTION), Option.getOrThrow)
  // What the pill shows now. While it shows, reconnecting has no state of its own: it hides once the shape is up to
  // date, nothing is failing and every queued question reached Postgres.
  const settle = Effect.gen(function* () {
    const now = yield* Ref.get(state)
    const shown = yield* connectionNow
    // Read now, not from a stream that may not have caught up with an ask this tick.
    const waiting = (yield* queued.toArray).length
    const next: Omit<Connection, "id"> =
      now.engine
        ? { status: "stopped", retry: false }
        : now.shape === "stopped"
        ? { status: "failed", retry: true }
        : now.offline
          ? { status: "offline", retry: false }
          : now.overdue
            ? { status: "offline", retry: true }
            : shown.status !== "up" && !(now.shape === "ok" && !now.sending && waiting === 0)
              ? { status: shown.status, retry: shown.retry }
              : { status: "up", retry: false }
    if (next.status === shown.status && next.retry === shown.retry) return
    yield* connection
      .update(CONNECTION, (row) => {
        row.status = next.status
        row.retry = next.retry
      })
      .pipe(Effect.orDie)
    if (next.status !== "up") {
      const reason = next.status === "stopped"
        ? "engine"
        : next.status === "failed"
        ? now.stopReason!
        : now.offline
        ? "offline"
        : "unreachable"
      yield* Metric.update(Metric.withAttributes(connectionDrops, { reason }), 1)
    }
    yield* Effect.logInfo("chat connection changed").pipe(Effect.annotateLogs({ status: next.status }))
  })

  // Shape requests or sends failing, with the browser online, for `unreachableAfter` show as offline, with Retry.
  const watchFailures = Effect.gen(function* () {
    const now = yield* Ref.get(state)
    if (now.shape !== "failing" && !now.sending) {
      yield* FiberHandle.clear(deadline)
      return yield* Ref.update(state, (s) => ({ ...s, overdue: false }))
    }
    if (yield* FiberHandle.get(deadline).pipe(Effect.map(Option.isSome))) return
    yield* FiberHandle.run(
      deadline,
      Effect.sleep(unreachableAfter).pipe(
        Effect.andThen(Ref.update(state, (s) => ({ ...s, overdue: true }))),
        Effect.andThen(settle),
      ),
    )
  })

  const update = (change: (now: Signals) => Partial<Signals>) =>
    Ref.update(state, (now) => ({ ...now, ...change(now) })).pipe(
      Effect.andThen(watchFailures),
      Effect.andThen(settle),
      Effect.annotateLogs({ feature: "chat" }),
    )

  const onSync = (event: ElectricCollection.SyncEvent) => {
    switch (event._tag) {
      case "Sent":
        return Effect.gen(function* () {
          const shape = (yield* Ref.get(state)).shape
          if (shape !== "failing" && shape !== "pending") return
          yield* FiberHandle.run(
            reaching,
            Effect.sleep(reachedAfter).pipe(
              Effect.andThen(update((now) => (now.shape === "failing" || now.shape === "pending" ? { shape: "ok" } : {}))),
            ),
          )
        })
      case "Succeeded":
        return update(() => ({ shape: "ok", stopReason: null }))
      case "Failed":
        return FiberHandle.clear(reaching).pipe(Effect.andThen(update(() => ({ shape: "failing" }))))
      case "Stopped":
        return update(() => ({
          shape: "stopped",
          stopReason: event.error.status === undefined ? "invalid_response" : "refused",
        }))
    }
  }

  // The rail summarizes what the window shows, never every message the device holds (src/features/timeline/store.ts).
  yield* followSummaries(latest, messages, flows, summaryLane).pipe(Effect.forkIn(scope))
  const store = ChatStore.of({
    pinState,
    pinned: yield* pinnedQuery(pinState.effective, messages, pinState.pending),
    messages,
    asking,
    unsent,
    drafts,
    composer,
    connection,
    history,
    outbox,
    conversation,
    latest,
    shown: yield* shownQuery(latest),
    queued,
    composerState: yield* composerQuery(composer),
    connectionState: yield* connectionQuery(connection),
    historyState: yield* historyQuery(history),
    place,
    placeState: yield* placeQuery(place),
    open,
    opened: (conversationId) => branches.get(conversationId),
    forEachOpened: (build) =>
      Effect.suspend(() => {
        builders.push(build)
        return Effect.forEach([...branches.values()], build, { discard: true })
      }),
    scope,
    pageSize,
    lastQueuedAt: yield* Ref.make(0),
    draftRevision: yield* Ref.make(0),
    pendingAsks: yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<QuestionSubmitted>>>(new Map()),
    lead: leader.take,
    browserOffline: (offline) =>
      Effect.andThen(SubscriptionRef.set(browserOnline, !offline), update(() => ({ offline }))),
    browserOnline,
    // Suspended, so it reconnects the branch conversations open when Retry is pressed, not those open at boot (none).
    retryNow: Effect.suspend(() =>
      Effect.all(
        [
          messages.reconnect,
          views.reconnect,
          outbox.retryNow,
          ...[...branches.values()].map((branch) => branch.messages.reconnect),
        ],
        { discard: true },
      )
    ).pipe(
      Effect.andThen(FiberHandle.clear(deadline)),
      Effect.andThen(
        update((now) => ({ overdue: false, shape: now.shape === "stopped" ? "pending" : now.shape })),
      ),
    ),
  })

  const background = <E>(stream: Stream.Stream<E>, each: (event: E) => Effect.Effect<void>) =>
    stream.pipe(Stream.runForEach(each), Effect.forkIn(scope, { startImmediately: true }))
  yield* background(messages.sync, onSync)
  // This tab's engine failing is for good: the pill says so until the page reloads.
  yield* (yield* BrowserEngine.BrowserEngine).unavailable.pipe(
    Effect.andThen(update(() => ({ engine: true }))),
    Effect.forkIn(scope, { startImmediately: true }),
  )
  yield* background(outbox.status, ({ failing }) => update(() => ({ sending: failing !== null })))
  yield* background(queued.rows, () => update(() => ({})))
  // Whether the device has messages before the window.
  yield* background(conversation.rows, (rows) => markEarlier(history, rows.length))
  // The conversation has opened once the device's rows are restored, or, failing that, synced.
  yield* messages.restored.pipe(
    // expected: restore failures are logged by Collection
    Effect.catch(() => messages.preload),
    Effect.andThen(
      history.update(HISTORY, (row) => {
        row.opened = true
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope, { startImmediately: true }),
  )
  return store
})

/** Sets `history.earlier`: the device has more messages than the window shows. */
export const markEarlier = (history: Collection.Collection<History, string>, total: number) =>
  Effect.gen(function* () {
    const now = Option.getOrThrow(yield* history.get(HISTORY))
    const earlier = total > now.limit
    if (earlier === now.earlier) return
    yield* history.update(HISTORY, (row) => {
      row.earlier = earlier
    })
  }).pipe(Effect.orDie)

/**
 * Records how long the answer to a question this tab just asked took to show its first text, counted from asking, so a
 * question queued offline counts its time in the queue. Ends without a record when the answer settles with no text,
 * and with the store otherwise. Run it with `startImmediately`, so it follows changes before the ask returns.
 */
export const timeFirstText = Effect.fnUntraced(function* (answerId: string, askedAt: number) {
  const { messages } = yield* ChatStore
  const decided = yield* messages.changes({ initial: true }).pipe(
    Stream.flattenIterable,
    Stream.filter((change) => change.key === answerId),
    Stream.takeUntil((change) => change.value.text !== "" || change.value.status !== "streaming"),
    Stream.runLast,
  )
  if (Option.isSome(decided) && decided.value.value.text !== "") {
    yield* Metric.update(firstAnswerText, (yield* Clock.currentTimeMillis) - askedAt)
  }
})
