import { postgresTime } from "./view"
import { Clock, Option } from "effect"
import { Context, Data, Effect, Layer, Stream } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { Page, reload } from "../../page"
import {
  type AskResult,
  ask,
  type FromView,
  closeComposer,
  copy,
  discardUnsent,
  edit,
  editUnsent,
  loadEarlier,
  openComposer,
  resendUnadmitted,
  resendUnsent,
  restoreDraft,
  retry,
  retryAnswer,
  setDraft,
  show,
  takeComposerFocus,
  type Via,
} from "./actions"
import { ChatStore } from "./store"

// Chat as a frontend sees it: live queries to read and plain functions to act, with no Effect in sight. React renders
// the queries with `useLiveQuery` and calls the actions from event handlers; it holds no state and runs no Effect.

type Store = ChatStore["Service"]

/** What a frontend reads: the TanStack DB collection of each live query, for its binding. */
export interface ChatQueries {
  /** The person's pinned copy, independent of the conversation's window. */
  readonly pinned: Store["pinned"]["tanstack"]
  readonly pinPending: Store["pinState"]["pendingState"]["tanstack"]
  readonly pinCollapsed: Store["pinState"]["collapseState"]["tanstack"]
  /** The window of the conversation, oldest first. */
  readonly conversation: Store["shown"]["tanstack"]
  /** Questions queued on this device that Postgres doesn't have yet. */
  readonly queued: Store["queued"]["tanstack"]
  readonly composer: Store["composerState"]["tanstack"]
  readonly connection: Store["connectionState"]["tanstack"]
  readonly history: Store["historyState"]["tanstack"]
  /** Which conversation this tab shows and asks in: a branch's `conversationId`, or `null` for the home one. */
  readonly place: Store["placeState"]["tanstack"]
  /**
   * A branch conversation's window and history, by its id, once it is shown; the home conversation's for `null` or one
   * not opened yet.
   */
  readonly of: (conversationId: string | null | undefined) => {
    readonly pinned: Store["pinned"]["tanstack"]
    readonly conversation: Store["shown"]["tanstack"]
    readonly history: Store["historyState"]["tanstack"]
    readonly queued: Store["queued"]["tanstack"]
  }
}

/** Copy didn't put the message on the clipboard: the clipboard refused, or the message is gone. */
export class NotCopied extends Data.TaggedError("NotCopied") {}

/** What a person does, as plain functions. Each finishes before it returns, but Copy, which resolves once it copied. */
export interface ChatActions {
  readonly retryPin: (conversationId: string) => void
  readonly pin: (messageId: string, local?: boolean) => void
  readonly unpin: () => void
  readonly collapsePin: (messageId: string, collapsed: boolean) => void
  readonly ask: (text: string) => AskResult
  /** Asks from a form or a view: its submit label or event label, with the view and the values (docs/features/views.md). */
  readonly askFromView: (text: string, from: FromView) => AskResult
  readonly openComposer: (via: Via) => void
  readonly closeComposer: () => void
  /** Consume an opening's focus request when the frontend input mounts. */
  readonly takeComposerFocus: () => boolean
  readonly setDraft: (text: string) => void
  readonly loadEarlier: () => void
  /** Retry on the connection pill: sync and send now. */
  readonly retry: () => void
  /** Retry on an answer Smithers couldn't give. */
  readonly retryAnswer: (answerId: string) => void
  readonly editUnsent: (questionId: string) => void
  readonly discardUnsent: (questionId: string) => void
  /** Retry on a question the outbox couldn't take. */
  readonly resendUnsent: (questionId: string) => void
  /** Copy on a message, through `chat/copy`: resolves once its text is on the clipboard, rejects `NotCopied` otherwise. */
  readonly copy: (messageId: string) => Promise<void>
  /** Edit on a queued question, through `chat/edit`: its text goes to the composer once the outbox gives it back. */
  readonly edit: (questionId: string) => void
  readonly reload: () => void
  /** Shows a branch's conversation, and asks there; `null` the home conversation. Resolves once it is open. */
  readonly show: (conversationId: string | null) => Promise<void>
}

