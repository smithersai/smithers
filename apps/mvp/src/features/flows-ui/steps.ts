import { Agent, Budget, QuotaPolicy } from "@smthrs/agent"
import { digestSync, Uuid } from "@smthrs/crypto"
import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import { RealmFlow } from "@smthrs/harness"
import { Evaluator } from "@smthrs/model"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { codeOf } from "../../errorCode"
import { callFlow, publicError } from "../../flows/catalog"
import { declarationOf } from "../../flows/declarations"
import { entryOf, type FlowName } from "../../flows/registry"
import * as AgentHost from "../agent/host"
import { startRoot } from "../runs/start"
import { FlowsClient } from "./api"
import { DRAFT_ID_NAMESPACE, FLOW_MODEL_ROLE, MAX_REALM_CALLS } from "./contract"
import { PROMPT_CALLABLE } from "./callable"
import { checkSource, passes, readSource } from "./checks"
import {
  AdmitSave,
  AdmitWrite,
  CallHost,
  type CodeState,
  DraftFlow,
  type Drafted,
  EvaluateCode,
  FlowAnswer,
  FlowCode,
  FlowDelete,
  FlowDraftDelete,
  FlowDrafts,
  FlowList,
  FlowNew,
  FlowPrompt,
  FlowRead,
  FlowRun,
  FlowSave,
  FlowWrite,
  LoadFlow,
  NextRound,
  OpenRound,
  type Opened,
  PromptAgent,
  ReadCode,
  ReadDrafts,
  ReadFlows,
  RecordAnswers,
  RemoveDraft,
  RemoveFlow,
  WriteRound,
} from "./flows"
import { type DraftFailure, draftFailure } from "./failure"
import { recordCall, recordEvaluate, recordLoad, recordRound, recordSave, recordWrite } from "./metrics"
import { roundExecutionId, roundOf } from "./round"
import {
  type CodeFailure,
  DraftNotReady,
  FlowCallRefused,
  FlowCodeFailed,
  FlowImportRefused,
  FlowInvalid,
  FlowLimitExceeded,
  FlowNeedsSandbox,
  NameTaken,
} from "./reference"
import type { DraftQuestion, DraftStatus } from "./schema"
import { placementOf, renderSource, SOURCE_PATH } from "./source"

// What your own flows' steps do (decision 0014 §2, docs/features/flows.md#your-own-flows): ChatApi's flows and drafts
// routes through `FlowsClient`, the static checks over the registry's `ModuleFlow` (./checks.ts), a person's code in the
// QuickJS realm through `RealmFlow` (@smthrs/harness), and the agent through the same seat, catalog and policies
// `chat/Answer` runs on (src/features/agent/host.ts). Only an engine's host imports this module: the engine worker and
// the Node host.

/** The answered questions of a round, as the drafting agent reads them. */
const answered = (questions: ReadonlyArray<DraftQuestion>) =>
  questions.flatMap((question) => (question.answer === undefined ? [] : [{ question: question.text, answer: question.answer }]))

