import { clearComposerSource } from "./admissionSource"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Clock, Effect, Exit, Fiber, Option, type Scope } from "effect"
import type { DispatchFailed } from "./flows/dispatch"
import { repoOf } from "./features/attention/progress"
import { admissionNamespace, admitCommand, hasEngineAdmission, hasOutboxAdmission, startOperation } from "./features/commands/admission"
import type { FlowName } from "./flows/registry"
import { IssuesStore } from "./features/issues/store"
import { TodosStore } from "./features/todos/store"
import { admissionReceipt, beginAttempt, executionOf, finishAdmission, identifyAdmission, recordAdmission, settledEngineInputs, WriteIntents, type WriteIntent } from "./writeAdmission"

/**
 * Admits one staged input again under its original identity, in the background: its outbox write, or its engine run,
 * which the engine joins when it holds it already. `stage` names why in its records: `restore` on opening the page,
 * `retry` for a person's Try again on this tab's refusal (decision 0124). The SDK outbox and the engine own every
 * later retry and recovery.
 */
export const admitIntent = (intent: WriteIntent, stage: "restore" | "retry") => Effect.gen(function* () {
  const receipts = yield* WriteIntents
  const issues = yield* IssuesStore
  const todos = yield* TodosStore
  const scope = issues.scope
  const started = yield* Clock.currentTimeMillis
  const flow = intent.flow as FlowName
  const engine = hasEngineAdmission(flow)
  if (!engine && !hasOutboxAdmission(flow)) {
    yield* recordAdmission(intent.commandId, "unknown", stage, "invalid", started)
    return
  }
  const executionId = yield* executionOf(intent)
  const id = engine ? undefined : yield* Uuid.v5(admissionNamespace(flow), executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
  yield* identifyAdmission(intent, executionId, id)
  beginAttempt(receipts, intent.commandId, intent.commandId)
  if (stage === "restore" && intent.flow === "issue/create" && intent.draftId !== undefined) receipts.resumed.set(intent.payload.repo as string, id!)
  yield* recordAdmission(intent.commandId, intent.flow, stage, "recovered", started)
  yield* Effect.gen(function* () {
    if (engine) {
      // Its line, if it has one, stays until its run finished (`settleFromRuns`).
      const { started: outcome, run } = yield* startOperation(flow, intent.payload, { executionId, door: intent.door ?? "button", scope })
      yield* finishAdmission(intent, outcome === "admitted", intent.composer === undefined, outcome === "unconfirmed")
      if (outcome === "admitted") yield* followRun({ ...intent, executionId }, run, scope)
      return
    }
    const result = yield* admitCommand(flow, intent.payload, executionId)
    const admitted = Option.isSome(result) && result.value !== "not_admitted"
    let cleaned = true
    if (admitted) {
      const source = yield* admissionReceipt(clearMatchingDraft(intent, issues, todos).pipe(
        Effect.flatMap(kept => kept ? Effect.void : Effect.fail("unconfirmed")),
      ), intent.commandId, intent.flow, "source").pipe(Effect.result)
      cleaned = source._tag === "Success"
    }
    yield* finishAdmission(intent, admitted, cleaned)
  }).pipe(Effect.forkIn(scope, { startImmediately: true }))
})

/**
 * A settled run admits its staged input, whatever became of its Start reply (decision 0124): a finished run's line
 * leaves the composer and the input retires; a failed one's line stays the person's, and the input retires too. A
 * cleanup that can't confirm keeps the input, admitted, for the next page open.
 */
export const completeFromRun = (intent: WriteIntent, state: "done" | "failed") => Effect.gen(function* () {
  const receipts = yield* Effect.serviceOption(WriteIntents)
  const cleaned = state === "failed" || intent.composer === undefined ? true : yield* clearComposerSource(intent.composer)
  yield* Effect.forEach(Option.toArray(receipts), (store) => Effect.sync(() => {
    store.update(intent.commandId, { admitted: true, cleaned })
    if (cleaned) store.forget(intent.commandId)
  }))
  yield* recordAdmission(intent.commandId, intent.flow, "run", cleaned ? state : "unclean", yield* Clock.currentTimeMillis)
})

/**
 * The engine's own answer to `run`, the dispatch of `intent`'s admitted execution, retires that input once the run
 * settled: done, its declared failure, or the run dying (`defect`, its interpreter's refusal included). It answers at once
 * for a run that settled long ago, whatever the feed's reads cover. A read of the result that failed (`refused`,
 * `unavailable`, `invalid`) or an interrupted wait proves nothing about the run and does nothing: the engine's records
 * decide.
 */
/**
 * How an admitted dispatch's run ended, from its own answer: done, failed (its declared failure, or the run dying), or
 * nothing proven (a read of the result that failed, or an interrupted wait).
 */
export const runEnded = (ended: Exit.Exit<{ readonly _tag: "Done" | "Failed" }, DispatchFailed>): "done" | "failed" | undefined =>
  Exit.isSuccess(ended)
    ? ended.value._tag === "Done" ? "done" : "failed"
    : Option.exists(Exit.findErrorOption(ended), (failure) => failure.reason === "defect") ? "failed" : undefined

export const followRun = <A extends { readonly _tag: "Done" | "Failed" }>(intent: WriteIntent, run: Fiber.Fiber<A, DispatchFailed>, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const state = runEnded(yield* Effect.exit(Fiber.join(run)))
    if (state === undefined) return
    // The answer is a receipt of its own, the feed's until its reads show the run.
    const at = yield* Clock.currentTimeMillis
    const receipts = yield* Effect.serviceOption(WriteIntents)
    for (const store of Option.toArray(receipts)) store.answered.set(intent.executionId!, { flow: intent.flow, repo: repoOf(intent.payload), state, at })
    yield* completeFromRun(intent, state)
  }).pipe(Effect.forkIn(scope))

