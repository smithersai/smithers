import { acknowledgeNavigation, admissionReceipt, beginAdmission, identifyAdmission, executionOf, finishAdmission, finishRetainedAdmission, whileAdmitting, forgetAdmission, WriteIntents } from "../../writeAdmission"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { keep } from "./writes"
import type { Commitment } from "./lifecycle"
import { Clock, Effect, Metric, Option } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { repoId } from "../repo/contract"
import {
  commentDraftKey,
  issuePath,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  newDraftKey,
  newIssuePath,
  WRITE_ID_NAMESPACE,
  type TriageDecision,
} from "./contract"
import { admissions, pendingActions, submissionFailures } from "./metrics"
import { recordShapeRetry } from "./shapeSync"
import { type Draft, type QueuedWrite, VIEW } from "./schema"
import { IssuesStore } from "./store"

// Issue writes resolve after the device retains their intent and admits them to its durable outbox. Public flows
// join the same write in the background; the outbox owns delivery after this tab closes.

/**
 * What an issue route calls on a link's hover or focus (the router's intent preload): starts `owner/name`'s issues'
 * sync without showing a page, so the page the click opens has its rows.
 */
export const warm = (owner: string, name: string, number?: number) =>
  Effect.flatMap(IssuesStore, (store) => Effect.asVoid(store.forRepo(repoId(owner, name), number)))

/** Reconnects this tab's issue shapes after one stopped or failed; the SDK owns retries and resumption. */
export const reconnectShapes = Effect.flatMap(IssuesStore, (store) =>
  Effect.all([store.routed().reconnect, store.writes.reconnect], { discard: true }))

/** A person's Try again on an unavailable direct issue. */
export const retry = Effect.andThen(reconnectShapes, recordShapeRetry("issue"))

/**
 * What the route calls on a navigation: shows `owner/name`'s issues, or, with `number`, that issue; and opens that
 * repository's issues, its own shapes (decision 0079 slice 1b), once.
 */
export const open = (owner: string, name: string, number?: number, writeId?: string | null) =>
  Effect.gen(function* () {
    const store = yield* IssuesStore
    const id = repoId(owner, name)
    yield* store.forRepo(id, number)
    yield* store.route(id, number)
    const intents = yield* Effect.serviceOption(WriteIntents)
    const resumed = Option.isSome(intents) ? intents.value.resumed.get(`${owner}/${name}`) : undefined
    if (typeof writeId === "string" && Option.isSome(intents)) {
      yield* acknowledgeNavigation(writeId)
      intents.value.resumed.delete(`${owner}/${name}`)
    }
    yield* store.view.update(VIEW, (row) => {
      row.owner = owner
      row.name = name
      row.repoId = id
      row.number = number ?? null
      row.draftKey = number === undefined ? newDraftKey(id) : commentDraftKey(id, number)
      row.submitting = false
      delete row.submissionKey
      delete row.createdWriteId
      if (number === undefined && writeId === null && resumed !== undefined) row.createdWriteId = resumed
      delete row.submissionFailed
    })
  }).pipe(Effect.orDie)

/** Changes draft `key`, made empty first if the device has none. */
const changeDraft = (key: string, change: Partial<Omit<Draft, "id">>) =>
  Effect.gen(function* () {
    const { drafts } = yield* IssuesStore
    if (Option.isNone(yield* drafts.get(key))) yield* drafts.insert({ id: key, title: "", body: "", ...change })
    else yield* drafts.update(key, (draft) => void Object.assign(draft, change))
  }).pipe(Effect.orDie)

export const setNewTitle = (owner: string, name: string, title: string) =>
  changeDraft(newDraftKey(repoId(owner, name)), { title })

export const setNewBody = (owner: string, name: string, body: string) =>
  changeDraft(newDraftKey(repoId(owner, name)), { body })

export const setCommentDraft = (owner: string, name: string, number: number, body: string) =>
  changeDraft(commentDraftKey(repoId(owner, name), number), { body })

/** A new issue's draft as `issue/create` takes it: a title that isn't blank, and both within GitHub's limits. */
export const newIssueOf = (draft: Draft | undefined) => {
  const title = draft?.title.trim() ?? ""
  if (title === "" || title.length > MAX_TITLE_LENGTH || draft!.body.length > MAX_BODY_LENGTH) return undefined
  return { title, body: draft!.body }
}

/** A comment's draft as `issue/comment` takes it: not blank, and within GitHub's limit. */
export const commentBodyOf = (draft: Draft | undefined) => {
  const body = draft?.body ?? ""
  return body.trim() === "" || body.length > MAX_BODY_LENGTH ? undefined : body
}

const setSubmitting = (submitting: boolean) =>
  Effect.flatMap(IssuesStore, ({ view }) => Effect.orDie(view.update(VIEW, (row) => void (row.submitting = submitting))))

/** The view's press is on its way already. */
const submitting = Effect.flatMap(IssuesStore, ({ view }) => Effect.map(view.get(VIEW), (row) => Option.getOrThrow(row).submitting))