/** `flow/new/open`: writes the round's draft row (drafting) and reads what the agent drafts from. */
export const open = ({ name, request }: { readonly name: string; readonly request: string }) =>
  Effect.gen(function* () {
    const client = yield* FlowsClient
    const instance = yield* FlowRuntime.FlowInstance
    const openedAtMs = yield* Clock.currentTimeMillis
    const named = roundOf(instance.executionId)
    // A draft started outside a round (an agent's call, a slash command) is named by its execution, never at random.
    const draftId = named?.draftId ?? (yield* Uuid.v5(DRAFT_ID_NAMESPACE, instance.executionId).pipe(Effect.orDie))
    const round = named?.round ?? 0
    if (round === 0) {
      // A name the person already has: this draft edits that flow, from its latest revision.
      const existing = yield* client.source(name).pipe(
        Effect.map(Option.some),
        // expected: a new name has no flow to edit
        Effect.catchTag("@smthrs/mvp/flows/FlowNotFound", () => Effect.succeed(Option.none())),
      )
      const flowId = Option.match(existing, { onNone: () => null, onSome: (flow) => flow.flowId })
      yield* client.writeDraft(draftId, {
        scope: "person",
        round,
        request,
        name,
        status: "drafting",
        summary: null,
        files: [],
        checks: [],
        questions: [],
        failure: null,
        flowId,
      })
      return {
        draftId,
        round,
        name,
        request,
        flowId,
        previous: Option.match(existing, { onNone: () => null, onSome: (flow) => flow.source }),
        answers: [],
        openedAtMs,
      } satisfies Opened
    }
    const draft = yield* client.draft(draftId)
    yield* client.writeDraft(draftId, {
      scope: "person",
      round,
      request: draft.request,
      name: draft.name,
      status: "drafting",
      summary: draft.summary,
      files: draft.files,
      checks: draft.checks,
      questions: draft.questions,
      failure: null,
      flowId: draft.flowId,
    })
    return {
      draftId,
      round,
      name,
      request: draft.request,
      flowId: draft.flowId,
      previous: draft.files[0]?.text ?? null,
      answers: answered(draft.questions),
      openedAtMs,
    } satisfies Opened
  })

/**
 * What `flow/new/write` writes for a round: the round's status, file, checks, questions and why it failed. A draft whose
 * checks fail is a failed round (`checks`), with its file and checks shown; one the agent never drafted failed with
 * the agent's code (./failure.ts).
 */
export const roundOutcome = (input: {
  readonly round: number
  readonly name: string
  readonly drafted: Drafted | null
  readonly failure?: unknown
}): {
  readonly status: Exclude<DraftStatus, "drafting" | "saved" | "proposed">
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly checks: ReturnType<typeof checkSource>
  readonly questions: ReadonlyArray<DraftQuestion>
  readonly summary: string | null
  readonly failure: DraftFailure | null
} => {
  const { drafted } = input
  if (drafted === null) {
    return { status: "failed", files: [], checks: [], questions: [], summary: null, failure: draftFailure(input.failure) }
  }
  const text = renderSource({
    name: input.name,
    description: drafted.description,
    flows: drafted.flows,
    instructions: drafted.instructions,
  })
  const questions = drafted.questions.map((question, index) => ({
    id: `r${input.round}q${index + 1}`,
    text: question.text,
    assumed: question.assumed,
    blocking: question.blocking,
  }))
  const checks = checkSource(text, input.name, PROMPT_CALLABLE)
  const passed = passes(checks)
  return {
    status: !passed ? "failed" : questions.some((question) => question.blocking) ? "needs_you" : "ready",
    files: [{ path: SOURCE_PATH, text }],
    checks,
    questions,
    summary: drafted.summary === "" ? null : drafted.summary,
    failure: passed ? null : "checks",
  }
}

/** `flow/new/write`: the round's file, checks and questions on the draft's row, and the round's record. */
export const write = (input: typeof WriteRound.payloadSchema.Type) =>
  Effect.gen(function* () {
    const outcome = roundOutcome(input)
    yield* (yield* FlowsClient).writeDraft(input.draftId, {
      scope: "person",
      round: input.round,
      request: input.request,
      name: input.name,
      status: outcome.status,
      summary: outcome.summary,
      files: outcome.files,
      checks: outcome.checks,
      questions: outcome.questions,
      failure: outcome.failure,
      flowId: input.flowId,
    })
    yield* recordRound({
      draftId: input.draftId,
      round: input.round,
      outcome: outcome.status,
      failure: outcome.failure,
      checks: outcome.checks.flatMap((check) => (check.ok ? [] : [`${check.check}:${check.code}`])),
      questions: outcome.questions.length,
      durationMs: (yield* Clock.currentTimeMillis) - input.openedAtMs,
    })
    return { draftId: input.draftId, round: input.round, status: outcome.status, name: input.name }
  })

