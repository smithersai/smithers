import { makePins, pendingQuery, pinnedQuery } from "../pins/store.vibe"
import { observeLoad } from "./load"
import { makeLane, followPhases, followSummaries, type Lane } from "../timeline/store.vibe"
import { TimelineNotice } from "../timeline/notice.vibe"
import { Collection, LiveQuery, Outbox, Persistence } from "@smthrs/effect-tanstack-db"
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
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { HttpClient } from "effect/http"
import { FlowDispatch } from "../../flows/dispatch.vibe"
import type { ReadDenials } from "./messagesShardClient"
import * as MessagesShardRows from "./messagesShardRows"
import type { SyncedMessages, SyncEvent } from "./messagesShardRows"
import { ChatWrites } from "./writes"
import { ViewsStore } from "../views/store"
import { ConversationOwners, type Fence } from "../conversations/owners"
import type { Gated } from "../repo/gate"
import { PAGE_SIZE } from "./contract"
import { connectionDrops, firstAnswerText } from "./metrics"
import {
  composerQuery,
  connectionQuery,
  conversationQuery,
  historyQuery,
  latestQuery,
  placeQuery,
  queuedQuery,
  shownQuery,
  everythingQuery,
  timelineNoticeQuery,
} from "./queries"
import {
  Asking,
  type ChatDraft,
  COMPOSER,
  Composer,
  CONNECTION,
  Connection,
  HISTORY,
  History,
  Message,
  PLACE,
  Place,
  Unsent,
  type QuestionSubmitted,
} from "./schema"

/**
 * Where this tab reads from, its deadlines and how often it reads. It asks through `ChatClient` and reads each
 * conversation's messages from its messages shard over the page's `HttpClient`: the services the layer is given.
 */
