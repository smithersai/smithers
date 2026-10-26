import type { Outbox } from "@smthrs/effect-tanstack-db"
import { Clock, Effect, Metric, Option, Ref, type Types } from "effect"
import { Clipboard } from "../../clipboard"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import { MAX_QUESTION_LENGTH } from "./contract"
import { persistDraft } from "./draftWrite"
import { askFailures, composerOpens, historyLoads, questionsAsked, syncRetries, unsentActions } from "./metrics"
import {
  type Asking,
  COMPOSER,
  type Composer,
  CONNECTION,
  type CopyAnswer,
  type EditAnswer,
  HISTORY,
  HOME_DRAFT,
  PLACE,
  type Source,
} from "./schema"
import type { FormValues } from "../views/schema"
import { type DraftSelection, SharedPrompt } from "./sharedPrompt"
import { ChatStore, keepUnsent, timeFirstText } from "./store"

// What a person does, as Effects that finish synchronously. The chat layer (chat.ts) binds each to a plain function
// that frontends call, so an action's writes show before its event handler returns. Sending runs in the outbox, never
// in an action: an action only writes to this device.

/** How a person reached the composer. */
export type Via = "shortcut" | "button"

const composerNow = Effect.gen(function* () {
  const { composer } = yield* ChatStore
  return Option.getOrThrow(yield* composer.get(COMPOSER))
})

const changeComposer = (recipe: (composer: Types.Mutable<Composer>) => void) =>
  Effect.gen(function* () {
    const { composer } = yield* ChatStore
    yield* composer.update(COMPOSER, recipe)
  }).pipe(Effect.orDie)

/** Shows the composer. Counted only when it was hidden. */
export const openComposer = (via: Via) =>
  Effect.gen(function* () {
    if ((yield* composerNow).open) return
    yield* changeComposer((composer) => {
      composer.open = true
      composer.focusRequested = true
    })
    yield* Metric.update(Metric.withAttributes(composerOpens, { via }), 1)
  })

/** Hides the composer. The draft stays. */
export const closeComposer = changeComposer((composer) => {
  composer.open = false
  composer.focusRequested = false
})

/** Claims this opening's focus request once, when a frontend has an input to focus. */
export const takeComposerFocus = Effect.gen(function* () {
  if (!(yield* composerNow).focusRequested) return false
  yield* changeComposer((composer) => {
    composer.focusRequested = false
  })
  return true
})

export const toggleComposer = (via: Via) =>
  Effect.flatMap(composerNow, ({ open }) => (open ? closeComposer : openComposer(via)))

/** Which conversation this tab shows, and whether its prompt is shared. */
const placeRow = Effect.flatMap(ChatStore, ({ place }) => Effect.map(place.get(PLACE), Option.getOrThrow))

/**
 * The person made the composer's draft `draft`, with `selection` after. On a branch its owner shared, the draft is the
 * branch's prompt (`SharedPrompt`, docs/features/coedit.md#the-prompt): the change goes to everyone typing it, and the
 * prompt keeps it across reloads. Anywhere else the draft is this person's alone, and the device keeps it for the
 * conversation (`keepDraft`), as Slack, Linear and GitHub keep a draft per person.
 */
export const setDraft = (draft: string, selection?: DraftSelection) =>
  Effect.gen(function* () {
    const base = (yield* composerNow).draft
    yield* mirrorDraft(draft)
    const shared = yield* Effect.serviceOption(SharedPrompt)
    if (Option.isSome(shared) && (yield* placeRow).shared) return yield* shared.value.set(draft, { base, selection })
    yield* keepDraft(draft)
  })

/** The composer's draft becomes `draft`, as the shared prompt now reads with everyone's typing in it. */
export const mirrorDraft = (draft: string) =>
  changeComposer((composer) => {
    composer.draft = draft
  })

/**
 * Keeps `draft` on the device for the conversation this tab shows, or forgets it when it is empty. The composer is
 * `saved` once the device has stored it, unless the draft changed since.
 */
const keepDraft = (draft: string) =>
  Effect.gen(function* () {
    const { drafts, scope } = yield* ChatStore
    const key = (yield* placeNow) ?? HOME_DRAFT
    const kept = yield* drafts.get(key)
    const write = Option.isSome(kept)
      ? kept.value.text === draft
        ? undefined
        : yield* draft === "" ? drafts.delete(key) : drafts.update(key, (row) => void (row.text = draft))
      : draft === ""
      ? undefined
      : yield* drafts.insert({ id: key, text: draft })
    // Nothing to write leaves the composer as saved as it was.
    yield* write === undefined ? Effect.void : Effect.andThen(
      changeComposer((composer) => {
        composer.saved = false
      }),
      persistDraft(write, key).pipe(
        Effect.andThen(changeComposer((composer) => {
          if (composer.draft === draft) composer.saved = true
        })),
        Effect.ignore,
        Effect.forkIn(scope),
      ),
    )
  }).pipe(Effect.orDie)