/**
 * What the feed does, once per input per tab (`attempted`), for the engine operations whose run settled (`results`,
 * decision 0124): an input already admitted and cleaned retires; any other is admitted at once by its run's result,
 * whatever became of its Start reply, and its line's cleanup runs in the background (`completeFromRun`). What storage
 * refuses, or a cleanup that can't confirm, waits for the next page open: nothing here tries again.
 */
export const settleFromRuns = (results: ReadonlyMap<string, "done" | "failed">, attempted: Set<string>) => Effect.gen(function* () {
  const receipts = yield* WriteIntents
  const issues = yield* IssuesStore
  for (const { intent, state } of settledEngineInputs(receipts, results)) {
    if (attempted.has(intent.commandId)) continue
    attempted.add(intent.commandId)
    if (intent.admitted === true && intent.cleaned === true) {
      receipts.forget(intent.commandId)
      continue
    }
    receipts.update(intent.commandId, { admitted: true, cleaned: false })
    yield* completeFromRun(intent, state).pipe(Effect.forkIn(issues.scope, { startImmediately: true }))
  }
})

/** Replay input receipts once on opening the page; the SDK outbox and the engine own all subsequent retry and recovery. */
export const resumeAdmissions = Effect.gen(function* () {
  const receipts = yield* WriteIntents
  for (const intent of receipts.pending()) yield* admitIntent(intent, "restore")
})

/**
 * Try again on a toast for this tab's refused admission of `subject` (`write:<write id>` or `run:<execution id>`): its
 * staged input again, with the same identity. Nothing while one of its admissions is still running, or once its input
 * is gone.
 */
export const retryInput = (subject: string) => Effect.gen(function* () {
  const receipts = yield* WriteIntents
  const [kind, id] = [subject.slice(0, subject.indexOf(":")), subject.slice(subject.indexOf(":") + 1)]
  const intent = receipts.pending().find(row => kind === "run" ? row.executionId === id : row.writeId === id)
  if (intent === undefined || receipts.admitting.has(intent.commandId) || (intent.writeId !== undefined && receipts.admitting.has(intent.writeId))) return false
  yield* admitIntent(intent, "retry")
  return true
})

/** A recovered press clears only its exact original snapshot; later typing remains the person's. */
const clearMatchingDraft = (intent: WriteIntent, issues: IssuesStore["Service"], todos: TodosStore["Service"]) => Effect.gen(function* () {
  if ((intent.flow === "issue/create" || intent.flow === "issue/comment") && intent.draftId !== undefined) {
    yield* issues.drafts.restored
    const key = intent.draftId
    const draft = yield* issues.drafts.get(key)
    if (Option.isSome(draft) && draft.value.body === (intent.payload.body ?? "") &&
      (intent.flow !== "issue/create" || draft.value.title.trim() === intent.payload.title)) {
      yield* issues.drafts.delete(key).pipe(Effect.flatMap(write => write.persisted))
    }
  }
  if (intent.flow === "todo/commit" && intent.draftId !== undefined) {
    yield* todos.drafts.restored
    const draft = yield* todos.drafts.get(intent.draftId)
    if (Option.isSome(draft) && draft.value.title.trim() === intent.payload.title && draft.value.prompt === intent.payload.prompt &&
      JSON.stringify(draft.value.acceptance) === JSON.stringify(intent.payload.acceptance ?? []) && draft.value.issue === intent.payload.issue) {
      yield* todos.drafts.delete(intent.draftId).pipe(Effect.flatMap(write => write.persisted))
    }
  }
  return intent.composer === undefined ? true : yield* clearComposerSource(intent.composer)
}).pipe(Effect.orElseSucceed(() => false))