export interface ChatConfig {
  /** ChatApi's origin, as the browser reaches it: where questions are asked and messages shards are read. */
  readonly origin: string
  /** How long the shard gets to deliver a question ChatApi took before the send counts as failed. Default 15 s. */
  readonly confirmWithin?: Duration.Input
  /**
   * How long reads or sends may keep failing, with the browser online, before the pill says the device is offline,
   * with Retry. Default 10 s.
   */
  readonly unreachableAfter?: Duration.Input
  /** How many of the most recent messages the conversation shows, and how many more "Load earlier" adds. */
  readonly pageSize?: number
  /**
   * How each conversation's messages are read from its messages shard on `origin` (decision 0170, slice 5b,
   * messagesShardRows.ts), the home conversation's and every branch's: the shard is asked at once and then every
   * `follow` (default 1 second), each request within `within` (default 10 seconds). No shape of any conversation's
   * messages is requested, and nothing of them is kept on the device.
   */
  readonly shard?: {
    readonly follow?: Duration.Input
    readonly within?: Duration.Input
    /** Entries per pulled page. Default the shard client's, 256. */
    readonly limit?: number
  }
  /**
   * The read `401`s the page sees arrive under its transport (messagesShardClient.ts `ReadDenials`, src/main.tsx): a
   * conversation is hidden as ChatApi's `401` to a read of its shard arrives, whatever the transport's session check
   * then does.
   */
  readonly readDenials?: ReadDenials
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

/** The home conversation's shape among the pill's shapes; a branch conversation's is its id, a UUID. */
const HOME_SHAPE = "home"

/** What a host chooses of `ChatConfig`: everything but where ChatApi is, which `chatConfig` fills in. */
export type ChatOptions = Omit<ChatConfig, "origin">

export const chatConfig = (origin: string, options: ChatOptions): ChatConfig => ({ origin, ...options })

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/**
 * One branch's conversation on this tab (decision 0013 §1): its messages, read from its messages shard, and its views,
 * synced by Electric and kept on the device, with the live queries a frontend reads and this tab's window of it. The
 * home conversation `/app` shows is the store's own `messages`, `conversation`, `latest`, `shown`, `queued` and
 * `history`.
 */
export interface ConversationState {
  readonly conversationId: string
  readonly pinned: Query<typeof pinnedQuery>
  /**
   * Its messages as they sync from the conversation's messages shard: the stores' own, never shown as they are. What
   * shows reads `shownMessages` and the queries below, through the data gate: only while the conversation's repository
   * may show (src/features/conversations/owners.ts).
   */
  readonly messages: SyncedMessages
  readonly shownMessages: Gated<Message>
  readonly conversation: Query<typeof conversationQuery>
  readonly latest: Query<typeof latestQuery>
  readonly shown: Query<typeof shownQuery>
  readonly everything: Query<typeof everythingQuery>
  readonly queued: Query<typeof queuedQuery>
  readonly history: Collection.Collection<History, string>
  readonly historyState: Query<typeof historyQuery>
}

/**
 * Chat's state for one tab:
 * - `messages`: the home conversation, read from its messages shard (`ChatConfig.shard`); read-only, and nothing of it
 *   kept on the device. A branch conversation's are read from its own shard (`open`).
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
    readonly pinState: Effect.Success<ReturnType<typeof makePins>> & { readonly pendingState: Effect.Success<ReturnType<typeof pendingQuery>> }
    readonly pinned: Query<typeof pinnedQuery>
    /** The summaries' turns, shared by every conversation on this tab, and why they stopped when they have. */
    readonly summaryLane: Lane
    readonly timelineNotices: Collection.Collection<TimelineNotice, string>
    readonly timelineNotice: Query<typeof timelineNoticeQuery>
    /**
     * The home conversation's messages as they sync from its shard, the one the session answer names home
     * (`ConversationOwners.homes`): the store's own. What shows reads `shownMessages`.
     */
    readonly messages: SyncedMessages
    readonly shownMessages: Gated<Message>
    readonly asking: Collection.Collection<Asking, string>
    readonly unsent: Collection.Collection<Unsent, string>
    /** Branch-local questions for display; raw asking and unsent rows remain delivery inputs. */
    readonly shownAsking: Gated<Asking>
    readonly shownUnsent: Gated<Unsent>
    readonly drafts: Collection.Collection<ChatDraft, string>
    readonly composer: Collection.Collection<Composer, string>
    readonly connection: Collection.Collection<Connection, string>
    readonly history: Collection.Collection<History, string>
    readonly outbox: Outbox.Service
    readonly conversation: Query<typeof conversationQuery>
    readonly latest: Query<typeof latestQuery>
    readonly shown: Query<typeof shownQuery>
    readonly everything: Query<typeof everythingQuery>
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
    /** Latest private draft storage transaction per conversation, including deletions. */
    readonly draftWrites: Map<string, { readonly generation: string | undefined; readonly text: string; readonly persisted: Effect.Effect<void, unknown> }>
    readonly draftRevision: Ref.Ref<number>
    readonly pendingAsks: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<QuestionSubmitted>>>
    /** The browser went offline (`true`) or online (`false`). */
    readonly browserOffline: (offline: boolean) => Effect.Effect<void>
    /** Whether the browser says it is online: `isOnline` at boot, then its `online` and `offline` events. */
    readonly browserOnline: SubscriptionRef.SubscriptionRef<boolean>
    /** Retry: syncs and sends now, and gives failing requests `unreachableAfter` again. Then runs each `onRetry`. */
    readonly retryNow: Effect.Effect<void>
    /**
     * Has `then` run after each Retry from now on: what a feature above chat asks again then, as the branch's page
     * asks ChatApi of a branch whose conversation is refused (src/features/branch/branch.ts).
     */
    readonly onRetry: (then: Effect.Effect<void>) => Effect.Effect<void>
    /**
     * Makes this tab lead the outbox at once, as the tab a person is using does (decision 0002 §1), and completes once
     * it leads. The tab that led sends nothing more until it leads again.
     */
    readonly lead: Effect.Effect<void>
  }
