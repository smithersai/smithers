import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement, type Planned } from "@smthrs/plan"
import { Schema } from "effect"
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "../issues/contract"
import { RepoName } from "../repo/flows"
import { CreationSelection } from "./creation"
import { Receipt, RealmRequest } from "./creationFlows"
import { BranchName, TrackFailure } from "./flows"

// Publish, Update branch and Resync on this device's engine (docs/features/branch-publish.md): the registry's
// `branch/publish`, `branch/update` and `branch/resync`, which a person's press on the branch page, a slash command and
// the agent run alike (ruling FLOW-3). Publish and Update branch select the repository's flow for the operation (the
// first-party `branches` plugin's unless `.smithers/branch.json` names its own), run it in the realm as branch creation
// runs its flow, and send the one write its host action asks for to ChatApi's writes route. Resync writes nothing to
// GitHub and chooses nothing a repository's flow could, so it sends its write directly. Each write settles on the
// server; this device's answer is its id.

/** A pull request's title: GitHub's limit, never blank. */
export const Title = Schema.String.check(
  Schema.makeFilter((title: string) => title.trim().length > 0 && title.length <= MAX_TITLE_LENGTH),
)

/** A pull request's body. */
export const Body = Schema.String.check(Schema.isMaxLength(MAX_BODY_LENGTH))

/** What a Publish or an Update answers once ChatApi took its write: the write's id and the branch it acts on. */
export const Submitted = Schema.Struct({ writeId: Schema.String, branchId: Schema.String })
export type Submitted = typeof Submitted.Type

/**
 * While ChatApi is unreachable or restarting, a step tries again: 500 ms doubling to 4 s, for at most 30 seconds. A
 * write is sent under its own id, so sending it again changes nothing.
 */
export const WRITE_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 4_000,
  expirationMs: 30_000,
  nonRetryable: ["@smthrs/mvp/branch/BranchTrackRefused"],
})

/** One operation's request: the branch it acts on, what the person said, and its write's id (`request`). */
export const OperationRequest = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  branchId: Schema.String,
  operation: Schema.Literals(["publish", "update"]),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  request: Schema.String,
})
export type OperationRequest = typeof OperationRequest.Type

export const OperationState = Schema.Struct({
  selection: CreationSelection,
  request: OperationRequest,
  receipts: Schema.Array(Receipt),
})
export const OperationEvaluated = Schema.Union([RealmRequest, Schema.Struct({ _tag: Schema.Literal("Complete"), value: Submitted })])

export const SelectOperation = Action.make("branch/operation/select", {
  payload: OperationRequest,
  success: CreationSelection,
  error: TrackFailure,
  retryPolicy: WRITE_RETRY,
})
export const EvaluateOperation = Action.make("branch/operation/evaluate", {
  payload: OperationState,
  success: OperationEvaluated,
  error: TrackFailure,
})
export const CallOperation = Action.make("branch/operation/call", {
  payload: { state: OperationState, call: RealmRequest },
  success: Receipt,
  error: TrackFailure,
  retryPolicy: WRITE_RETRY,
})

type Program = Flow.Flow<"branch/operation/program", typeof OperationState, typeof Submitted, typeof TrackFailure,
  Action.Requirement<"branch/operation/evaluate"> | Action.Requirement<"branch/operation/call">>

/** One realm evaluation and host call per durable round; every resume reuses the pinned source and prior receipts. */
export const OperationProgram: Program = Flow.make("branch/operation/program", {
  payload: OperationState,
  success: Submitted,
  error: TrackFailure,
  body: Node.capture({ evaluate: EvaluateOperation.name, call: CallOperation.name }, (state) =>
    EvaluateOperation.call(state).pipe(Node.branch({
      if: Node.capture({}, (result) => result._tag === "Complete"),
      then: Node.capture({}, (result) =>
        Flow.done((result as Planned.Planned<Extract<typeof OperationEvaluated.Type, { _tag: "Complete" }>>).value)),
      else: Node.capture({ call: CallOperation.name }, (result) =>
        CallOperation.call({ state, call: result as Planned.Planned<typeof RealmRequest.Type> }).pipe(
          Node.bindPlanned(Node.capture({}, (receipt) => OperationProgram.to({ ...state, receipts: [...state.receipts, receipt] }))),
        )),
    }))),
})