/** The draft the device kept for the conversation this tab shows; empty when none. */
const keptDraft = Effect.gen(function* () {
  const { drafts } = yield* ChatStore
  const kept = yield* drafts.get((yield* placeNow) ?? HOME_DRAFT)
  return Option.match(kept, { onNone: () => "", onSome: ({ text }) => text })
})

/**
 * Puts the draft the device kept for the conversation this tab shows into the composer, unless the person has already
 * typed there: what a reload finds. A shared prompt takes it in as it opens (`followPrompt`).
 */
export const restoreDraft = Effect.gen(function* () {
  const draft = yield* keptDraft
  if (draft === "" || (yield* composerNow).draft !== "") return
  yield* mirrorDraft(draft)
  yield* Effect.logInfo("chat draft restored").pipe(Effect.annotateLogs({ "draft.length": draft.length }))
}).pipe(Effect.annotateLogs({ feature: "chat" }))

/**
 * Whether the prompt of the branch this tab shows is shared: its owner shared the branch (`true`), or took the last
 * share away (`false`). The composer keeps what it shows: shared, the device's draft goes into the prompt
 * (`followPrompt`, src/features/coedit/actions.ts); no longer shared, the device keeps the composer's draft as this
 * person's own.
 */
export const share = (shared: boolean) =>
  Effect.gen(function* () {
    const { place } = yield* ChatStore
    if ((yield* placeRow).shared === shared) return
    yield* place.update(PLACE, (row) => void (row.shared = shared)).pipe(Effect.orDie)
    if (!shared) yield* keepDraft((yield* composerNow).draft)
    yield* Effect.logInfo("chat prompt shared").pipe(Effect.annotateLogs({ shared }))
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

// A question the outbox couldn't take stays on the device as unsent, so it is never lost. Its storage failing is a
// failure, Warn by its code; a tab that doesn't lead the outbox is a state the tab leaves by taking the lead, Info.
const notAdmitted = (row: Asking, refused: Outbox.NotAdmitted) =>
  Effect.gen(function* () {
    const store = yield* ChatStore
    yield* keepUnsent(store.unsent, row, "not_admitted")
    yield* Metric.update(Metric.withAttributes(askFailures, { reason: "not_admitted" }), 1)
    yield* (refused.reason === "follower" ? Effect.logInfo : Effect.logWarning)("question not admitted").pipe(
      Effect.annotateLogs({
        questionId: row.id,
        reason: refused.reason,
        ...(refused.reason === "storage" ? { outcome: "failed", errorCode: codeOf(refused) } : {}),
      }),
    )
  })

/**
 * The person is using this tab (it got focus): it leads the outbox at once, so what they ask here is sent from here
 * (decision 0002 §1). It finishes before it returns; the lead is taken a moment later.
 */
export const lead = Effect.gen(function* () {
  const store = yield* ChatStore
  yield* Effect.forkIn(store.lead, store.scope)
})

/**
 * Puts a question into the outbox: its row shows at once, queued until Postgres has it. A question the outbox can't
 * take, now or when it stores it, stays unsent (`not_admitted`). Succeeds with whether the outbox took it now. Asked in
 * a tab that doesn't lead, the tab takes the lead, and sends the question once it leads (chat.ts).
 */
const admit = (row: Asking) =>
  Effect.gen(function* () {
    const store = yield* ChatStore
    const write = yield* store.outbox.transact("ask", { idempotencyKey: row.id }, Effect.asVoid(store.asking.insert(row)))
    yield* write.admitted.pipe(
      Effect.catch((refused) => notAdmitted(row, refused)),
      Effect.forkIn(store.scope),
    )
    return true
  }).pipe(
    // `transact` refuses at once only in a tab that doesn't lead (`follower`); a refusing storage fails `admitted`.
    Effect.catchTag("NotAdmitted", (refused) => Effect.as(Effect.andThen(notAdmitted(row, refused), lead), false)),
    Effect.orDie,
  )

/** The branch conversation this tab shows and asks in, or `undefined` for the home conversation. */
const placeNow = Effect.gen(function* () {
  const { place } = yield* ChatStore
  return Option.getOrThrow(yield* place.get(PLACE)).conversationId ?? undefined
})

/**
 * What this tab shows and asks in now: the home conversation's window, or the branch conversation's (decision 0013 §1).
 */
const windowNow = Effect.gen(function* () {
  const store = yield* ChatStore
  const conversationId = yield* placeNow
  const branch = conversationId === undefined ? undefined : yield* store.open(conversationId)
  return branch ?? store
})

/**
 * Shows a branch's conversation in this tab, and asks there from now on (decision 0013 §1); `null` shows the home
 * conversation. `shared` says its owner shared the branch, which makes its prompt one its people type together. It
 * opens the conversation first, so a frontend reading it finds it opened. Nothing already asked moves: a question keeps
 * the conversation it was asked in. The composer shows that conversation's draft.
 */
export const show = (conversationId: string | null, shared = false) =>
  Effect.gen(function* () {
    const store = yield* ChatStore
    if (conversationId !== null) yield* store.open(conversationId)
    // The home conversation's prompt is never shared.
    const place = { conversationId, shared: conversationId !== null && shared }
    if ((yield* placeRow).conversationId === conversationId) return yield* share(place.shared)
    yield* store.place.update(PLACE, (row) => void Object.assign(row, place)).pipe(Effect.orDie)
    // The composer shows the draft the device kept for the conversation shown; a shared prompt takes it in as it opens,
    // and brings its own text. The draft it had stays with its own conversation.
    yield* mirrorDraft(yield* keptDraft)
    yield* Effect.logInfo("chat conversation shown").pipe(
      Effect.annotateLogs({ conversation: conversationId === null ? "home" : "branch" }),
    )
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

export type AskResult =
  | { readonly asked: true; readonly questionId: string; readonly answerId: string }
  | { readonly asked: false; readonly reason: "empty" | "too_long" }

/** Where a question asked from a view came from, and the values sent with it (docs/features/views.md). */
export interface FromView {
  readonly source: Source
  readonly data?: FormValues
  /** The conversation the view is in: a branch's, or the home conversation's when absent. */
  readonly conversationId?: string
}

/**
 * Asks Smithers `text`, trimmed: the question shows at once at the end of the conversation and the draft clears,
 * online or not, while an answer streams or not. The outbox sends it (store.ts). A blank question or one over
 * `MAX_QUESTION_LENGTH` changes nothing, so the draft stays. Sent from a view (`from`), it names the view and carries
 * the values, goes to the view's own conversation, and leaves the draft as it is.
 */
export const ask = (text: string, from?: FromView): Effect.Effect<AskResult, never, ChatStore> =>
  Effect.gen(function* () {
    const question = text.trim()
    if (question === "") return { asked: false, reason: "empty" } as const
    if (question.length > MAX_QUESTION_LENGTH) return { asked: false, reason: "too_long" } as const
    const store = yield* ChatStore
    const questionId = crypto.randomUUID()
    const answerId = crypto.randomUUID()
    const askedAt = yield* Clock.currentTimeMillis
    const queuedAt = yield* Ref.updateAndGet(store.lastQueuedAt, (last) => Math.max(askedAt, last + 1))
    const queued = Option.getOrThrow(yield* store.connection.get(CONNECTION)).status !== "up"
    const conversationId = from === undefined ? yield* placeNow : from.conversationId
    yield* admit({
      id: questionId,
      answerId,
      text: question,
      queuedAt,
      v: 2,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(from === undefined ? {} : { source: from.source }),
      ...(from?.data === undefined ? {} : { data: from.data }),
    }).pipe(
      Effect.withSpan("chat.ask", { attributes: { questionId, answerId, "question.length": question.length } }),
    )
    if (from === undefined) yield* setDraft("")
    yield* Metric.update(Metric.withAttributes(questionsAsked, { queued: String(queued) }), 1)
    yield* Effect.forkIn(timeFirstText(answerId, askedAt), store.scope, { startImmediately: true })
    yield* Effect.logInfo("question asked").pipe(
      Effect.annotateLogs({ questionId, answerId, "question.length": question.length, queued }),
    )
    return { asked: true, questionId, answerId } as const
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

const unsentRow = (id: string) =>
  Effect.gen(function* () {
    const { unsent } = yield* ChatStore
    return yield* unsent.get(id)
  })

const dropUnsent = (id: string, action: "edit" | "discard" | "retry") =>
  Effect.gen(function* () {
    const { unsent } = yield* ChatStore
    yield* unsent.delete(id).pipe(Effect.orDie)
    yield* Metric.update(Metric.withAttributes(unsentActions, { action }), 1)
    yield* Effect.logInfo("unsent question handled").pipe(Effect.annotateLogs({ questionId: id, action }))
  })

/** Edit on an unsent question: its text goes to the composer, which opens, and the question goes. */
export const editUnsent = (id: string) =>
  Effect.gen(function* () {
    const row = yield* unsentRow(id)
    if (Option.isNone(row)) return
    yield* setDraft(row.value.text)
    yield* openComposer("button")
    yield* dropUnsent(id, "edit")
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

/** Discard on an unsent question: it goes. */
export const discardUnsent = (id: string) =>
  Effect.gen(function* () {
    if (Option.isNone(yield* unsentRow(id))) return
    yield* dropUnsent(id, "discard")
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

/** Retry on a question the outbox couldn't take: the outbox takes it again, under its own ids, where it was. */
export const resendUnsent = (id: string) =>
  Effect.gen(function* () {
    const row = yield* unsentRow(id)
    if (Option.isNone(row)) return
    const { answerId, text, queuedAt, conversationId, source, data } = row.value
    // The unsent row goes only once the outbox has the question again, so it never vanishes in between: until then
    // it hides the queued row. It is sent to the conversation it was asked in, from the view it was sent from.
    const again: Asking = {
      id,
      answerId,
      text,
      queuedAt,
      v: 2,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(source === undefined ? {} : { source }),
      ...(data === undefined ? {} : { data }),
    }
    if (yield* admit(again)) yield* dropUnsent(id, "retry")
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

/**
 * Sends every question the outbox couldn't take, in the order asked: what a tab does when it comes to lead the outbox,
 * so a question asked while another tab led is sent once this one leads.
 */
export const resendUnadmitted = Effect.gen(function* () {
  const { unsent } = yield* ChatStore
  const waiting = (yield* unsent.toArray).filter(({ reason }) => reason === "not_admitted")
  const ordered = [...waiting].sort((left, right) => left.queuedAt - right.queuedAt)
  yield* Effect.forEach(ordered, ({ id }) => resendUnsent(id), { discard: true })
})

/** Retry on an answer Smithers couldn't give: asks its question again, under new ids. */
export const retryAnswer = (answerId: string) =>
  Effect.gen(function* () {
    const { messages } = yield* windowNow
    const answer = yield* messages.get(answerId)
    if (Option.isNone(answer) || answer.value.questionId === null) return
    // Postgres inserts a question and its answer in one statement, and Electric delivers them together.
    const question = Option.getOrThrow(yield* messages.get(answer.value.questionId))
    yield* ask(question.text)
  })

/**
 * Shows the page of messages before the ones shown. The device has them all, so the window moves without the network;
 * TanStack DB applies it a moment later.
 */
export const loadEarlier = Effect.gen(function* () {
  const store = yield* ChatStore
  const shown = yield* windowNow
  const now = Option.getOrThrow(yield* shown.history.get(HISTORY))
  if (!now.earlier) return
  const limit = now.limit + store.pageSize
  yield* shown.latest.setWindow({ limit }).pipe(Effect.orDie, Effect.forkIn(store.scope, { startImmediately: true }))
  yield* shown.history.update(HISTORY, (history) => {
    history.limit = limit
    history.earlier = (shown.conversation.tanstack.size as number) > limit
  })
  yield* Metric.update(historyLoads, 1)
}).pipe(Effect.orDie)

/**
 * How a person asked to sync and send now: the Retry button, the browser coming back online, or the device adopted in
 * place by the person who signed in, whose requests now go as theirs (decision 0023, "Adopting a fresh device").
 */
export type RetryVia = "button" | "online" | "adopted"

/** Syncs and sends now: every shape request and write waiting out its backoff goes at once. */
export const retry = (via: RetryVia) =>
  Effect.gen(function* () {
    const store = yield* ChatStore
    if (via === "online") yield* store.browserOffline(false)
    yield* store.retryNow
    yield* Metric.update(Metric.withAttributes(syncRetries, { via }), 1)
    yield* Effect.logInfo("chat retried").pipe(Effect.annotateLogs({ via }))
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

/** The browser went offline: the pill says so at once. */
export const wentOffline = Effect.gen(function* () {
  const store = yield* ChatStore
  yield* store.browserOffline(true)
})

// --- Message controls (docs/features/chat.md#message-controls) ---

/** Every row of the conversation this tab shows, in order. */
const conversationNow = Effect.flatMap(windowNow, (shown) => shown.conversation.toArray)

/**
 * What Copy puts on the clipboard: the text of message `messageId` in the conversation this tab shows, or, without one,
 * of Smithers' latest finished answer there. None for a message it doesn't show, a view, or an answer that is still
 * streaming or failed.
 */
export const copyableText = (messageId?: string) =>
  Effect.map(conversationNow, (rows) => {
    const copyable = rows.filter(({ role, status }) => role !== "view" && status !== "streaming" && status !== "failed")
    const found = messageId === undefined
      ? copyable.filter(({ role }) => role === "assistant").at(-1)
      : copyable.find(({ id }) => id === messageId)
    return Option.fromNullishOr(found?.text)
  })

/**
 * The tab's side of `chat/copy` (src/features/chat/tab.ts): writes the message's text through the host's clipboard.
 * Answers `copied`, `failed` when the clipboard refused, or `not_found`.
 */
export const copyToClipboard = (messageId?: string): Effect.Effect<CopyAnswer["outcome"], never, ChatStore | Clipboard> =>
  Effect.gen(function* () {
    const text = yield* copyableText(messageId)
    if (Option.isNone(text)) return "not_found"
    return yield* (yield* Clipboard).write(text.value).pipe(
      Effect.as("copied" as const),
      Effect.orElseSucceed(() => "failed" as const),
    )
  })

/**
 * The question Edit takes back: `questionId`, or, without one, the latest of this device's questions in the
 * conversation this tab shows that Postgres doesn't have yet, queued in the outbox or unsent.
 */
const editable = (questionId?: string) =>
  Effect.map(conversationNow, (rows) => {
    const waiting = rows.filter(({ status }) => status === "queued" || status === "unsent")
    return Option.fromNullishOr(questionId === undefined ? waiting.at(-1) : waiting.find(({ id }) => id === questionId))
  })

/**
 * The tab's side of `chat/edit` (src/features/chat/tab.ts): takes a question that Smithers doesn't have yet back into
 * the composer, which opens with its text. An unsent question goes as its Edit does (`editUnsent`). A queued one leaves
 * the outbox first, under the outbox's own lock (`Outbox.withdraw`): it is taken back before it is sent, or sent and
 * not taken back, never both. A tab that doesn't lead the outbox takes the lead first. Answers `edited`, `not_found`,
 * `sent` when the outbox is sending it or has sent it, or `failed` when the outbox couldn't take it back.
 */
export const takeBack = (questionId?: string): Effect.Effect<EditAnswer["outcome"], never, ChatStore> =>
  Effect.gen(function* () {
    const store = yield* ChatStore
    const found = yield* editable(questionId)
    if (Option.isNone(found)) return "not_found"
    const question = found.value
    if (question.status === "unsent") {
      yield* editUnsent(question.id)
      return "edited"
    }
    const withdraw = store.outbox.withdraw(question.id)
    const outcome = yield* withdraw.pipe(
      // expected: a follower tab takes the lead and withdraws again
      Effect.catchIf((error) => error.reason === "follower", () => Effect.andThen(store.lead, withdraw)),
      Effect.as("edited" as const),
      // expected: the edit logs this outcome as its own line
      Effect.catchTag("NotWithdrawn", ({ reason }) =>
        Effect.succeed(reason === "gone" || reason === "sending" ? "sent" as const : "failed" as const)),
    )
    if (outcome === "edited") {
      yield* setDraft(question.text)
      yield* openComposer("button")
    }
    yield* Effect.logWithLevel(outcome === "failed" ? "Warn" : "Info")("queued question taken back").pipe(
      Effect.annotateLogs({ questionId: question.id, outcome }),
    )
    return outcome
  }).pipe(Effect.annotateLogs({ feature: "chat" }))

/**
 * Copy on a message: `chat/copy`, door `button`. Succeeds with whether the text is on the clipboard of this tab, which
 * the dispatch writes through the flow's step (`copyToClipboard`).
 */
export const copy = (messageId: string) =>
  Effect.gen(function* () {
    const dispatched = yield* Effect.result((yield* FlowDispatch).dispatch("chat/copy", { messageId }, { door: "button" }))
    return dispatched._tag === "Success" && dispatched.success._tag === "Done" && dispatched.success.value.copied
  })

/**
 * Edit on a queued question: `chat/edit`, door `button`, in the background. The question's text shows in the composer
 * once the outbox gave it back (`takeBack`); if it is already on its way, it stays where it is.
 */
export const edit = (questionId: string) =>
  Effect.gen(function* () {
    const store = yield* ChatStore
    const flows = yield* FlowDispatch
    yield* flows.dispatch("chat/edit", { questionId }, { door: "button" }).pipe(Effect.ignore, Effect.forkIn(store.scope))
  })
