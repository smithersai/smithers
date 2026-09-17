/** Append exactly the checked native change through the existing landing policy. */
import { Action, Flow, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import { Landing } from "../coding/landing.ts"
import { AppendObservation, AppendPreparation, LandingIdentity, QueuedAppend } from "../coding/landing-schema.ts"
import { NativeCoding, SourceCreation, requestIdFor } from "../coding/native.ts"
import { CodingError, Revision } from "../coding/schema.ts"
import { currentExecutionId } from "./inspection.ts"
import { Work, retainedStepError } from "./jobs.ts"
import { StepResult } from "./schema.ts"
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const service = Effect.gen(function*() { const value = yield* Effect.serviceOption(Landing)
  return Option.isSome(value) ? value.value : yield* invalid("Connect the native landing adapter to submit this checked change") })
const Input = Schema.Struct({ work: Work, result: StepResult })
const Prepared = Schema.Struct({ input: Input, source: Revision, preparation: AppendPreparation })
const Prepare = Action.make("repository/prepare-landing", { payload: Input, success: Prepared, error: CodingError, nondeterministic: true })
const Create = Action.make("repository/create-landing", { payload: Prepared, success: LandingIdentity, error: CodingError, nondeterministic: true })
const Queue = Action.make("repository/queue-landing", { payload: { prepared: Prepared, identity: LandingIdentity }, success: QueuedAppend, error: CodingError, nondeterministic: true })
const Observed = Schema.Union([AppendObservation, Schema.Struct({ status: Schema.Literal("unobserved"), reason: Schema.String })])
const Observe = Action.make("repository/observe-landing", { payload: { queued: QueuedAppend, deadlineAt: Schema.Number, attempt: Schema.Number }, success: Poll.CheckResult(Observed), error: Schema.Never, nondeterministic: true })
const AwaitLanding = Poll.make("repository/AwaitLanding", { input: { queued: QueuedAppend, deadlineAt: Schema.Number }, result: Observed,
  intervalMs: 5000, maxAttempts: 1441, onTimeout: "return-last", check: Node.capture({ action: Observe.name, policy: "repository-delivery/v1" }, input => Observe.call(input)) })
const Retain = Action.make("repository/retain-landing", { payload: { prepared: Prepared, queued: QueuedAppend, observed: Observed }, success: StepResult, error: CodingError })
const RetainFailure = Action.make("repository/retain-delivery-failure", { payload: { input: Input, error: Schema.Json }, success: StepResult, error: CodingError })
export const DeliverChange = Flow.make("repository/DeliverChange", { payload: Input, success: StepResult, error: Schema.Union([CodingError, Poll.Failure]),
  body: input => Prepare.call(input).pipe(
    Node.bindPlanned(prepared => Create.call(prepared).pipe(
      Node.bindPlanned(identity => Queue.call({ prepared, identity })),
      Node.bindPlanned(queued => AwaitLanding.child({ queued, deadlineAt: input.work.deadlineAt }).pipe(
        Node.bindPlanned(observed => Retain.call({ prepared, queued, observed }))
      ))
    )),
    Node.catch({ error: Schema.Union([CodingError, Poll.Failure]), onFailure: error => Node.succeed(error).pipe(
      Node.map(retainedStepError), Node.bindPlanned(error => RetainFailure.call({ input, error }))
    ) })
  ) })
export const deliveryLayers = Layer.mergeAll(Interpreter.layer(DeliverChange), Interpreter.layer(AwaitLanding), Poll.layer, Sleep.layer,
  RetainFailure.toLayer(({ input, error }) => Effect.succeed({ ...input.result, status: "needs-maintainer" as const,
    summary: typeof object(error).message === "string" ? object(error).message as string : "The checked source needs landing inspection",
    output: JSON.parse(JSON.stringify({ ...object(input.result.output), landed: false, deliveryError: error })) })),
  Prepare.toLayer(input => Effect.gen(function*() {
    const { work, result } = input, source = Schema.decodeUnknownOption(Revision)(object(result.output).source)
    if (work.executionMode !== "live" || work.step.id === "poc" || work.step.id === "split" || result.status !== "completed" ||
        object(result.output).status !== "implemented" || Option.isNone(source) || Date.now() >= work.deadlineAt) return yield* invalid("Landing requires the live implemented change and fresh checks")
    const checked = object(object(result.output).checks), checkDetail = object(checked.output)
    if (checked.status !== "completed" || checkDetail.gate !== "passed" || checkDetail.candidate !== source.value.commitId) return yield* invalid("Landing checks do not name this exact native source")
    const creation = Schema.decodeUnknownOption(SourceCreation)(object(result.output).creation)
    if (Option.isNone(creation) || !creation.value.publicationReady || creation.value.source.commitId !== source.value.commitId ||
        creation.value.source.treeId !== source.value.treeId || creation.value.source.changeId !== source.value.changeId || creation.value.source.operationId !== source.value.operationId ||
        source.value.parentCommitIds.length !== 1 || source.value.parentCommitIds[0] !== work.evidence.source.commitId ||
        creation.value.base.commitId !== work.evidence.source.commitId || creation.value.base.treeId !== work.evidence.source.treeId) return yield* invalid("Landing requires the exact owned native creation receipt")
    const native = yield* NativeCoding, landing = yield* service, executionId = yield* currentExecutionId
    if (creation.value.workspaceId !== landing.binding.workspaceId || creation.value.repositoryId !== landing.binding.repositoryId) return yield* invalid("The source creation belongs to another landing workspace")
    const main = yield* landing.readMain
    if (main !== work.evidence.source.commitId) return yield* invalid("Main changed before landing; retain the checked source")
    // Main is already public. The new source is published only through its
    // owned native creation receipt; the editor remains on its prior head.
    yield* native.publishOriginalSource({ requestId: requestIdFor(executionId, "repository-checked-source"), source: creation.value.source,
      creation: { requestId: creation.value.requestId, requestDigest: creation.value.requestDigest } })
    const preparation = yield* landing.prepare({ target_bookmark: "main", expected_commit_id: main,
      source_commit_id: source.value.commitId, source_base_commit_id: work.evidence.source.commitId })
    if (preparation.changes.length !== 1 || preparation.changes[0]!.change_id !== source.value.changeId || preparation.changes[0]!.commit_id !== source.value.commitId) return yield* invalid("Landing includes work outside this checked native change")
    return { input, source: source.value, preparation }
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("Checked source retention or landing preparation failed")))),
  Create.toLayer(prepared => Effect.gen(function*() { return yield* (yield* service).create(requestIdFor(yield* currentExecutionId, "repository-landing"),
    prepared.preparation, prepared.input.work.step.name + "\n\n" + prepared.input.result.summary) })),
  Queue.toLayer(({ prepared, identity }) => Effect.gen(function*() { return yield* (yield* service).queue(identity, prepared.preparation, {
    commit_id: prepared.source.commitId, source_base_commit_id: prepared.preparation.source_base_commit_id,
    expected_commit_id: prepared.preparation.expected_commit_id, description: prepared.input.work.step.name + "\n\n" + prepared.input.result.summary }) })),
  Observe.toLayer(({ queued, deadlineAt }) => Effect.gen(function*() {
    if (Date.now() >= deadlineAt) return { satisfied: true, output: { status: "unobserved" as const, reason: "The job deadline expired while the existing landing remained pending" } }
    const observed = yield* (yield* service).observe(queued)
    return { satisfied: observed.status === "landed" || observed.status === "failed", output: observed }
  }).pipe(Effect.catch(error => Effect.succeed({ satisfied: Date.now() >= deadlineAt,
    output: { status: "unobserved" as const, reason: error instanceof CodingError ? error.message : "The landing receipt could not be read" } })))),
  Retain.toLayer(({ prepared, queued, observed }) => Effect.gen(function*() {
    if (observed.status !== "landed" || observed.task_id !== queued.taskId || observed.result.landed_count !== 1) return yield* invalid(`Landing ${queued.number} has not completed successfully`)
    return { ...prepared.input.result, summary: "Landed", executionId: yield* currentExecutionId,
      evidence: [...prepared.input.result.evidence, `landing:${queued.number}`, `main:${observed.result.target_commit_id}`],
      output: JSON.parse(JSON.stringify({ ...object(prepared.input.result.output), landed: true, landing: queued.number,
        taskId: queued.taskId, mainCommitId: observed.result.target_commit_id, receipt: observed })) }
  }))
)
