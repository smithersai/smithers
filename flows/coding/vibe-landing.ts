/** Append the cleaned request to main through Plue's existing landing policy. */
import { Action, Flow, FlowRuntime, Interpreter, Poll } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { Landing } from "./landing.ts"
import { AppendObservation, AppendPreparation, LandingIdentity, QueuedAppend } from "./landing-schema.ts"
import { requestIdFor } from "./native.ts"
import { CodingError } from "./schema.ts"
import { PublishVibeSource } from "./vibe-publication.ts"
import { VibeCleanup, VibeLanded } from "./vibe-schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
/** Existing landing policy runs in Plue's worker; this bound covers full-history inspection. */
const observationIntervalMs = 10_000, observationAttempts = 90
const Unobserved = Schema.Struct({ status: Schema.Literal("unobserved"), reason: Schema.String })
const Observed = Schema.Union([AppendObservation, Unobserved])

const PrepareAppend = Action.make("coding/prepare-vibe-append", {
  payload: { cleanup: VibeCleanup }, success: AppendPreparation, error: CodingError, nondeterministic: true
})
const CreateLanding = Action.make("coding/create-vibe-landing", {
  payload: { cleanup: VibeCleanup, preparation: AppendPreparation }, success: LandingIdentity, error: CodingError, nondeterministic: true
})
const QueueAppend = Action.make("coding/queue-vibe-append", {
  payload: { cleanup: VibeCleanup, preparation: AppendPreparation, landing: LandingIdentity }, success: QueuedAppend,
  error: CodingError, nondeterministic: true
})
const ObserveAppend = Action.make("coding/observe-vibe-append", {
  payload: { queued: QueuedAppend, attempt: Schema.Number }, success: Poll.CheckResult(Observed), error: CodingError, nondeterministic: true
})
const VerifyLanded = Action.make("coding/verify-vibe-landed", {
  payload: { cleanup: VibeCleanup, cleanedSource: PublishVibeSource.successSchema, queued: QueuedAppend, observed: Observed },
  success: VibeLanded, error: CodingError
})
/** Durable rounds: a process restart resumes the wait, never re-queues the append. */
const AwaitAppend = Poll.make("coding/AwaitVibeAppend", {
  input: { queued: QueuedAppend }, result: Observed, intervalMs: observationIntervalMs, maxAttempts: observationAttempts,
  onTimeout: "return-last",
  check: ({ queued, attempt }) => ObserveAppend.call({ queued, attempt }).pipe(Node.catch({
    onFailure: () => Node.succeed({ satisfied: false, output: { status: "unobserved" as const, reason: "Landing observation was unavailable" } })
  }))
})
export const LandVibeError = Schema.Union([CodingError, Poll.Failure])
export const LandVibe = Flow.make("coding/LandVibe", {
  payload: VibeCleanup, success: VibeLanded, error: LandVibeError,
  // bindPlanned alone lets independent descendants run early. The explicit
  // andThen makes the whole append subtree wait for the retention receipt.
  body: cleanup => PublishVibeSource.child({ source: cleanup.head, phase: "cleaned" }).pipe(
    Node.bindPlanned(cleanedSource => Node.succeed(cleanedSource).pipe(
      Node.andThen(PrepareAppend.call({ cleanup })),
      Node.bindPlanned(preparation => CreateLanding.call({ cleanup, preparation }).pipe(
        Node.bindPlanned(landing => QueueAppend.call({ cleanup, preparation, landing })))),
      Node.bindPlanned(queued => AwaitAppend.child({ queued }).pipe(
        Node.bindPlanned(observed => VerifyLanded.call({ cleanup, cleanedSource, queued, observed })))))))
})

const atomsOf = (cleanup: VibeCleanup) => cleanup.result.changes.flatMap(change => change.implementation.atoms)
export const landingLayers = Layer.mergeAll(
  Interpreter.layer(LandVibe), Interpreter.layer(AwaitAppend),
  PrepareAppend.toLayer(({ cleanup }) => Effect.gen(function*() {
    const landing = yield* Landing
    if (cleanup.result.status !== "validated" || cleanup.result.findings.length !== 0 ||
        cleanup.head.treeId !== cleanup.admission.validatedHead.treeId || atomsOf(cleanup).at(-1)?.commitId !== cleanup.head.commitId) {
      return yield* invalid("Append requires the cleaned, revalidated native tip")
    }
    const main = yield* landing.readMain
    const preparation = yield* landing.prepare({ target_bookmark: "main", expected_commit_id: main,
      source_commit_id: cleanup.head.commitId, source_base_commit_id: cleanup.admission.originalSource.commitId })
    // Plue computes the complete suffix after the shared immutable prefix. This
    // request's validated atoms must be that suffix's ordered tail, so earlier
    // steered implementation is covered and nothing foreign is appended as ours.
    const atoms = atomsOf(cleanup), tail = preparation.changes.slice(-atoms.length)
    if (tail.length !== atoms.length || tail.some((change, index) => change.change_id !== atoms[index]!.changeId || change.commit_id !== atoms[index]!.commitId)) {
      return yield* invalid("Native append preparation does not end with this request's validated atoms")
    }
    return preparation
  })),
  CreateLanding.toLayer(({ cleanup, preparation }) => Effect.gen(function*() {
    const landing = yield* Landing, instance = yield* FlowRuntime.FlowInstance
    return yield* landing.create(requestIdFor(instance.executionId, "vibe-landing"), preparation, cleanup.summary)
  })),
  QueueAppend.toLayer(({ cleanup, preparation, landing: identity }) => Effect.flatMap(Landing, landing =>
    landing.queue(identity, preparation, { commit_id: preparation.source_commit_id, expected_commit_id: preparation.expected_commit_id,
      source_base_commit_id: preparation.source_base_commit_id, description: cleanup.summary }))),
  ObserveAppend.toLayer(({ queued }) => Effect.map(Effect.flatMap(Landing, landing => landing.observe(queued)),
    observation => ({ satisfied: observation.status === "landed" || observation.status === "failed", output: observation }))),
  VerifyLanded.toLayer(({ cleanup, cleanedSource, queued, observed }) => Effect.gen(function*() {
    if (observed.status !== "landed") {
      return yield* new CodingError({ code: observed.status === "failed" ? "invalid_receipt" : "unavailable",
        message: observed.status === "failed" ? `Existing landing policy refused append task ${queued.taskId}; inspect landing ${queued.number}`
          : `Append task ${queued.taskId} has not landed; landing ${queued.number} remains pending work, not a changed main` })
    }
    if (cleanedSource.source.commitId !== cleanup.head.commitId || observed.result.landed_count !== queued.preparation.changes.length) {
      return yield* invalid("Landed receipt does not bind this exact retained cleaned source")
    }
    return { cleanup, cleanedSource, landing: { requestId: queued.requestId, number: queued.number }, taskId: queued.taskId,
      mainCommitId: observed.result.target_commit_id, landedCount: observed.result.landed_count }
  }))
)