/** The selector and the selected implementation form one durable lineage, as branch creation's do. */
export const OperationStart = Flow.make("branch/operation/start", {
  payload: OperationRequest,
  success: Submitted,
  error: TrackFailure,
  body: Node.capture({ select: SelectOperation.name }, (request) =>
    SelectOperation.call(request).pipe(Node.bindPlanned(Node.capture({}, (selection) =>
      OperationProgram.to({ selection, request, receipts: [] }))))),
})

const publishPayload = { repo: RepoName, branch: BranchName, title: Title, body: Schema.optional(Body) }

/** `branch/publish`'s one step: find the branch, then run its repository's Publish flow. */
export const PublishRequest = Action.make("branch/publish/request", {
  payload: publishPayload,
  success: Submitted,
  error: TrackFailure,
  retryPolicy: WRITE_RETRY,
})

/** `branch/publish { repo, branch, title, body }` (docs/features/branch-publish.md#publish). */
export const BranchPublish = Flow.make("branch/publish", {
  description: "Publish a Smithers-only branch of a GitHub repository (owner/name) to GitHub: its working copy's " +
    "change as one commit on a new GitHub branch, and a pull request into the default branch titled `title` with " +
    "`body`, as the person. Answers { writeId, branchId } once the write is admitted; it settles on the branch page. " +
    "BranchTrackRefused says why not: not_found, sign_in, forbidden, invalid, not_configured, or exists (a Publish is " +
    "on its way or the branch is published).",
  modelInvocable: true,
  payload: publishPayload,
  success: Submitted,
  error: TrackFailure,
  body: Node.capture({ request: PublishRequest.name }, (request) => PublishRequest.call(request)),
}).annotate(Flow.Placement, Placement.client())

const updatePayload = { repo: RepoName, branch: BranchName }

/** `branch/update`'s one step: find the branch, then run its repository's Update branch flow. */
export const UpdateRequest = Action.make("branch/update/request", {
  payload: updatePayload,
  success: Submitted,
  error: TrackFailure,
  retryPolicy: WRITE_RETRY,
})

/** `branch/update { repo, branch }` (docs/features/branch-publish.md#update-branch). */
export const BranchUpdate = Flow.make("branch/update", {
  description: "Bring a published branch of a GitHub repository (owner/name) up to date with its pull request's base " +
    "on GitHub, as the person: a merge commit unless the repository's flow rebases; a conflict is reported, never " +
    "resolved. Answers { writeId, branchId } once the write is admitted. BranchTrackRefused says why not: not_found, " +
    "sign_in, forbidden, invalid or not_configured.",
  modelInvocable: true,
  payload: updatePayload,
  success: Submitted,
  error: TrackFailure,
  body: Node.capture({ request: UpdateRequest.name }, (request) => UpdateRequest.call(request)),
}).annotate(Flow.Placement, Placement.client())

const resyncPayload = { repo: RepoName, branch: BranchName }

/** `branch/resync`'s one step: find the branch, then send its Resync. */
export const ResyncRequest = Action.make("branch/resync/request", {
  payload: resyncPayload,
  success: Submitted,
  error: TrackFailure,
  retryPolicy: WRITE_RETRY,
})

/** `branch/resync { repo, branch }` (docs/features/branch-publish.md#resync). */
export const BranchResync = Flow.make("branch/resync", {
  description: "Bring a published branch's working copy of a GitHub repository (owner/name) to the head its GitHub " +
    "branch reached (after a push, a commit on github.com or an Update branch), keeping its own changes; a file both " +
    "changed stops it as a conflict, never resolved. Answers { writeId, branchId } once the write is admitted; it " +
    "settles on the branch page. BranchTrackRefused says why not: not_found, sign_in, forbidden, invalid, " +
    "not_configured, or exists (a Publish or a Resync is on its way).",
  modelInvocable: true,
  payload: resyncPayload,
  success: Submitted,
  error: TrackFailure,
  body: Node.capture({ request: ResyncRequest.name }, (request) => ResyncRequest.call(request)),
}).annotate(Flow.Placement, Placement.client())