export class Chat extends Context.Service<Chat, { readonly queries: ChatQueries; readonly actions: ChatActions }>()(
  "@smthrs/mvp/chat/Chat",
) {
  /**
   * Binds the store's queries and actions for frontends. Each action runs its Effect with the services this layer
   * was built with (`Effect.runSyncWith`), so it shares the app's store, logger, tracer and metrics. Whenever this tab
   * comes to lead the outbox, it sends the questions it couldn't before.
   */
  static readonly layer = Layer.effect(
    Chat,
    Effect.gen(function* () {
      const store = yield* ChatStore
      const context = yield* Effect.context<ChatStore | Page | FlowDispatch>()
      const run = Effect.runSyncWith(context)
      const runAsync = Effect.runPromiseWith(context)
      // The draft this device kept goes back into the composer once the device store has restored it.
      yield* store.drafts.restored.pipe(
        Effect.ignore,
        Effect.andThen(restoreDraft),
        Effect.forkIn(store.scope, { startImmediately: true }),
      )
      // A tab that comes to lead the outbox sends the questions asked while another tab led.
      yield* store.outbox.status.pipe(
        Stream.map(({ leader }) => leader),
        Stream.changes,
        Stream.filter((leader) => leader),
        Stream.runForEach(() => resendUnadmitted),
        Effect.forkIn(store.scope, { startImmediately: true }),
      )
      const sendPin = (held: import("../pins/schema").Pending) => Effect.gen(function* () {
        const fail = Effect.gen(function* () {
          const current = yield* store.pinState.pending.get(held.conversationId)
          if (Option.isSome(current) && current.value.at === held.at) yield* store.pinState.pending.update(held.conversationId, row => { row.failed = true })
          yield* Effect.logWarning("chat.pin").pipe(Effect.annotateLogs({ outcome: "failed", feature: "pins" }))
        }).pipe(Effect.orDie)
        yield* (yield* FlowDispatch).dispatch(held.messageId === null ? "chat/unpin" : "chat/pin",
          { ...(held.home ? {} : { conversationId: held.conversationId }), ...(held.messageId === null ? {} : { messageId: held.messageId }), at: held.at, awaitAdmission: held.awaitAdmission,
            ...(held.questionAnswerId === undefined ? {} : { questionAnswerId: held.questionAnswerId }) },
          { door: "button", executionId: `pin:${held.conversationId}:${held.at}` }).pipe(
            Effect.flatMap(done => done._tag === "Done" ? Effect.gen(function* () {
              const current = yield* store.pinState.pending.get(held.conversationId)
              if (Option.isSome(current) && current.value.at === held.at) {
                yield* store.pinState.pending.update(held.conversationId, row => { row.serverConversationId = done.value.conversationId })
              }
            }).pipe(Effect.orDie) : fail),
            Effect.catch(() => fail), Effect.forkIn(store.scope))
      })
      yield* store.pinState.pending.restored.pipe(Effect.ignore, Effect.andThen(Effect.gen(function* () {
        for (const held of yield* store.pinState.pending.toArray) if (!held.failed) yield* sendPin(held)
      })), Effect.forkIn(store.scope))
      const pin = (messageId?: string, local?: boolean) => Effect.gen(function* () {
        const place = (yield* store.place.toArray)[0]?.conversationId
        const messages = place == null ? store.messages : store.opened(place)!.messages
        const conversation = place == null ? store.conversation : store.opened(place)!.conversation
        const rows = yield* conversation.toArray
        const conversationId = place ?? "home"
        const target = rows.find(row => row.id === messageId && (local === undefined || row.local === Number(local)))
        const pending = store.pinState.pending
        const held = yield* pending.get(conversationId)
        if (place == null && (yield* messages.toArray).length === 0 && rows.length === 0 && Option.isNone(held)) return
        const retained = Option.isSome(held) && held.value.messageId === messageId && held.value.awaitAdmission && local !== false ? held.value : undefined
        const unsent = messageId === undefined ? Option.none() : yield* store.unsent.get(messageId)
        const asking = messageId === undefined ? Option.none() : yield* store.asking.get(messageId)
        const question = Option.getOrUndefined(Option.orElse(unsent, () => asking))
        const awaitAdmission = local === true || target?.local === 1 || (target === undefined && retained !== undefined)
        if (awaitAdmission && question === undefined && retained === undefined) return
        const questionAnswerId = awaitAdmission ? question?.answerId ?? retained?.questionAnswerId : undefined
        const text = awaitAdmission ? question?.text ?? retained?.text : undefined
        if (Option.isSome(held) && !held.value.failed && held.value.messageId === (messageId ?? null) && held.value.awaitAdmission === awaitAdmission && held.value.questionAnswerId === questionAnswerId) return
        const serverConversationId = place ?? (yield* messages.toArray)[0]?.conversationId ?? (Option.isSome(held) ? held.value.serverConversationId : undefined)
        const synced = serverConversationId === undefined ? Option.none() : yield* store.pinState.pins.get(serverConversationId)
        const at = Math.max(yield* Clock.currentTimeMillis,
          Option.isSome(held) ? held.value.at + 1 : 0,
          Option.isSome(synced) ? (postgresTime(synced.value.changedAt) ?? 0) + 1 : 0)
        const next = { home: place == null, failed: false, conversationId, personId: "", messageId: messageId ?? null, at, changedAt: new Date(at).toISOString(), awaitAdmission,
          ...(text === undefined ? {} : { text }), ...(questionAnswerId === undefined ? {} : { questionAnswerId }), ...(serverConversationId === undefined ? {} : { serverConversationId }) }
        const kept = Option.isSome(held) ? yield* pending.update(conversationId, row => { delete row.text; delete row.questionAnswerId; Object.assign(row, next) }) : yield* pending.insert(next)
        yield* kept.persisted.pipe(Effect.andThen(sendPin(next)), Effect.forkIn(store.scope))
      }).pipe(Effect.orDie)
      return Chat.of({
        queries: {
          pinned: store.pinned.tanstack,
          pinPending: store.pinState.pendingState.tanstack,
          pinCollapsed: store.pinState.collapseState.tanstack,
          conversation: store.shown.tanstack,
          queued: store.queued.tanstack,
          composer: store.composerState.tanstack,
          connection: store.connectionState.tanstack,
          history: store.historyState.tanstack,
          place: store.placeState.tanstack,
          of: (conversationId) => {
            const branch = conversationId === null || conversationId === undefined
              ? undefined
              : store.opened(conversationId)
            return branch === undefined
              ? { pinned: store.pinned.tanstack, conversation: store.shown.tanstack, history: store.historyState.tanstack, queued: store.queued.tanstack }
              : { pinned: branch.pinned.tanstack, conversation: branch.shown.tanstack, history: branch.historyState.tanstack, queued: branch.queued.tanstack }
          },
        },
        actions: {
          retryPin: (conversationId) => run(Effect.gen(function* () {
            const held = yield* store.pinState.pending.get(conversationId)
            if (Option.isSome(held)) yield* pin(held.value.messageId ?? undefined, held.value.awaitAdmission ? true : undefined)
          })),
          pin: (id, local) => run(pin(id, local)),
          unpin: () => run(pin()),
          collapsePin: (id, collapsed) => run(Effect.gen(function* () {
            const rows = store.pinState.collapsed
            if (Option.isSome(yield* rows.get(id))) yield* rows.update(id, r => { r.collapsed = collapsed })
            else yield* rows.insert({ id, collapsed })
          }).pipe(Effect.orDie)),
          ask: (text) => run(ask(text)),
          askFromView: (text, from) => run(ask(text, from)),
          openComposer: (via) => run(openComposer(via)),
          closeComposer: () => run(closeComposer),
          takeComposerFocus: () => run(takeComposerFocus),
          setDraft: (text) => run(setDraft(text)),
          loadEarlier: () => run(loadEarlier),
          retry: () => run(retry("button")),
          retryAnswer: (answerId) => run(retryAnswer(answerId)),
          editUnsent: (id) => run(editUnsent(id)),
          discardUnsent: (id) => run(discardUnsent(id)),
          resendUnsent: (id) => run(resendUnsent(id)),
          copy: (messageId) =>
            runAsync(Effect.flatMap(copy(messageId), (copied) => (copied ? Effect.void : Effect.fail(new NotCopied())))),
          edit: (questionId) => run(edit(questionId)),
          reload: () => run(reload),
          show: (conversationId) => runAsync(show(conversationId)),
        },
      })
    }),
  )
}

/** The chat layer's value: what frontends get. */
export type ChatView = Chat["Service"]