>()("@smthrs/mvp/chat/ChatStore") {
  /**
   * The conversation read side, over ChatWrites' already initialized drafts and outbox. Its shard reads and page queries
   * close with the scope; only sent-question confirmation needs these reads.
   */
  static readonly layer = (config: ChatConfig, host: ChatHost) => Layer.effect(ChatStore, make(config, host))
}

export { keepUnsent, keepParked, OUTBOX_LOCK } from "./writes"

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
  /** Writes the outbox holds for their person's sign-in (src/outbox.ts `held`); their sends fail, but nothing is down. */
  readonly held: boolean
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
  const timelineNotices = yield* Collection.local<TimelineNotice, string>({ id: "timeline-notice", schema: TimelineNotice, getKey: (row) => row.id })
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
    initialData: [{ id: CONNECTION, status: host.isOnline() ? "up" : "offline", retry: false, signIn: false }],
  })
  const history = yield* Collection.local<History, string>({
    id: "chat-history",
    schema: History,
    getKey: (row) => row.id,
    initialData: [{ id: HISTORY, opened: false, limit: pageSize, earlier: false }],
  })
  const writes = yield* ChatWrites
  const { asking, unsent, drafts, outbox, leader } = writes
  const place = yield* Collection.local<Place, string>({
    id: "chat-place",
    schema: Place,
    getKey: (row) => row.id,
    initialData: [{ id: PLACE, conversationId: null, shared: false }],
  })
  const owners = yield* ConversationOwners
  // Every conversation's messages are read from its shard over the page's own signed-in requests.
  const http = yield* HttpClient.HttpClient
  const shardRead = {
    origin: config.origin,
    follow: config.shard?.follow ?? Duration.seconds(1),
    within: config.shard?.within ?? Duration.seconds(10),
    ...(config.shard?.limit === undefined ? {} : { limit: config.shard.limit }),
    ...(config.readDenials === undefined ? {} : { denials: config.readDenials }),
  }
  // The home conversation's messages, from the shard of the conversation the session answer names home, as it names
  // one (`owners.homes`). Each home is read with its own refusals, bound to it: a read ChatApi refuses (`401`, `403`,
  // `404`, a `401` told as it arrives included) hides it in that turn, and the rows of a read answered whole return it
  // only past the refusals that read began after (its `fence`, taken before the read was sent), and only while the
  // session answer still names it home. Offline, or before any read is answered, nothing of it shows.
  const messages = yield* MessagesShardRows.following<Fence>({
    ...shardRead,
    conversations: owners.homes,
    refusalsOf: (homeId) => ({
      fence: owners.fence,
      refuse: () => owners.refuse(homeId),
      clear: (fence) => (homeId === owners.home() ? owners.clear(homeId, fence) : Effect.void),
    }),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http))
  const rawPins = yield* makePins(config.origin, messages)

  yield* observeLoad(messages).pipe(Effect.forkIn(scope, { startImmediately: true }))

  // --- The conversation, as frontends read it ---

  // The conversation's views, synced beside its messages (src/features/views/store.ts).
  const viewsStore = yield* ViewsStore
  const shownPendingPins = yield* owners.ofShown(rawPins.pending, "conversationId")
  const pinState = { ...rawPins, pendingState: yield* pendingQuery(rawPins.pending, shownPendingPins) }
  const { views } = viewsStore
  // What shows of the home conversation goes through the data gate (decision 0110; the coordinator's ruling 3): the
  // conversation the session answer names home is the person's own (ConversationOwners). Its rows name it.
  const shownMessages = (yield* owners.ofShown(messages, "conversationId")) as unknown as Gated<Message>
  const conversation = yield* conversationQuery(shownMessages, unsent, asking, viewsStore.shownHome, undefined, { messages, unsent })
  const latest = yield* latestQuery(conversation, pageSize)
  const queued = yield* queuedQuery(conversation)
  // Branch-local writes remain available for delivery, but their display requires known conversation access too.
  const shownUnsent = yield* owners.ofShown(unsent, "conversationId")
  const shownAsking = yield* owners.ofShown(asking, "conversationId")

  // --- Branch conversations (decision 0013 §1): one shard read and one collection each, opened when a page needs one ---

  const branches = new Map<string, ConversationState>()
  const builders: Array<(opened: ConversationState) => Effect.Effect<void>> = []
  const retries: Array<Effect.Effect<void>> = []
  const persistence = yield* Persistence.Persistence
  const openBranch = (conversationId: string) =>
    Effect.gen(function* () {
      // From the conversation's messages shard: nothing of its messages is kept on the device.
      const branchMessages = yield* MessagesShardRows.open({
        ...shardRead,
        conversationId,
        // A read ChatApi refuses hides the whole conversation, in the turn it is refused and before its rows go:
        // its views and the questions this device queued in it show through the same gate as its messages
        // (src/features/conversations/owners.ts `refuse`), and return once the rows ChatApi served again are held,
        // unless a refusal was recorded after that read began (`clear`).
        refusals: {
          fence: owners.fence,
          refuse: () => owners.refuse(conversationId),
          clear: (fence) => owners.clear(conversationId, fence),
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, http))
      yield* observeLoad(branchMessages).pipe(Effect.forkIn(scope, { startImmediately: true }))
      // Its shard's requests count toward the pill as the home conversation's do.
      yield* reportShape(conversationId, { shape: "pending", stopReason: null })
      yield* branchMessages.sync.pipe(
        Stream.runForEach(onSync(conversationId)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // What shows of it goes through the data gate: its messages and views, only while its repository may show.
      // Each row names the conversation its shard is of.
      const ofBranch = yield* LiveQuery.make(
        (q) => q.from({ message: branchMessages.tanstack }).select(({ message }) => ({ ...message, conversationId })),
        { getKey: (row) => row.id },
      )
      const shownMessages = (yield* owners.ofShown(ofBranch, "conversationId")) as unknown as Gated<Message>
      // Opened through the views store's own seam, then read through the gate.
      yield* viewsStore.forConversation(conversationId)
      const branchViews = yield* viewsStore.shownViewsIn(conversationId)
      const branchHistory = yield* Collection.local<History, string>({
        id: `chat-history:${conversationId}`,
        schema: History,
        getKey: (row) => row.id,
        initialData: [{ id: HISTORY, opened: false, limit: pageSize, earlier: false }],
      })
      const branchConversation = yield* conversationQuery(shownMessages, shownUnsent, shownAsking, branchViews, conversationId,
        { messages: branchMessages, unsent })
      const branchLatest = yield* latestQuery(branchConversation, pageSize)
      // The rail spans the whole conversation, and summarizes what it spans (src/features/timeline/store.ts).
      const branchEverything = yield* everythingQuery(branchConversation)
      yield* followSummaries(branchEverything, branchMessages, flows, summaryLane).pipe(Effect.forkIn(scope))
      yield* followPhases(branchEverything, flows, summaryLane).pipe(Effect.forkIn(scope))
      const opened: ConversationState = {
        pinned: yield* pinnedQuery(pinState.effective, shownMessages, shownPendingPins, conversationId),
        conversationId,
        messages: branchMessages,
        shownMessages,
        conversation: branchConversation,
        latest: branchLatest,
        shown: yield* shownQuery(branchLatest),
        everything: branchEverything,
        queued: yield* queuedQuery(branchConversation),
        history: branchHistory,
        historyState: yield* historyQuery(branchHistory),
      }
      yield* branchConversation.rows.pipe(
        Stream.runForEach((rows) => markEarlier(branchHistory, rows.length)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // Opened once its rows are whole (`whole`): the first sync is committed. The first rows to arrive may be one page
      // of several, so having some is never a reason to open, and switching to a branch never shows the empty state for
      // a frame before the conversation it has arrives.
      yield* branchMessages.whole.pipe(
        Effect.andThen(branchHistory.update(HISTORY, (row) => void (row.opened = true))),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* Effect.forEach(builders, (build) => build(opened), { discard: true })
      branches.set(conversationId, opened)
      yield* Effect.logInfo("chat conversation opened").pipe(Effect.annotateLogs({ conversationId }))
      return opened
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(Persistence.Persistence, persistence),
      Effect.orDie,
    )
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

  // --- The connection pill (schema.ts `Connection`), from the browser, the shard reads and the outbox ---

  const state = yield* Ref.make<Signals>({
    offline: !host.isOnline(),
    shape: "pending",
    stopReason: null,
    sending: false,
    held: false,
    overdue: false,
    engine: false,
  })
  const browserOnline = yield* SubscriptionRef.make(host.isOnline())
  const deadline = yield* FiberHandle.make<void, never>()

  const connectionNow = Effect.map(connection.get(CONNECTION), Option.getOrThrow)
  // What the pill shows now. While it shows, reconnecting has no state of its own: it hides once the shape is up to
  // date, nothing is failing and every queued question reached Postgres.
  const settle = Effect.gen(function* () {
    const now = yield* Ref.get(state)
    const shown = yield* connectionNow
    // Read now, not from a stream that may not have caught up with an ask this tick.
    const waiting = (yield* queued.toArray).length
    // The outbox separates held writes from failures of other writes that still need the network.
    const sending = now.sending
    const next: Omit<Connection, "id" | "signIn"> =
      now.engine
        ? { status: "stopped", retry: false }
        : now.shape === "stopped"
        ? { status: "failed", retry: true }
        : now.offline
          ? { status: "offline", retry: false }
          : now.overdue
            ? { status: "offline", retry: true }
            : shown.status !== "up" && !(now.shape === "ok" && !sending && waiting === 0)
              ? { status: shown.status, retry: shown.retry }
              : { status: "up", retry: false }
    if (now.held !== shown.signIn) {
      yield* connection.update(CONNECTION, (row) => void (row.signIn = now.held)).pipe(Effect.orDie)
    }
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

  // Every open conversation's shape: the pill shows the worst of them, so a home shape that syncs never hides a branch's
  // that stopped, or the reverse. Keyed by conversation id, the home conversation's by `HOME_SHAPE`.
  type ShapeSignal = Pick<Signals, "shape" | "stopReason">
  const shapes = new Map<string, ShapeSignal>([[HOME_SHAPE, { shape: "pending", stopReason: null }]])
  const worstShape = (): ShapeSignal => {
    const all = [...shapes.values()]
    return all.find(({ shape }) => shape === "stopped")
      ?? all.find(({ shape }) => shape === "failing")
      ?? all.find(({ shape }) => shape === "pending")
      ?? { shape: "ok", stopReason: null }
  }
  const reportShape = (source: string, signal: ShapeSignal) =>
    Effect.suspend(() => {
      shapes.set(source, signal)
      const worst = worstShape()
      return update(() => worst)
    })

  // Each read of a conversation's shard is answered whole, fails in a way a retry can fix, or is decided against.
  const onSync = (source: string) => (event: SyncEvent) => {
    switch (event._tag) {
      case "Succeeded":
        return reportShape(source, { shape: "ok", stopReason: null })
      case "Failed":
        return reportShape(source, { shape: "failing", stopReason: null })
      case "Stopped":
        return reportShape(source, {
          shape: "stopped",
          stopReason: event.error.status === undefined ? "invalid_response" : "refused",
        })
    }
  }

  // The rail spans the whole conversation, and summarizes what it spans (src/features/timeline/store.ts).
  const everything = yield* everythingQuery(conversation)
  yield* followSummaries(everything, messages, flows, summaryLane).pipe(Effect.forkIn(scope))
  yield* followPhases(everything, flows, summaryLane).pipe(Effect.forkIn(scope))
  const store = ChatStore.of({
    summaryLane,
    timelineNotices,
    timelineNotice: yield* timelineNoticeQuery(timelineNotices),
    pinState,
    pinned: yield* pinnedQuery(pinState.effective, shownMessages, pinState.pending),
    messages,
    shownMessages,
    shownAsking,
    shownUnsent,
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
    everything,
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
    draftWrites: new Map(),
    draftRevision: yield* Ref.make(0),
    pendingAsks: yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<QuestionSubmitted>>>(new Map()),
    lead: leader.take,
    browserOffline: (offline) =>
      Effect.andThen(SubscriptionRef.set(browserOnline, !offline), update(() => ({ offline }))),
    browserOnline,
    onRetry: (then) => Effect.sync(() => void retries.push(then)),
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
      // Every stopped shape was just sent again.
      Effect.andThen(Effect.suspend(() => {
        for (const [source, signal] of shapes) {
          if (signal.shape === "stopped") shapes.set(source, { shape: "pending", stopReason: null })
        }
        const worst = worstShape()
        return update(() => ({ overdue: false, ...worst }))
      })),
      Effect.andThen(Effect.suspend(() => Effect.forEach(retries, (then) => then, { discard: true }))),
    ),
  })

  const background = <E>(stream: Stream.Stream<E>, each: (event: E) => Effect.Effect<void>) =>
    stream.pipe(Stream.runForEach(each), Effect.forkIn(scope, { startImmediately: true }))
  yield* background(messages.sync, onSync(HOME_SHAPE))
  // This tab's engine failing is for good: the pill says so until the page reloads.
  yield* (yield* BrowserEngine.BrowserEngine).unavailable.pipe(
    Effect.andThen(update(() => ({ engine: true }))),
    Effect.forkIn(scope, { startImmediately: true }),
  )
  yield* background(outbox.status, ({ failing, held }) => update(() => ({ sending: failing !== null, held })))
  yield* background(queued.rows, () => update(() => ({})))
  // Whether the device has messages before the window.
  yield* background(conversation.rows, (rows) => markEarlier(history, rows.length))
  // The conversation has opened once its rows are whole: the first read of the home, or none to read.
  yield* messages.whole.pipe(
    Effect.andThen(
      history.update(HISTORY, (row) => {
        row.opened = true
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope, { startImmediately: true }),
  )
  yield* writes.confirmWith((row) => confirmDelivery(row, store, confirmWithin).pipe(Effect.mapError(() => new Outbox.Retry({}))))
  return store
})

/**
 * Waits until question `row` shows in the device's rows of its own conversation (`delivered` in `make`). A branch
 * conversation the device can't open now (its collections failed to open, a defect) fails `Outbox.Retry`, so the outbox
 * keeps the question and sends it again, as after a failed confirmation; the outbox never retries a defect.
 * Interruption stays cancellation.
 */
export const confirmDelivery = (
  row: Asking,
  store: Pick<ChatStore["Service"], "messages" | "open">,
  within: Duration.Input,
) =>
  Effect.gen(function* () {
    const synced = row.conversationId === undefined
      ? store.messages
      : (yield* store.open(row.conversationId).pipe(
        Effect.catchDefect(() =>
          Effect.logWarning("chat branch delivery waiting").pipe(
            Effect.annotateLogs({ feature: "chat", reason: "branch_open" }),
            Effect.andThen(Effect.fail(new Outbox.Retry({}))),
          )
        ),
      )).messages
    yield* synced.awaitRow((message) => message.id === row.id, within)
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
export const timeFirstText = Effect.fnUntraced(function* (answerId: string, askedAt: number, conversationId?: string) {
  const store = yield* ChatStore
  // The answer's own conversation: the home one, or the branch's it was asked in.
  const { messages } = conversationId === undefined ? store : yield* store.open(conversationId)
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
