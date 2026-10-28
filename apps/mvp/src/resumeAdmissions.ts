import { clearComposerSource } from "./admissionSource"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Clock, Effect, Option } from "effect"
import { admissionNamespace, admitCommand, hasOutboxAdmission } from "./features/commands/admission"
import type { FlowName } from "./flows/registry"
import { IssuesStore } from "./features/issues/store"
import { TodosStore } from "./features/todos/store"
import { admissionReceipt, executionOf, finishAdmission, identifyAdmission, recordAdmission, WriteIntents, type WriteIntent } from "./writeAdmission"

/** Replay input receipts once on opening the page; the SDK outbox owns all subsequent retry and recovery. */
export const resumeAdmissions = Effect.gen(function* () {
  const receipts = yield* WriteIntents
  const issues = yield* IssuesStore
  const todos = yield* TodosStore
  const scope = issues.scope
  for (const intent of receipts.pending()) {
    const started = yield* Clock.currentTimeMillis
    if (!hasOutboxAdmission(intent.flow as FlowName)) {
      yield* recordAdmission(intent.commandId, "unknown", "restore", "invalid", started)
      continue
    }
    const executionId = yield* executionOf(intent)
    const id = yield* Uuid.v5(admissionNamespace(intent.flow as FlowName), executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    yield* identifyAdmission(intent, executionId, id)
    receipts.admitting.set(intent.commandId, (receipts.admitting.get(intent.commandId) ?? 0) + 1)
    if (intent.flow === "issue/create") receipts.resumed.set(intent.payload.repo as string, id)
    yield* recordAdmission(intent.commandId, intent.flow, "restore", "recovered", started)
    yield* Effect.gen(function* () {
      const result = yield* admitCommand(intent.flow as FlowName, intent.payload, executionId)
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
  }
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
