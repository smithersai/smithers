import type { Outbox } from "@smthrs/effect-tanstack-db"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { SharedText } from "@smthrs/sync"
import { Clock, Effect, Metric, Option, Ref, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import { mirrorDraft } from "../chat/actions"
import { PLACE } from "../chat/schema"
import { ChatStore } from "../chat/store"
import { StatusStore } from "../status/store"
import { CONVERSATION_NAMESPACE } from "../branch/contract"
import type { TextOf } from "./contract"
import { saves } from "./metrics"
import type { Selection, Sending, Shared } from "./schema"
import { CoeditStore, encodeCursor, type Live, SAVED_MARK, savedMarkOf } from "./store"
import { TEXT_UPDATE, TextWrites } from "./writes"

// What a person does with a text they edit together with others (decision 0013 §4, docs/features/coedit.md): type in
// it, move their caret, open a file of a branch's working copy and save it. Each edit changes this tab's replica at
// once and puts its update in the device's outbox, which sends it; the text's shape brings everyone else's.

/** What sending an update needs: the store, chat's outbox and the outbox's text writes. */
type Needs = CoeditStore | ChatStore | TextWrites

/** How an input changed its text: where its caret is now, and the text it showed when the person typed. */
export interface Edit {
  readonly selection?: Selection | undefined
  readonly base?: string | undefined
}

/** An open text's row: the store keeps one for every text it opened. */
const rowOf = (live: Live) => Effect.flatMap(CoeditStore, ({ texts }) => Effect.map(texts.get(live.id), Option.getOrThrow))

const setRow = (live: Live, change: Partial<Omit<Shared, "id">>) =>
  Effect.flatMap(CoeditStore, ({ texts }) => Effect.orDie(texts.update(live.id, (draft) => void Object.assign(draft, change))))

/**
 * Puts `update` in the outbox, with any this tab couldn't put there before. In a tab that doesn't lead the outbox, the
 * update waits in `unsent` while the tab takes the lead, and goes with the next one.
 */
const send = (live: Live, update: Uint8Array | undefined): Effect.Effect<void, never, Needs> =>
  Effect.gen(function* () {
    const chat = yield* ChatStore
    const { scope } = yield* CoeditStore
    const pending = [...(yield* Ref.getAndSet(live.unsent, [])), ...(update === undefined ? [] : [update])]
    if (pending.length === 0) return
    const merged = pending.length === 1 ? pending[0]! : SharedText.merge(pending)
    const row = { id: crypto.randomUUID(), textId: live.id, scope: live.scope, data: Base64.encode(merged), seed: false }
    const keep = Ref.update(live.unsent, (rest) => [merged, ...rest])
    yield* setRow(live, { stored: false })
    const write = yield* admit(row)
    if (Option.isNone(write)) {
      // Only a tab that doesn't lead is refused at once: it takes the lead, then sends what waits.
      yield* keep
      yield* chat.lead.pipe(Effect.andThen(send(live, undefined)), Effect.forkIn(scope))
      return
    }
    yield* Ref.update(live.admitting, (count) => count + 1)
    // Stored once every update this tab made is in the outbox's storage, so a reload finds it.
    const settled = Effect.gen(function* () {
      const left = yield* Ref.updateAndGet(live.admitting, (count) => count - 1)
      if (left === 0) yield* setRow(live, { stored: (yield* Ref.get(live.unsent)).length === 0 })
    })
    // The outbox's storage refused the update: kept in this tab to go with the next, and logged by its code.
    const refused = (failure: Outbox.NotAdmitted) =>
      Effect.logWarning("coedit.admit").pipe(
        Effect.annotateLogs({ feature: "coedit", outcome: "failed", reason: failure.reason, errorCode: codeOf(failure) }),
        Effect.andThen(keep),
      )
    yield* write.value.admitted.pipe(Effect.catch(refused), Effect.ensuring(settled), Effect.forkIn(scope))
  }).pipe(Effect.orDie)

/** Puts `row` in the outbox: its write, or nothing in a tab that doesn't lead the outbox. */
const admit = (row: Sending) =>
  Effect.gen(function* () {
    const chat = yield* ChatStore
    const { sending } = yield* TextWrites
    return yield* chat.outbox.transact(TEXT_UPDATE, { idempotencyKey: row.id }, Effect.asVoid(sending.insert(row))).pipe(
      Effect.map(Option.some),
      // expected: a follower tab takes the lead and sends later
      Effect.catchTag("NotAdmitted", () => Effect.succeedNone),
    )
  })

/** Remembers where this person's caret is in `live`, and tells its room. */
const place = (live: Live, selection: Selection) =>
  Effect.gen(function* () {
    const mine = { anchor: yield* live.replica.anchor(selection.anchor), head: yield* live.replica.anchor(selection.head) }
    yield* Ref.set(live.mine, mine)
    const room = yield* Ref.get(live.room)
    if (room !== undefined) yield* room.connection.set(encodeCursor(mine))
  })

/**
 * The person typed: text `textId` becomes `value` in this tab at once, merged with what everyone else typed, and the
 * change goes to them. A text this tab hasn't opened changes nothing.
 */
export const type = (textId: string, value: string, edit: Edit = {}) =>
  Effect.gen(function* () {
    const store = yield* CoeditStore
    const live = store.live(textId)
    if (live === undefined) return
    const update = yield* live.replica.replace(value, { caret: edit.selection?.head, base: edit.base })
    if (update !== undefined) yield* send(live, update)
    if (edit.selection !== undefined) yield* place(live, edit.selection)
    yield* store.refresh(live)
  })

/** The person moved their caret or selection in text `textId`: everyone in it sees where. */
export const select = (textId: string, selection: Selection) =>
  Effect.gen(function* () {
    const store = yield* CoeditStore
    const live = store.live(textId)
    if (live === undefined) return
    yield* place(live, selection)
    yield* store.refresh(live)
  })

/** Opens `of` and joins its room, leaving the rooms of the other texts of its kind `others` names. */
const showOnly = (of: TextOf, others: (row: Shared) => boolean) =>
  Effect.gen(function* () {
    const store = yield* CoeditStore
    const live = yield* store.open(of)
    for (const row of yield* store.texts.toArray) {
      const other = store.live(row.id)
      if (other !== undefined && other.id !== live.id && others(row)) yield* store.hide(other)
    }
    yield* store.show(live)
    return live
  })

/** Leaves the room of the file shown, as when the live editor goes. Its text is kept. */
export const hideFiles = Effect.gen(function* () {
  const store = yield* CoeditStore
  for (const row of yield* store.texts.toArray) {
    const live = row.kind === "file" && row.shown ? store.live(row.id) : undefined
    if (live !== undefined) yield* store.hide(live)
  }
})

/** The shown prompt: the conversation it is of and its text's id. */
export interface ShownPrompt {
  readonly conversation: string
  readonly textId: string
}

/** The conversation chat shows now: a branch's, or `null` for the home conversation. */
export const shownConversation = Effect.gen(function* () {
  const { place } = yield* ChatStore
  return Option.getOrThrow(yield* place.get(PLACE)).conversationId
})

/**
 * Moves into `conversation`'s prompt what the person typed in it before it opened: `typed`, the whole draft the
 * composer showed, else the draft the device kept for it while it wasn't shared (chat's `chat-drafts`), which the device
 * then forgets. It is typed from an empty base, so it merges with whatever the prompt holds, stored or arriving: neither
 * the draft nor anyone's text is lost.
 */
const adoptDraft = (conversation: string, live: Live, typed: string) =>
  Effect.gen(function* () {
    const { drafts } = yield* ChatStore
    // A tab that opens on a shared branch reads the kept draft once the device store has it.
    yield* Effect.ignore(drafts.restored)
    const kept = Option.getOrUndefined(yield* drafts.get(conversation))
    // The composer showed the kept draft, so what was typed holds it already.
    const draft = typed !== "" ? typed : kept?.text
    if (kept !== undefined) yield* Effect.orDie(drafts.delete(conversation))
    if (draft === undefined) return
    yield* type(live.id, draft, { base: "" })
    yield* Effect.logInfo("coedit.draft adopted").pipe(Effect.annotateLogs({ textId: live.id, chars: draft.length }))
  })

/** Leaves the room of the prompt shown: the composer's draft is the person's own again. */
const hidePrompts = Effect.gen(function* () {
  const store = yield* CoeditStore
  const prompts = (yield* store.texts.toArray).filter((row) => row.kind === "prompt")
  // The store opened every text it has a row of; hiding one that isn't shown changes nothing.
  for (const row of prompts) yield* store.hide(store.live(row.id)!)
})

/**
 * Follows the conversation chat shows. On a branch its owner shared, its prompt is shown, the composer's draft becomes
 * its text, and stays its text as everyone types (`mirrorDraft`); what the person typed before it opened (`pending`),
 * or the draft the device kept for it, goes into it. Anywhere else no prompt is shown, and the composer's draft is the
 * person's own, which chat keeps on the device. Runs for as long as the store does; `current` is the shown prompt, for
 * the composer's edits.
 */
export const followPrompt = (current: Ref.Ref<ShownPrompt | undefined>, pending: Ref.Ref<string>) =>
  Effect.gen(function* () {
    const chat = yield* ChatStore
    const store = yield* CoeditStore
    yield* chat.place.changes({ initial: true }).pipe(
      Stream.flatMap((changes) => Stream.fromIterable(changes)),
      Stream.map((change) => (change.value.shared ? change.value.conversationId : null)),
      Stream.changes,
      Stream.runForEach((conversation) =>
        Effect.gen(function* () {
          if (conversation === null) {
            yield* Ref.set(current, undefined)
            yield* Ref.set(pending, "")
            return yield* hidePrompts
          }
          const live = yield* showOnly({ kind: "prompt", conversation }, (row) => row.kind === "prompt")
          yield* Ref.set(current, { conversation, textId: live.id })
          yield* adoptDraft(conversation, live, yield* Ref.getAndSet(pending, ""))
          yield* mirrorDraft((yield* rowOf(live)).text)
        })
      ),
      Effect.forkIn(store.scope),
    )
    // It mirrors the text as it is when the change is heard, never the change's own: the person may have typed since.
    yield* store.texts.changes().pipe(
      Stream.runForEach((changes) =>
        Effect.gen(function* () {
          const shown = (yield* Ref.get(current))?.textId
          if (shown === undefined || !changes.some((change) => change.key === shown)) return
          yield* mirrorDraft(Option.getOrThrow(yield* store.texts.get(shown)).text)
        })
      ),
      Effect.forkIn(store.scope),
    )
  })

/**
 * Shows file `path` of branch `branchId`'s working copy to edit together, and joins its room; `undefined` leaves the
 * room of the file shown. A file nobody has opened yet starts from what the working copy holds: this tab reads it
 * (`sandbox/read`) and sends it as the text's one seed; whoever's seed ChatApi took first, every device starts from
 * it. A path with nothing at it opens empty, a new file its first Save makes. A file over the sandbox's limit, or one this
 * person may not read, fails. Resolves with the file's text id.
 */
export const showFile = (branchId: string, path: string | undefined) =>
  Effect.gen(function* () {
    const store = yield* CoeditStore
    if (path === undefined) return yield* Effect.as(hideFiles, undefined)
    const conversation = yield* Uuid.v5(CONVERSATION_NAMESPACE, branchId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    const live = yield* showOnly({ kind: "file", conversation, path }, (row) => row.kind === "file")
    if ((yield* rowOf(live)).status === "loading") yield* Effect.forkIn(seed(live, conversation, path), store.scope)
    return live.id
  })

/** Gives a file nobody has opened its first content: the working copy's text, as the one seed every device starts from. */
const seed = (live: Live, conversation: string, path: string) =>
  Effect.gen(function* () {
    // What ChatApi has, if it can say. A seed sent for a file that has one already is dropped: every device starts it
    // from the seed ChatApi kept, so a second one is only a wasted read.
    yield* Effect.ignore(live.updates.preload)
    if ((yield* live.updates.toArray).length > 0) return
    const flows = yield* FlowDispatch
    const read = yield* Effect.result(
      flows.dispatch("sandbox/read", { path, conversationId: conversation }, { door: "button" }),
    )
    // The sandbox refuses a read to anyone who may not edit the branch: they see a file only once someone who may has
    // opened it.
    if (read._tag === "Failure") return yield* setRow(live, { status: "failed", failure: "unavailable" })
    // Nothing at the path yet: a new file, which starts empty and is made by its first Save.
    const missing = read.success._tag === "Failed" &&
      read.success.error._tag === "@smthrs/mvp/sandbox/SandboxCallFailed" && read.success.error.failure === "not_found"
    if (read.success._tag === "Failed" && !missing) {
      const refused = read.success.error._tag === "@smthrs/mvp/sandbox/SandboxCallRefused"
      return yield* setRow(live, { status: "failed", failure: refused ? "forbidden" : "unavailable" })
    }
    const content = read.success._tag === "Done" ? read.success.value : { content: "", truncated: false }
    if (content.truncated) return yield* setRow(live, { status: "failed", failure: "too_large" })
    const chat = yield* ChatStore
    const row: Sending = {
      id: crypto.randomUUID(),
      textId: live.id,
      scope: live.scope,
      data: Base64.encode(SharedText.seed(content.content)),
      seed: true,
    }
    // Only a tab that doesn't lead is refused at once: it takes the lead first. A tab that leads is never refused.
    if (Option.isNone(yield* admit(row))) yield* Effect.andThen(chat.lead, Effect.flatMap(admit(row), Effect.fromOption))
    yield* Effect.logInfo("coedit.seed").pipe(Effect.annotateLogs({ textId: live.id, bytes: row.data.length }))
  }).pipe(Effect.orDie, Effect.annotateLogs({ feature: "coedit" }))

/**
 * Save on an open file: what everyone typed is written to the branch's working copy through `sandbox/write`, the
 * sandbox tools' one write path. This tab's row says it is saving until the write settles, and that it failed if it
 * did. A written text gets the text's `saved` mark, which reaches everyone with it: every tab whose text is still what
 * was written says Saved, and an edit anyone makes after says Save again.
 */
export const save = (textId: string) =>
  Effect.gen(function* () {
    const store = yield* CoeditStore
    const live = store.live(textId)
    if (live === undefined || live.of.kind !== "file") return
    const { conversation, path } = live.of
    const startedAt = yield* Clock.currentTimeMillis
    const content = yield* live.replica.text
    // The run's id names its sandbox call too (src/features/sandbox/steps.ts), so the log line finds the machine's.
    const executionId = crypto.randomUUID()
    yield* setRow(live, { saving: true, saveFailed: false })
    const flows = yield* FlowDispatch
    const written = yield* Effect.result(
      flows.dispatch("sandbox/write", { path, content, conversationId: conversation }, { door: "button", executionId }),
    )
    const outcome = written._tag === "Success" && written.success._tag === "Done" ? "saved" : "failed"
    if (outcome === "saved") yield* send(live, yield* live.replica.mark(SAVED_MARK, savedMarkOf(content)))
    yield* setRow(live, { saving: false, saveFailed: outcome === "failed" })
    yield* store.refresh(live)
    yield* Metric.update(Metric.withAttributes(saves, { outcome }), 1)
    yield* Effect.logWithLevel(outcome === "saved" ? "Info" : "Warn")("coedit.save").pipe(
      Effect.annotateLogs({
        outcome,
        textId,
        executionId,
        bytes: content.length,
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      }),
    )
  }).pipe(Effect.annotateLogs({ feature: "coedit" }), Effect.withSpan("coedit.save"))

/**
 * Follows the runs that need this person: the answer box of each open question is a text their devices type together,
 * open and shown while the question is; a question answered, closed or replaced leaves its room. Runs for as long as
 * the store does.
 */
export const followAnswers = Effect.gen(function* () {
  const status = yield* StatusStore
  const store = yield* CoeditStore
  yield* status.runs.changes({ initial: true }).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const open = (yield* status.runs.toArray).filter((run) =>
          run.status === "needs_you" && run.answeredAt === null && run.wait?.kind === "question"
        )
        const shown = new Set<string>()
        for (const run of open) {
          const live = yield* store.open({ kind: "answer", run: run.id, version: run.version })
          shown.add(live.id)
          yield* store.show(live)
        }
        for (const row of yield* store.texts.toArray) {
          const live = row.kind === "answer" && !shown.has(row.id) ? store.live(row.id) : undefined
          if (live !== undefined) yield* store.hide(live)
        }
      })
    ),
    Effect.forkIn(store.scope),
  )
})