/** `flow/answer/record`: records the answers, and reads the draft's name and request back for the next round. */
export const record = (input: typeof RecordAnswers.payloadSchema.Type) =>
  Effect.gen(function* () {
    const client = yield* FlowsClient
    yield* client.answer(input.draftId, { round: input.round, answers: input.answers })
    const draft = yield* client.draft(input.draftId)
    // `flow/new` names every draft it writes.
    return { name: draft.name!, request: draft.request }
  })

/** `flow/answer/next`: starts the draft's next round, without waiting for it. */
export const next = (input: typeof NextRound.payloadSchema.Type) =>
  Effect.gen(function* () {
    const round = input.round + 1
    yield* startRoot(FlowNew, roundExecutionId(input.draftId, round), { name: input.name, request: input.request })
    return { draftId: input.draftId, round }
  })

/** `flow/save/admit`: the draft's file, checked again here, saved through ChatApi. */
export const admit = ({ draftId }: { readonly draftId: string }) =>
  Effect.gen(function* () {
    const client = yield* FlowsClient
    const draft = yield* client.draft(draftId)
    const notReady = (code: string) =>
      Effect.andThen(recordSave(draftId, code), Effect.fail(new DraftNotReady({ code })))
    const [file] = draft.files
    if (draft.status !== "ready" && draft.status !== "saved") return yield* notReady("not_ready")
    if (draft.name === null || file === undefined || file.path !== SOURCE_PATH) return yield* notReady("not_ready")
    if (draft.questions.some((question) => question.blocking && question.answer === undefined)) {
      return yield* notReady("needs_you")
    }
    // Checked again where the write is admitted (decision 0014 §2): the file the round checked, as it is now.
    if (!passes(checkSource(file.text, draft.name, PROMPT_CALLABLE))) return yield* notReady("checks")
    const saved = yield* client.save({
      draftId,
      name: draft.name,
      // The checks passed, so the registry read a description.
      description: readSource(file.text, draft.name).description!,
      source: file.text,
      digest: digestSync(file.text),
    }).pipe(
      Effect.catchTag("@smthrs/mvp/flows/FlowsRefused", (refused) =>
        Effect.gen(function* () {
          yield* recordSave(draftId, refused.code)
          return yield* refused.code === "name_taken" ? Effect.fail(new NameTaken()) : Effect.fail(refused)
        })),
    )
    yield* recordSave(draftId, "saved")
    return { flowId: saved.flowId, name: saved.name, revision: saved.revision }
  })

/**
 * `flow/run/load`: one revision's flow.ts, its digest and checks verified, pinned with the realm's version and what it
 * may call. Code that needs a machine fails `FlowNeedsSandbox` before anything runs (./source.ts).
 */
export const load = (input: typeof LoadFlow.payloadSchema.Type) =>
  Effect.gen(function* () {
    const found = yield* (yield* FlowsClient).source(input.name, input.revision, input.flowId)
    const invalid = (check: string) => Effect.andThen(recordLoad(check), Effect.fail(new FlowInvalid({ check })))
    if (digestSync(found.source) !== found.digest) return yield* invalid("digest")
    const failed = checkSource(found.source, found.name, PROMPT_CALLABLE).find((check) => !check.ok)
    if (failed !== undefined) return yield* invalid(failed.check)
    if (placementOf(found.source) === "sandbox") {
      return yield* Effect.andThen(recordLoad("sandbox"), Effect.fail(new FlowNeedsSandbox()))
    }
    yield* recordLoad("realm")
    return {
      flowId: found.flowId,
      name: found.name,
      revision: found.revision,
      digest: found.digest,
      source: found.source,
      runtime: RealmFlow.version,
      // The checks passed, so the registry read its list, and every flow on it is one a person's flow may call.
      allowed: readSource(found.source, found.name).flows!,
      input: input.input ?? "",
    }
  })

/** The failure a realm refusal fails a run with, one per thing the person fixes (./reference.ts). */
export const refusalOf = (code: RealmFlow.RealmFlowError["code"]): CodeFailure =>
  code === "limit_exceeded"
    ? new FlowLimitExceeded({ code })
    : code === "forbidden_import"
    ? new FlowImportRefused({ code })
    : code === "action_not_allowed"
    ? new FlowCallRefused({ code })
    : new FlowCodeFailed({ code })

