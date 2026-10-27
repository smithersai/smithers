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
import { type Draft, VIEW } from "./schema"
import { IssuesStore } from "./store"

// What a person does on the issue pages, as Effects that finish synchronously, but for opening a repository's issues,
// which waits for its collections to open (`forRepo`). Opening an issue and commenting are the
// flows `issue/create` and `issue/comment`, dispatched with door `button` in the store's scope: the press returns at
// once, and the draft clears once the write is queued. Sending runs in the outbox, never in an action.

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
export const open = (owner: string, name: string, number?: number) =>
  Effect.gen(function* () {
    const store = yield* IssuesStore
    const id = repoId(owner, name)
    yield* store.forRepo(id, number)
    yield* store.route(id, number)
    yield* store.view.update(VIEW, (row) => {
      row.owner = owner
      row.name = name
      row.repoId = id
      row.number = number ?? null
      row.draftKey = number === undefined ? newDraftKey(id) : commentDraftKey(id, number)
      row.submitting = false
      delete row.submissionKey
      delete row.createdWriteId
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

/**
 * Runs `dispatch` in the store's scope while the view says it is submitting; once the flow answers, the draft `key`
 * goes. A flow that failed, or didn't run, keeps it: the dispatch has logged and counted why.
 */
const submit = <A extends { readonly _tag: string }>(key: string, dispatch: (executionId: string) => Effect.Effect<A, unknown, FlowDispatch>) =>
  Effect.gen(function* () {
    const store = yield* IssuesStore
    const submissionKey = crypto.randomUUID()
    yield* store.view.update(VIEW, (row) => { row.submitting = true; row.submissionKey = submissionKey; delete row.submissionFailed })
    const done = Effect.gen(function* () {
      const answered = yield* Effect.result(dispatch(submissionKey))
      const current = Option.getOrThrow(yield* store.view.get(VIEW))
      if (current.submissionKey !== submissionKey) return
      if (answered._tag === "Success" && answered.success._tag === "Done") yield* Effect.ignore(store.drafts.delete(key))
      else {
        yield* store.view.update(VIEW, (row) => { row.submissionFailed = true })
        const reason = answered._tag === "Failure" ? "dispatch" : "flow"
        yield* Metric.update(Metric.withAttributes(submissionFailures, { reason }), 1)
        yield* Effect.logWarning("issues.submission.not_sent").pipe(Effect.annotateLogs({ feature: "issues", op: "issue/comment", executionId: submissionKey, reason }))
      }
      yield* setSubmitting(false)
    })
    yield* Effect.forkIn(done, store.scope, { startImmediately: true })
  })

/** The view's press is on its way already. */
const submitting = Effect.flatMap(IssuesStore, ({ view }) => Effect.map(view.get(VIEW), (row) => Option.getOrThrow(row).submitting))

/**
 * Create issue on `owner/name`'s new-issue form: `issue/create` with its draft. Answers whether it ran: not for a
 * blank title, a draft over the limits, or while a press is on its way.
 */
export const create = (owner: string, name: string) =>
  Effect.gen(function* () {
    const store = yield* IssuesStore
    const { drafts, view } = store
    const key = newDraftKey(repoId(owner, name))
    const issue = newIssueOf(Option.getOrUndefined(yield* drafts.get(key)))
    if (issue === undefined || (yield* submitting)) return false
    const flows = yield* FlowDispatch
    const executionId = crypto.randomUUID()
    yield* view.update(VIEW, (row) => { row.submitting = true; row.submissionKey = executionId; delete row.submissionFailed })
    const id = yield* Uuid.v5(WRITE_ID_NAMESPACE, executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    const row = { id, repo: `${owner}/${name}`, repoId: repoId(owner, name), op: "issue/create" as const,
      ...issue, number: 0, queuedAt: yield* Clock.currentTimeMillis, v: 3 as const }
    // A recoverable receipt precedes every asynchronous admission. If this tab closes here, no old tab is needed
    // to recover the text, and Retry uses this same write identity.
    const kept = yield* Effect.result(keep(store.requested, row, "not_sent", null))
    const current = Option.getOrThrow(yield* view.get(VIEW))
    if (kept._tag === "Failure") {
      if (current.submissionKey === executionId) yield* view.update(VIEW, (value) => { value.submitting = false; value.submissionFailed = true })
      yield* Metric.update(Metric.withAttributes(admissions, { outcome: "storage_failed" }), 1)
      yield* Effect.logWarning("issues.write.admission").pipe(Effect.annotateLogs({ feature: "issues", writeId: id, op: row.op, outcome: "storage_failed" }))
      return false
    }
    if (current.submissionKey === executionId) yield* view.update(VIEW, (value) => { value.createdWriteId = id })
    const { queued } = yield* store.queue(row)
    const latest = Option.getOrThrow(yield* view.get(VIEW))
    if (latest.submissionKey === executionId) {
      if (queued) yield* Effect.ignore(drafts.delete(key))
      yield* setSubmitting(false)
    }
    yield* Metric.update(Metric.withAttributes(admissions, { outcome: queued ? "queued" : "not_admitted" }), 1)
    yield* Effect.logInfo("issues.write.admission").pipe(Effect.annotateLogs({
      feature: "issues", writeId: id, op: row.op, outcome: queued ? "queued" : "not_admitted",
    }))
    // The durable outbox already owns delivery. The public flow joins the same write, so engine startup and the
    // asking tab's lifetime cannot hold admission hostage or create a second issue.
    if (queued) yield* flows.dispatch("issue/create", { repo: row.repo, ...issue }, { door: "button", executionId }).pipe(
      Effect.ignore, Effect.forkIn(store.scope, { startImmediately: true }),
    )
    return true
  })

/** Retry a locally retained admission under its original id; the server and outbox deduplicate it. */
export const retryWrite = (writeId: string) => Effect.gen(function* () {
  const store = yield* IssuesStore
  const held = yield* store.requested.get(writeId)
  if (Option.isNone(held) || held.value.status !== "not_sent" || held.value.reason !== null) return
  yield* store.queue(held.value)
})

/** Comment on issue `number` of `owner/name`: `issue/comment` with its draft. Answers whether it ran. */
export const comment = (owner: string, name: string, number: number) =>
  Effect.gen(function* () {
    const { drafts } = yield* IssuesStore
    const key = commentDraftKey(repoId(owner, name), number)
    const body = commentBodyOf(Option.getOrUndefined(yield* drafts.get(key)))
    if (body === undefined || (yield* submitting)) return false
    const flows = yield* FlowDispatch
    yield* submit(key, (executionId) => flows.dispatch("issue/comment", { repo: `${owner}/${name}`, number, body }, { door: "button", executionId }))
    return true
  })

/**
 * Runs `dispatch` in the store's scope: the press returns at once, and the write shows as Requested from the outbox. A
 * flow that failed, or didn't run, has logged and counted why.
 */
const press = <R>(dispatch: Effect.Effect<unknown, unknown, R>) =>
  Effect.gen(function* () {
    const store = yield* IssuesStore
    yield* Effect.forkIn(Effect.ignore(dispatch), store.scope, { startImmediately: true })
  })

/** Accept or Not accepted on issue `number` of `owner/name` (`issue/triage`): pins the issue against the flow. */
export const triage = (owner: string, name: string, number: number, decision: TriageDecision) =>
  Effect.flatMap(FlowDispatch, (flows) =>
    press(flows.dispatch("issue/triage", { repo: `${owner}/${name}`, number, decision }, { door: "button" })))

/** Run triage again on issue `number` of `owner/name` (`triage/run`): unpins it and has the flow decide it again. */
export const runTriageAgain = (owner: string, name: string, number: number) =>
  Effect.flatMap(FlowDispatch, (flows) =>
    press(flows.dispatch("triage/run", { repo: `${owner}/${name}`, number }, { door: "button" })))

/** Enable triage on `owner/name` (`triage/enable`), at the default daily budget. */
export const enableTriage = (owner: string, name: string) =>
  Effect.flatMap(FlowDispatch, (flows) =>
    press(flows.dispatch("triage/enable", { repo: `${owner}/${name}` }, { door: "button" })))

/** Pause triage on `owner/name` (`triage/pause`). */
export const pauseTriage = (owner: string, name: string) =>
  Effect.flatMap(FlowDispatch, (flows) =>
    press(flows.dispatch("triage/pause", { repo: `${owner}/${name}` }, { door: "button" })))

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
  Effect.flatMap(FlowDispatch, (flows) =>
    press(Effect.gen(function* () {
      const result = yield* flows.dispatch("issue/commitment", { repo: `${owner}/${name}`, number, commitment }, { door: "button" })
      // Replacing a refused write retains the old failure until the new request has a durable queue receipt.
      if (result._tag === "Done" && previousWriteId !== undefined) yield* discard(previousWriteId)
    })))
