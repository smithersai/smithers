import { admissionReceipt, beginAdmission, executionOf, finishAdmission, forgetAdmission, forgetDraftAdmissions, identifyAdmission } from "../../writeAdmission"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Clock, Effect, Metric, Option } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { repoId } from "../repo/contract"
import { isPrompt, isTitle, OP_ID_NAMESPACE, stackPath } from "./contract"
import { pendingActions } from "./metrics"
import { type Draft, type QueuedOp, VIEW } from "./schema"
import { TodosStore } from "./store"

// TODO writes await local durable admission (decision 0016 §3, docs/features/todos.md). Commit
// and Drop are the flows `todo/commit` and `todo/drop`, dispatched with door `button` in the store's scope: the press
// returns at once, and a committed draft goes once its change is queued. Sending runs in the outbox, never in an action.

/**
 * What a stack route calls on a link's hover or focus (the router's intent preload): starts syncing `owner/name`'s
 * stack without showing it, so the page the click opens has its rows.
 */
export const warm = (owner: string, name: string) =>
  Effect.flatMap(TodosStore, (store) => Effect.asVoid(store.stackOf(repoId(owner, name))))

/** What a stack route calls on a navigation: shows `owner/name`'s stack, and, with `number`, that TODO; and syncs the stack. */
export const open = (owner: string, name: string, number?: number) =>
  Effect.gen(function* () {
    const store = yield* TodosStore
    const id = repoId(owner, name)
    yield* store.view.update(VIEW, (row) => {
      row.owner = owner
      row.name = name
      row.repoId = id
      row.number = number ?? null
    })
    yield* store.stackOf(id)
  }).pipe(Effect.orDie)

/** New TODO on `owner/name`'s stack: an empty private draft. Answers its id. */
export const newDraft = (owner: string, name: string) =>
  Effect.gen(function* () {
    const { drafts } = yield* TodosStore
    const id = crypto.randomUUID()
    yield* drafts.insert({
      id,
      repo: `${owner}/${name}`,
      repoId: repoId(owner, name),
      title: "",
      prompt: "",
      acceptance: [],
      answerId: null,
      createdAt: yield* Clock.currentTimeMillis,
    })
    return id
  }).pipe(Effect.orDie)

/** Changes draft `id`'s text; a draft the device no longer has stays gone. */
const changeDraft = (id: string, change: Partial<Pick<Draft, "title" | "prompt">>) =>
  Effect.gen(function* () {
    const { drafts } = yield* TodosStore
    if (Option.isNone(yield* drafts.get(id))) return
    yield* drafts.update(id, (draft) => void Object.assign(draft, change))
  }).pipe(Effect.orDie)

export const setTitle = (id: string, title: string) => changeDraft(id, { title })
export const setPrompt = (id: string, prompt: string) => changeDraft(id, { prompt })

/** Marks draft `id`'s Commit on its way from this tab, or no longer. */
const setCommitting = (id: string, committing: boolean) =>
  Effect.flatMap(TodosStore, ({ view }) =>
    Effect.orDie(view.update(VIEW, (row) => {
      row.committing = committing ? [...row.committing, id] : row.committing.filter((other) => other !== id)
    })))

/** Stable for an unchanged draft snapshot; its content never enters the flow's recorded identity. */
const commitIdentity = (draft: Draft) => ({ namespace: OP_ID_NAMESPACE, value: JSON.stringify([draft.id, draft.repo, draft.title.trim(), draft.prompt, draft.acceptance, draft.issue ?? null]) })
const commitExecutionId = (draft: Draft) => Uuid.v5(OP_ID_NAMESPACE, commitIdentity(draft).value).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)

/** Commit retains its draft until the device durably admits its snapshot. */
export const commit = (id: string) =>
  Effect.gen(function* () {
    const store = yield* TodosStore
    const found = yield* store.drafts.get(id)
    const view = Option.getOrThrow(yield* store.view.get(VIEW))
    if (Option.isNone(found) || view.committing.includes(id)) return undefined
    const draft = found.value
    if (!isTitle(draft.title) || !isPrompt(draft.prompt)) return undefined
    const flows = yield* FlowDispatch
    yield* setCommitting(id, true)
    const payload = { repo: draft.repo, title: draft.title.trim(), prompt: draft.prompt,
      ...(draft.acceptance.length === 0 ? {} : { acceptance: draft.acceptance }),
      ...(draft.issue === undefined ? {} : { issue: draft.issue }) }
    // Input retention must precede any asynchronous progress/toast persistence as well as outbox admission.
    const admission = yield* beginAdmission("todo/commit", payload, commitIdentity(draft), id)
    if (Option.isNone(admission)) { yield* setCommitting(id, false); return undefined }
    const executionId = yield* executionOf(admission.value)
    const opId = yield* Uuid.v5(OP_ID_NAMESPACE, executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    yield* identifyAdmission(admission.value, executionId, opId)
    const { kept } = yield* store.queue({ ...payload, id: opId, op: "commit", number: 0, acceptance: draft.acceptance })
    let cleaned = true
    if (kept) {
      const source = yield* store.drafts.get(id)
      if (Option.isSome(source) && commitIdentity(source.value).value === commitIdentity(draft).value) {
        cleaned = yield* admissionReceipt(store.drafts.delete(id).pipe(Effect.flatMap((removed) => removed.persisted)), admission.value.commandId, "todo/commit", "source").pipe(Effect.as(true), Effect.orElseSucceed(() => false))
      }
      yield* flows.dispatch("todo/commit", payload, { door: "button", executionId }).pipe(Effect.ignore, Effect.forkIn(store.scope, { startImmediately: true }))
    }
    yield* finishAdmission(admission.value, kept, cleaned)
    yield* setCommitting(id, false)
    const [owner, name] = draft.repo.split("/") as [string, string]
    return stackPath(owner, name)
  })

/** Records Edit or Discard on a change, or Discard on a draft. */
const record = (action: "edit" | "discard" | "discard_draft", fields: Record<string, string>) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(pendingActions, { action }), 1),
    Effect.logInfo("todos.pending").pipe(Effect.annotateLogs({ ...fields, action, feature: "todos" })),
  )