/** A person's code's answer as the run's text: a string as it is, any other value as its JSON. */
const answerText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value))

/**
 * `flow/run/evaluate`: the pinned code in a fresh QuickJS realm over the receipts so far, as branch creation evaluates a
 * repository's (src/features/branch/creationSteps.ts). Refused under a realm other than the one the run pinned, or
 * when its bytes changed. Its run's payload is `{ input }`; it may ask for the agent and the flows its list names.
 */
export const evaluate = (state: CodeState) =>
  Effect.gen(function* () {
    const fail = (failure: CodeFailure) =>
      Effect.andThen(recordEvaluate(failure.code, state.receipts.length), Effect.fail(failure))
    if (state.runtime !== RealmFlow.version) return yield* fail(new FlowCodeFailed({ code: "version" }))
    if (digestSync(state.source) !== state.digest) return yield* fail(new FlowCodeFailed({ code: "invalid_source" }))
    const result = yield* RealmFlow.step({
      source: state.source,
      expectedTag: state.name,
      payload: { input: state.input },
      allowedActions: [RealmFlow.agentAction, ...state.allowed],
      receipts: state.receipts,
    }).pipe(Effect.catchTag("RealmFlowError", (refused) => fail(refusalOf(refused.code))))
    if (result._tag === "Complete") {
      yield* recordEvaluate("complete", state.receipts.length)
      return { _tag: "Complete" as const, value: answerText(result.value) }
    }
    if (state.receipts.length >= MAX_REALM_CALLS) return yield* fail(new FlowLimitExceeded({ code: "too_many_calls" }))
    yield* recordEvaluate(result.name === RealmFlow.agentAction ? "agent" : "call", state.receipts.length)
    return result
  }).pipe(Effect.withSpan("flow.run.evaluate"))

/**
 * `flow/run/call`: the host makes the call the code asked for. An agent step runs `flow/run/prompt` on the prompt its
 * code rendered, as the revision's agent; a flow the revision lists runs as the agent's catalog runs it
 * (src/flows/catalog.ts `callFlow`). Either is a child execution named by this round and the call's key, so a call tried
 * again, or resumed after a crash, joins the one it started instead of asking the model again. A flow's failure is its
 * receipt, by its kind only; an agent that couldn't finish fails the run.
 */
export const call = ({ pin, call }: typeof CallHost.payloadSchema.Type) =>
  Effect.gen(function* () {
    const instance = yield* FlowRuntime.FlowInstance
    const runtime = yield* FlowRuntime.FlowRuntime
    const child = `${instance.executionId}/${call.name === RealmFlow.agentAction ? "agent" : "call"}/${digestSync(call.key).slice(0, 32)}`
    const refuse = (kind: "agent" | "flow", code: FlowCallRefused["code"]) =>
      Effect.andThen(recordCall(kind, code), Effect.fail(new FlowCallRefused({ code })))
    if (call.name === RealmFlow.agentAction) {
      const asked = Schema.decodeUnknownOption(RealmFlow.AgentPayload)(call.payload)
      if (Option.isNone(asked)) return yield* refuse("agent", "payload")
      if (asked.value.seat !== FLOW_MODEL_ROLE) return yield* refuse("agent", "seat")
      const { flowId, name, revision, digest, allowed } = pin
      const answer = yield* runtime.execute(FlowPrompt, {
        executionId: child,
        payload: { flowId, name, revision, digest, prompt: asked.value.prompt, allowed },
      }).pipe(
        Effect.catchTag("@smthrs/flow/FlowCycleDetected", Effect.die),
        Effect.tapError(() => recordCall("agent", "failed")),
      )
      yield* recordCall("agent", "ok")
      return { ...call, outcome: { _tag: "Success" as const, value: answer } }
    }
    // The realm resolved only what the pin lists; checked again where the call is made.
    if (!pin.allowed.includes(call.name) || !PROMPT_CALLABLE.includes(call.name as FlowName)) {
      return yield* refuse("flow", "action_not_allowed")
    }
    const name = call.name as FlowName
    const flow = declarationOf(name)
    // A registered flow's schemas need no service.
    const codec = (schema: Schema.Top) => Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>
    const input = Schema.decodeUnknownOption(codec(flow.payloadSchema))(call.payload)
    if (Option.isNone(input)) return yield* refuse("flow", "payload")
    const inspection = yield* EngineStore.RunInspection.RunInspection
    const outcome = yield* callFlow({ entryOf }, runtime, inspection)(name, input.value, child).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed({ _tag: "Failure" as const, error: publicError(error) }),
        onSuccess: (value) =>
          Schema.encodeUnknownEffect(codec(flow.successSchema))(value).pipe(
            Effect.orDie,
            Effect.map((encoded) => ({ _tag: "Success" as const, value: encoded })),
          ),
      }),
    )
    yield* recordCall("flow", outcome._tag === "Success" ? "ok" : "failed")
    return { ...call, outcome }
  }).pipe(Effect.withSpan("flow.run.call"))