/** Retain recoverable intent, await local admission, then join the public flow under the same identity. */
const admitWrite = (write: Omit<QueuedWrite, "id" | "credential">, join: (executionId: string) => Effect.Effect<unknown, unknown>, key?: string) =>
  Effect.gen(function* () {
    const store = yield* IssuesStore
    const { drafts, view } = store
    const admission = yield* beginAdmission(write.op, write as unknown as Readonly<Record<string, unknown>>, undefined, key)
    if (Option.isNone(admission)) {
      yield* view.update(VIEW, value => { value.submissionFailed = true })
      return false
    }
    const executionId = yield* executionOf(admission.value)
    yield* view.update(VIEW, (row) => {
      if (key !== undefined) { row.submitting = true; row.submissionKey = executionId }
      delete row.submissionFailed
    })
    const id = yield* Uuid.v5(WRITE_ID_NAMESPACE, executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    yield* identifyAdmission(admission.value, executionId, id)
    const row = { ...write, id, repoId: repoId(...write.repo.split("/") as [string, string]), queuedAt: yield* Clock.currentTimeMillis, v: 3 as const }
    // A recoverable receipt precedes every asynchronous admission. If this tab closes here, no old tab is needed
    // to recover the text, and Retry uses this same write identity.
    const kept = yield* Effect.result(admissionReceipt(keep(store.requested, row, "not_sent", null), admission.value.commandId, write.op, "recovery"))
    const current = Option.getOrThrow(yield* view.get(VIEW))
    if (kept._tag === "Failure") {
      if (key === undefined || current.submissionKey === executionId) yield* view.update(VIEW, (value) => {
        if (key !== undefined) value.submitting = false
        value.submissionFailed = true
      })
      if (write.op === "issue/comment") yield* Metric.update(Metric.withAttributes(submissionFailures, { reason: "storage" }), 1)
      yield* finishAdmission(admission.value, false)
      yield* Metric.update(Metric.withAttributes(admissions, { outcome: "storage_failed" }), 1)
      yield* Effect.logWarning("issues.write.admission").pipe(Effect.annotateLogs({ feature: "issues", writeId: id, op: row.op, outcome: "storage_failed" }))
      return false
    }
    if (write.op === "issue/create" && current.submissionKey === executionId) yield* view.update(VIEW, (value) => { value.createdWriteId = id })
    const { queued } = yield* store.queue(row)
    const latest = Option.getOrThrow(yield* view.get(VIEW))
    let cleaned = true
    if (latest.submissionKey === executionId) {
      if (queued && key !== undefined) {
        const source = yield* drafts.get(key)
        if (Option.isSome(source) && source.value.body === (write.body ?? "") &&
          (write.op !== "issue/create" || source.value.title.trim() === write.title)) {
          cleaned = yield* admissionReceipt(drafts.delete(key).pipe(Effect.flatMap((removed) => removed.persisted)), admission.value.commandId, write.op, "source").pipe(Effect.as(true), Effect.orElseSucceed(() => false))
        }
      }
      if (!queued && write.op === "issue/comment") yield* view.update(VIEW, (value) => { value.submissionFailed = true })
      yield* setSubmitting(false)
    }
    yield* finishAdmission(admission.value, queued, cleaned)
    yield* Metric.update(Metric.withAttributes(admissions, { outcome: queued ? "queued" : "not_admitted" }), 1)
    yield* Effect.logInfo("issues.write.admission").pipe(Effect.annotateLogs({
      feature: "issues", writeId: id, op: row.op, outcome: queued ? "queued" : "not_admitted",
    }))
    // The durable outbox already owns delivery. The public flow joins the same write, so engine startup and the
    // asking tab's lifetime cannot hold admission hostage or create a second issue.
    if (queued) yield* join(executionId).pipe(Effect.ignore, Effect.forkIn(store.scope, { startImmediately: true }))
    return key !== undefined || queued
  })

export const create = (owner: string, name: string) => Effect.gen(function* () {
  const { drafts } = yield* IssuesStore
  const key = newDraftKey(repoId(owner, name))
  const issue = newIssueOf(Option.getOrUndefined(yield* drafts.get(key)))
  if (issue === undefined || (yield* submitting)) return false
  const flows = yield* FlowDispatch
  const payload = { repo: `${owner}/${name}`, ...issue }
  return yield* admitWrite({ ...payload, op: "issue/create", number: 0 }, (executionId) => flows.dispatch("issue/create", payload, { door: "button", executionId }), key)
})

/** Retry a locally retained admission under its original id; the server and outbox deduplicate it. */
export const retryWrite = (writeId: string) => whileAdmitting(writeId, Effect.gen(function* () {
  const store = yield* IssuesStore
  const held = yield* store.requested.get(writeId)
  if (Option.isNone(held) || held.value.status !== "not_sent" || held.value.reason !== null) return
  const { queued } = yield* store.queue(held.value)
  let cleaned = true
  if (queued) {
    const row = held.value
    const key = row.op === "issue/create" ? newDraftKey(row.repoId) : commentDraftKey(row.repoId, row.number)
    const draft = yield* store.drafts.get(key)
    if (Option.isSome(draft) && draft.value.body === row.body && (row.op !== "issue/create" || draft.value.title.trim() === row.title)) {
      cleaned = yield* store.drafts.delete(key).pipe(Effect.flatMap((removed) => removed.persisted), Effect.as(true), Effect.orElseSucceed(() => false))
      yield* store.view.update(VIEW, (view) => { if (view.draftKey === key) delete view.submissionFailed }).pipe(Effect.orDie)
    }
  }
  yield* finishRetainedAdmission(writeId, queued, cleaned)
}))

/** Comment on issue `number` of `owner/name`: `issue/comment` with its draft. Answers whether it ran. */
export const comment = (owner: string, name: string, number: number) =>
  Effect.gen(function* () {
    const { drafts, requested } = yield* IssuesStore
    const key = commentDraftKey(repoId(owner, name), number)
    const body = commentBodyOf(Option.getOrUndefined(yield* drafts.get(key)))
    if (body === undefined || (yield* submitting)) return false
    const recovery = (yield* requested.toArray).find((row) => row.op === "issue/comment" && row.repoId === repoId(owner, name) && row.number === number && row.body === body && row.status === "not_sent" && row.reason === null)
    if (recovery !== undefined) {
      yield* retryWrite(recovery.id)
      return true
    }
    const flows = yield* FlowDispatch
    const payload = { repo: `${owner}/${name}`, number, body }
    return yield* admitWrite({ ...payload, op: "issue/comment", title: "" }, (executionId) => flows.dispatch("issue/comment", payload, { door: "button", executionId }), key)
  })

/** Every issue outbox operation owns its durable admission before the button's action resolves. */
const operation = <N extends "issue/triage" | "triage/run" | "triage/enable" | "triage/pause" | "issue/commitment">(
  op: N, payload: import("../../flows/dispatch").PayloadOf<N>, fields: Partial<QueuedWrite>,
) => Effect.gen(function* () {
  const flows = yield* FlowDispatch
  return yield* admitWrite({ repo: payload.repo, op, title: "", body: "", number: 0, ...fields },
    (executionId) => flows.dispatch(op, payload, { door: "button", executionId }))
})

export const triage = (owner: string, name: string, number: number, decision: TriageDecision) =>
  operation("issue/triage", { repo: `${owner}/${name}`, number, decision }, { number, decision })
export const runTriageAgain = (owner: string, name: string, number: number) =>
  operation("triage/run", { repo: `${owner}/${name}`, number }, { number })
export const enableTriage = (owner: string, name: string) =>
  operation("triage/enable", { repo: `${owner}/${name}` }, {})
export const pauseTriage = (owner: string, name: string) =>
  operation("triage/pause", { repo: `${owner}/${name}` }, {})

/**
 * Edit (`edit`) or Discard on a write that wasn't sent: Edit puts its text back in its draft first. The write goes from
 * the device. Answers where its draft is edited: the new-issue form, or the issue's page; nothing for a write the
 * device doesn't have.
 */
const handle = (writeId: string, action: "edit" | "discard") =>
  Effect.gen(function* () {
    const { requested } = yield* IssuesStore
    const found = yield* requested.get(writeId)
    if (Option.isNone(found)) return undefined
    const write = found.value
    if (!(yield* forgetAdmission(WRITE_ID_NAMESPACE, write.id))) return undefined
    const [owner, name] = write.repo.split("/") as [string, string]
    const created = write.op === "issue/create"
    if (action === "edit") {
      yield* created
        ? changeDraft(newDraftKey(write.repoId), { title: write.title, body: write.body })
        : changeDraft(commentDraftKey(write.repoId, write.number), { body: write.body })
    }
    yield* Effect.ignore(requested.delete(writeId))
    yield* Metric.update(Metric.withAttributes(pendingActions, { action }), 1)
    yield* Effect.logInfo("issues.pending").pipe(Effect.annotateLogs({ writeId, op: write.op, action, feature: "issues" }))
    return created ? newIssuePath(owner, name) : issuePath(owner, name, write.number)
  })

/** Edit on a write that wasn't sent: its text goes back to its draft. Answers the path where that draft is edited. */
export const edit = (writeId: string) => handle(writeId, "edit")

/** Discard on a write that wasn't sent: it goes. */
export const discard = (writeId: string) => Effect.asVoid(handle(writeId, "discard"))

/** A Maintainer's own press; the write is admitted and completed in the durable outbox. */
export const setCommitment = (owner: string, name: string, number: number, commitment: Commitment, previousWriteId?: string) =>
  Effect.gen(function* () {
    const kept = yield* operation("issue/commitment", { repo: `${owner}/${name}`, number, commitment }, { number, commitment })
    if (kept && previousWriteId !== undefined) yield* discard(previousWriteId)
  })