/** Discard on draft `id`: it goes. */
export const discardDraft = (id: string) =>
  Effect.gen(function* () {
    const { drafts } = yield* TodosStore
    if (Option.isNone(yield* drafts.get(id)) || !(yield* forgetDraftAdmissions(id))) return
    yield* Effect.ignore(drafts.delete(id))
    yield* record("discard_draft", { draftId: id })
  })

/**
 * Make TODO on issue `number` of `owner/name` (`todo/issue`), from its row, its page or its key: the press returns the
 * stack's page at once, where the draft shows once the step kept it, its title and prompt the issue's.
 */
export const fromIssue = (owner: string, name: string, number: number) =>
  Effect.gen(function* () {
    const store = yield* TodosStore
    const flows = yield* FlowDispatch
    yield* Effect.forkIn(
      Effect.ignore(flows.dispatch("todo/issue", { repo: `${owner}/${name}`, issue: number }, { door: "button" })),
      store.scope,
      { startImmediately: true },
    )
    return stackPath(owner, name)
  })

/** Drop on TODO `number` of `owner/name` (`todo/drop`): the press returns at once, and the TODO shows Requested. */
const admitChange = (op: "drop" | "retry", owner: string, name: string, number: number) =>
  Effect.gen(function* () {
    const store = yield* TodosStore
    const flows = yield* FlowDispatch
    const payload = { repo: `${owner}/${name}`, number }
    const admission = yield* beginAdmission(op === "drop" ? "todo/drop" : "todo/Retry", payload)
    if (Option.isNone(admission)) return
    const executionId = yield* executionOf(admission.value)
    const id = yield* Uuid.v5(OP_ID_NAMESPACE, executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    yield* identifyAdmission(admission.value, executionId, id)
    const row: QueuedOp = { ...payload, id, op, title: "", prompt: "", acceptance: [] }
    const { kept } = yield* store.queue(row)
    yield* finishAdmission(admission.value, kept)
    if (kept) yield* flows.dispatch(op === "drop" ? "todo/drop" : "todo/Retry", payload, { door: "button", executionId }).pipe(
      Effect.ignore, Effect.forkIn(store.scope, { startImmediately: true }),
    )
  })

export const drop = (owner: string, name: string, number: number) => admitChange("drop", owner, name, number)

/**
 * Edit or Discard on a change that wasn't sent: Edit puts a commit's text back in a new draft first. The change goes
 * from the device. Answers the stack's page, or nothing for a change the device doesn't have.
 */
const handle = (opId: string, action: "edit" | "discard") =>
  Effect.gen(function* () {
    const { requested, drafts } = yield* TodosStore
    const found = yield* requested.get(opId)
    if (Option.isNone(found)) return undefined
    const change = found.value
    if (!(yield* forgetAdmission(OP_ID_NAMESPACE, change.id))) return undefined
    if (action === "edit" && change.op === "commit") {
      yield* Effect.orDie(drafts.insert({
        id: crypto.randomUUID(),
        repo: change.repo,
        repoId: change.repoId,
        title: change.title,
        prompt: change.prompt,
        acceptance: change.acceptance,
        answerId: null,
        createdAt: yield* Clock.currentTimeMillis,
        ...(change.issue === undefined ? {} : { issue: change.issue }),
      }))
    }
    yield* Effect.ignore(requested.delete(opId))
    yield* record(action, { opId, op: change.op })
    const [owner, name] = change.repo.split("/") as [string, string]
    return stackPath(owner, name)
  })

/** Edit on a commit that wasn't sent: its text goes back to a draft. Answers the stack's page. */
export const edit = (opId: string) => handle(opId, "edit")

/** Discard on a change that wasn't sent: it goes. */
export const discard = (opId: string) => Effect.asVoid(handle(opId, "discard"))

/** Retries local admission using the retained identity, without inventing another TODO. */
export const retryChange = (id: string) => Effect.gen(function* () {
  const store = yield* TodosStore
  const row = yield* store.requested.get(id)
  if (Option.isNone(row) || row.value.status !== "not_sent" || row.value.reason !== null) return
  const { kept } = yield* store.queue(row.value)
  if (!kept || row.value.op !== "commit") return
  for (const draft of yield* store.drafts.toArray) {
    const opId = yield* Uuid.v5(OP_ID_NAMESPACE, yield* commitExecutionId(draft)).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    if (opId === id) yield* store.drafts.delete(draft.id).pipe(Effect.flatMap((removed) => removed.persisted), Effect.ignore)
  }
})

/** Retry returns once the durable launch is requested; the outbox sends in the background. */
export const retry = (owner: string, name: string, number: number) => admitChange("retry", owner, name, number)