/** `flow/read/source`: one revision's code, and where it runs. */
export const read = (input: typeof ReadCode.payloadSchema.Type) =>
  Effect.gen(function* () {
    const found = yield* (yield* FlowsClient).source(input.name, input.revision)
    return {
      flowId: found.flowId,
      name: found.name,
      revision: found.revision,
      source: found.source,
      placement: placementOf(found.source),
    }
  })

/** How a refused write is recorded: ChatApi's code, `not_found`, or `unavailable`. */
export const writeOutcome = (error: { readonly _tag: string; readonly code?: string }): string =>
  error.code ?? (error._tag === "@smthrs/mvp/flows/FlowNotFound" ? "not_found" : "unavailable")

/** `flow/write/admit`: the code, checked here as every revision is, saved through ChatApi as the next revision. */
export const writeCode = (input: typeof AdmitWrite.payloadSchema.Type) =>
  Effect.gen(function* () {
    const placement = placementOf(input.source)
    const failed = checkSource(input.source, input.name, PROMPT_CALLABLE).find((check) => !check.ok)
    if (failed !== undefined) {
      return yield* Effect.andThen(recordWrite(`check:${failed.check}`, placement), Effect.fail(new FlowInvalid({ check: failed.check })))
    }
    const written = yield* (yield* FlowsClient).write({
      name: input.name,
      revision: input.revision,
      // The checks passed, so the registry read a description.
      description: readSource(input.source, input.name).description!,
      source: input.source,
      digest: digestSync(input.source),
    }).pipe(Effect.tapError((error) => recordWrite(writeOutcome(error), placement)))
    yield* recordWrite("written", placement)
    return { flowId: written.flowId, name: written.name, revision: written.revision, placement }
  })

/** `flow/delete/remove`: deletes it; `deleted` is false when it was gone already. */
export const remove = ({ flowId }: { readonly flowId: string }) =>
  Effect.flatMap(FlowsClient, (client) => client.remove(flowId)).pipe(Effect.map((deleted) => ({ deleted })))

/**
 * `flow/draft/delete/remove`: stops the draft's round if this engine runs it (a round elsewhere is refused when it
 * writes), then deletes the draft; `deleted` is false when it was gone already or isn't the person's.
 */
export const removeDraft = ({ draftId }: { readonly draftId: string }) =>
  Effect.gen(function* () {
    const client = yield* FlowsClient
    // Gone, or not the person's: nothing to delete. Any other refusal (signed out, say) fails the step.
    const draft = yield* client.draft(draftId).pipe(
      Effect.map(Option.some),
      // expected: a draft gone or not the person's deletes nothing
      Effect.catchTag("@smthrs/mvp/flows/FlowsRefused", (refused) =>
        refused.status === 404 || refused.status === 403 ? Effect.succeed(Option.none()) : Effect.fail(refused)),
    )
    if (Option.isNone(draft)) return { deleted: false }
    // An id this engine doesn't hold is ignored; a stop the store couldn't record leaves a round whose write is refused,
    // and is logged by its code.
    yield* (yield* FlowRuntime.FlowRuntime).interrupt(FlowNew, roundExecutionId(draftId, draft.value.round)).pipe(
      Effect.catch((failure) =>
        Effect.logWarning("flow.draft.interrupt").pipe(
          Effect.annotateLogs({ feature: "flows", outcome: "failed", errorCode: codeOf(failure) }),
        )
      ),
    )
    return { deleted: yield* client.deleteDraft(draftId) }
  })

/** `flow/drafts/read`: the person's drafts not saved yet, each named by the id its delete or save takes. */
export const drafts = () =>
  Effect.flatMap(FlowsClient, (client) => client.drafts).pipe(
    Effect.map(({ drafts }) => ({
      drafts: drafts.map(({ id, name, request, status }) => ({ draftId: id, name, request, status })),
    })),
  )

/** `flow/list/read`: the person's flows. */
export const list = () =>
  Effect.flatMap(FlowsClient, (client) => client.list).pipe(
    Effect.map(({ flows }) => ({
      flows: flows.map(({ name, description, revision, placement }) => ({ name, description, revision, placement })),
    })),
  )

/**
 * Every `flow/*` flow registered with its steps. The agent's steps need the agent's runtime (`agentRuntime`), and
 * every step that calls ChatApi needs `FlowsClient`.
 */
export const registration = Layer.mergeAll(
  Interpreter.layerWithImplementations(
    FlowNew,
    Layer.mergeAll(OpenRound.toLayer(open), DraftFlow.layer, WriteRound.toLayer(write)),
  ),
  Interpreter.layerWithImplementations(
    FlowAnswer,
    Layer.mergeAll(RecordAnswers.toLayer(record), NextRound.toLayer(next)),
  ),
  Interpreter.layerWithImplementations(FlowSave, AdmitSave.toLayer(admit)),
  Interpreter.layerWithImplementations(FlowRun, LoadFlow.toLayer(load)),
  Interpreter.layerWithImplementations(
    FlowCode,
    Layer.mergeAll(EvaluateCode.toLayer(evaluate).pipe(Layer.provide(RealmFlow.layerDefaultVariant)), CallHost.toLayer(call)),
  ),
  Interpreter.layerWithImplementations(FlowPrompt, PromptAgent.layer),
  Interpreter.layerWithImplementations(FlowRead, ReadCode.toLayer(read)),
  Interpreter.layerWithImplementations(FlowWrite, AdmitWrite.toLayer(writeCode)),
  Interpreter.layerWithImplementations(FlowDelete, RemoveFlow.toLayer(remove)),
  Interpreter.layerWithImplementations(FlowDraftDelete, RemoveDraft.toLayer(removeDraft)),
  Interpreter.layerWithImplementations(FlowList, ReadFlows.toLayer(list)),
  Interpreter.layerWithImplementations(FlowDrafts, ReadDrafts.toLayer(drafts)),
)

/**
 * The agent's runtime for the drafting and running agents: the model endpoint's `agent` seat on `origin`, the app's
 * catalog (scoped per run, src/flows/catalog.ts) and `chat/Answer`'s policies. Their events go to no sink: a person's
 * flow shows on its run page, not as an answer's parts.
 */
export const agentRuntime = (origin: string) =>
  Layer.mergeAll(AgentHost.agentHost, AgentHost.seats(origin), Agent.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
    Layer.provideMerge(Layer.mergeAll(Agent.layerDefaults, Evaluator.layerUnavailable())),
  )

/** Your own flows on a host: the registration, with ChatApi on `origin` and the agent's runtime. */
export const layer = (origin: string) =>
  registration.pipe(
    Layer.provide(agentRuntime(origin)),
    Layer.provide(FlowsClient.layer({ origin })),
  )
