/** One repository flow, registered once on the schedule a person approved. */
import * as Digest from "@smthrs/core/Digest"
import * as Executable from "@smthrs/registry/Executable"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { deploymentMinutes, deploymentTokens, StartBudget } from "./inspection.ts"
import { RepositoryRemote } from "./remote.ts"
import { TriggerRegistration, TriggerRequest, TriggerResult, triggerCandidate } from "./schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : Array.isArray(record(value).items) ? record(value).items as unknown[] : []
const requireRemote = Effect.gen(function*() {
  const remote = yield* Effect.serviceOption(RepositoryRemote)
  return Option.isSome(remote) ? remote.value : yield* invalid("Connect the repository host before registering a schedule")
})
/** The five reviewed responsibilities and this registrar are the host's own. */
const reservedFlow = (name: string) => name === "repository/setup" || name === "repository/trigger" ||
  /^repository-jobs\/(issues|review|ci|feature|chores)$/.test(name) || name === "coding" || name.startsWith("coding/")

export const Dispatched = Schema.Struct({ requestId: Schema.String, slug: Schema.String, flow: Schema.String,
  dispatchId: Schema.String, registrationId: Schema.String, revision: Schema.Int, digest: Schema.String,
  status: Schema.String, runId: Schema.optionalKey(Schema.String) })
export const TriggerOutcome = Schema.Union([TriggerResult, Dispatched])
const Planned = Schema.Struct({ planId: Schema.String, planDigest: Schema.String, executionDigest: Schema.String,
  envelope: Schema.Json, sourceRevision: Schema.String, revision: Schema.Int, candidate: Schema.String,
  testRunId: Schema.optionalKey(Schema.String) })

const Prepare = Action.make("repository/prepare-trigger", {
  payload: { request: TriggerRequest, deadlineAt: Schema.Number }, success: Planned, error: CodingError, nondeterministic: true
})
const PrepareTrigger = Flow.make("repository/PrepareTrigger", { payload: Prepare.payloadSchema, success: Planned, error: CodingError, body: value => Prepare.call(value) })
const Activate = Action.make("repository/activate-trigger", {
  payload: { request: TriggerRequest, plan: Planned, deadlineAt: Schema.Number }, success: TriggerResult, error: CodingError, nondeterministic: true
})
const ActivateTrigger = Flow.make("repository/ActivateTrigger", { payload: Activate.payloadSchema, success: TriggerResult, error: CodingError, body: value => Activate.call(value) })
const Fire = Action.make("repository/fire-trigger", {
  payload: { request: TriggerRequest, deadlineAt: Schema.Number }, success: Dispatched, error: CodingError, nondeterministic: true
})
const FireTrigger = Flow.make("repository/FireTrigger", { payload: Fire.payloadSchema, success: Dispatched, error: CodingError, body: value => Fire.call(value) })

export const ExecuteTrigger = Action.make("repository/execute-trigger", {
  payload: { request: TriggerRequest, deadlineAt: Schema.Number }, success: TriggerOutcome, error: CodingError, nondeterministic: true
})
export const Trigger = Flow.make("repository/Trigger", {
  payload: TriggerRequest, success: TriggerOutcome, error: CodingError,
  body: request => StartBudget.call({ minutes: deploymentMinutes }).pipe(Node.bindPlanned(deadlineAt => ExecuteTrigger.call({ request, deadlineAt })))
})
const RefuseTrigger = Action.make("repository/refuse-trigger", { payload: {}, success: TriggerOutcome, error: CodingError })
export const RunTrigger = Flow.make("repository/RunTrigger", { payload: Executable.Invocation, success: TriggerOutcome, error: CodingError,
  body: invocation => {
    const decoded = Schema.decodeUnknownOption(TriggerRequest)(invocation.input)
    return Option.isSome(decoded) ? Trigger.child(decoded.value) : RefuseTrigger.call({})
  }
})

const moduleRefusal = (flow: string, file: string) =>
  invalid(`Scheduled triggers run single-file markdown flows. "${flow}" is a module entry (${file}).`)

/** The form gate of the supported-flow contract, decided before any plan is
 * made. Every refusal names the flow and what about it cannot be scheduled.
 * Catalog membership, not a `model:` line, is what decides whether this host
 * can run an entry: a markdown flow reaches its model through the delegate it
 * names, and one that names none is already a catalog refusal. */
export const admittedEntry = (flow: string, catalog: Executable.Catalog) => Effect.gen(function*() {
  if (reservedFlow(flow)) return yield* invalid(`"${flow}" is a reserved repository job; register it through repository setup.`)
  const entry = catalog.executables.find(candidate => candidate.descriptor.name === flow)
  if (!entry) {
    const refusal = catalog.refused.find(candidate => candidate.flow === flow)
    const file = refusal?.path?.split("/").at(-1)
    if (file !== undefined && /\.[cm]?[jt]sx?$/.test(file)) return yield* moduleRefusal(flow, file)
    if (refusal) return yield* invalid(`"${flow}" is not runnable on this workspace: ${refusal.message}`)
    const names = catalog.executables.map(candidate => candidate.descriptor.name).filter(name => !reservedFlow(name)).sort()
    return yield* invalid(`No flow "${flow}" is registered on this workspace. The workspace has: ${names.join(", ") || "no repository flows"}.`)
  }
  const descriptor = entry.descriptor
  if (descriptor.body._tag !== "Markdown") {
    return yield* moduleRefusal(flow, descriptor.body.path.split("/").at(-1) ?? descriptor.body.path)
  }
  if (Object.hasOwn(descriptor.frontmatter, "input") || Object.hasOwn(descriptor.frontmatter, "schema")) {
    return yield* invalid(`"${flow}" declares an input schema the engine ignores (discovery warning unsupported_input_schema). Remove it: a trigger delivers your registered input to the flow as JSON, unvalidated.`)
  }
  if (descriptor.body.contentDigest === undefined) return yield* invalid(`"${flow}" has unmeasured source bytes and has no executable identity.`)
  return entry
})

/** The current row for this slug, so a re-apply raises the revision the upsert
 * admits instead of colliding with the row a person already approved. */
const currentRegistration = (slug: string) => Effect.gen(function*() {
  const remote = yield* requireRemote
  const existing = rows(yield* remote.registrations).map(record).find(row => row.job === `flow:${slug}`)
  return { revision: typeof existing?.revision === "number" ? existing.revision : 0,
    digest: typeof existing?.digest === "string" ? existing.digest : "" }
})

export const triggerLayers = Layer.mergeAll(
  Interpreter.layer(Trigger), Interpreter.layer(RunTrigger), Interpreter.layer(PrepareTrigger),
  Interpreter.layer(ActivateTrigger), Interpreter.layer(FireTrigger),
  RefuseTrigger.toLayer(() => Effect.fail(invalid("A schedule registration names one repository flow, one slug, one UTC cron schedule and the plan a person approved"))),
  Prepare.toLayer(({ request, deadlineAt }) => Effect.gen(function*() {
    if (Date.now() >= deadlineAt) return yield* invalid("The registration reached its configured time limit")
    const remote = yield* requireRemote
    if (remote.repo !== request.repo || (request.workspaceId !== undefined && request.workspaceId !== remote.workspaceId)) {
      return yield* invalid("The schedule belongs to another workspace")
    }
    if (request.schedule.trim().split(/\s+/).filter(field => field !== "").length !== 5) return yield* invalid("schedule must have five cron fields in UTC")
    const approvedPlanId = request.approvedPlanId ?? "", approvedPlanDigest = request.approvedPlanDigest ?? ""
    if (!approvedPlanId || !/^[a-f0-9]{64}$/.test(approvedPlanDigest)) return yield* invalid("a flow trigger must name the plan a person approved")
    const catalog = yield* Effect.serviceOption(Executable.Catalog)
    if (Option.isNone(catalog)) return yield* invalid("This workspace has no flow catalog to register from")
    yield* admittedEntry(request.flow, catalog.value)
    yield* (yield* Jj.Jj).snapshot("repository trigger registration")
    const source = (yield* (yield* NativeCoding).read()).head
    if (source.kind !== "resolved") return yield* invalid("Resolve native source conflicts before registering a schedule")
    const control = yield* ControlRuntime
    // The same idempotency key the app planned under, so this is the stored
    // card a person already approved and not a second, unapproved plan.
    const planned = yield* control.plan({ flowId: request.flow, input: request.input, idempotencyKey: `trigger:${request.repo}:${request.slug}:plan` }).pipe(
      Effect.mapError(() => invalid(`"${request.flow}" could not be planned on this workspace`)))
    const card = planned.card
    if (!card.executionDigest || card.flowId !== request.flow ||
        !card.envelope.budget || card.envelope.budget.milliseconds === undefined || card.envelope.budget.tokens === undefined ||
        card.envelope.budget.milliseconds > deploymentMinutes * 60_000 || card.envelope.budget.tokens > deploymentTokens) {
      return yield* invalid("The job declaration has no bounded reviewed execution policy")
    }
    if (card.planId !== approvedPlanId || card.digest !== approvedPlanDigest) {
      return yield* invalid(`The approved plan no longer reproduces for "${request.flow}"; review the preview and approve it again.`)
    }
    // Step 3 of the approval sequence, re-verified here: this host asks its own
    // journal whether a person decided this exact plan. The registrar never
    // decides one, and a pending or denied plan registers nothing.
    const stored = yield* control.getPlan(card.planId).pipe(Effect.mapError(() => invalid("The approved plan is no longer stored on this workspace")))
    if (stored.decision !== "approved") return yield* invalid(`The plan for "${request.flow}" is ${stored.decision}; a person approves the preview before it can be scheduled.`)
    const testRunId = request.testRunId
    if (testRunId !== undefined) {
      const run = yield* control.getRun(testRunId).pipe(Effect.mapError(() => invalid("The named test run is not a run of this workspace")))
      if (run.planId !== card.planId || run.planDigest !== card.digest || run.status !== "completed") {
        return yield* invalid("The named test run is not a completed run of the plan you approved")
      }
    }
    const current = yield* currentRegistration(request.slug)
    return { planId: card.planId, planDigest: card.digest, executionDigest: card.executionDigest, envelope: json(card.envelope),
      sourceRevision: source.commitId, revision: current.revision + 1, candidate: triggerCandidate(request),
      ...(testRunId === undefined ? {} : { testRunId }) }
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The schedule could not be prepared")))),
  Activate.toLayer(({ request, plan, deadlineAt }) => Effect.gen(function*() {
    if (Date.now() >= deadlineAt) return yield* invalid("The registration reached its configured time limit")
    const remote = yield* requireRemote
    const body = { repo: request.repo, workspace_id: remote.workspaceId, flow_id: request.flow, revision: plan.revision,
      digest: plan.candidate, source_revision: plan.sourceRevision, execution_digest: plan.executionDigest,
      envelope: plan.envelope, mode: "enabled", events: [], schedule: request.schedule, input: request.input,
      approved_plan_id: request.approvedPlanId, approved_plan_digest: request.approvedPlanDigest }
    const registration = yield* remote.register(`flow:${request.slug}`, json(body)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TriggerRegistration)),
      Effect.mapError(error => error instanceof CodingError ? error : invalid("The schedule registration returned an invalid receipt")))
    if (registration.revision !== plan.revision || registration.digest !== plan.candidate || registration.source_revision !== plan.sourceRevision ||
        registration.schedule !== request.schedule || !registration.enabled) {
      return yield* invalid("Registration did not retain the exact candidate and source")
    }
    return { requestId: request.requestId ?? plan.candidate, slug: request.slug, flow: request.flow, planId: plan.planId,
      planDigest: plan.planDigest, executionDigest: plan.executionDigest, envelope: plan.envelope,
      sourceRevision: plan.sourceRevision, ...(plan.testRunId === undefined ? {} : { testRunId: plan.testRunId }), registration }
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The exact schedule could not be registered")))),
  Fire.toLayer(({ request, deadlineAt }) => Effect.gen(function*() {
    const remote = yield* requireRemote
    if (!remote.manual || Date.now() >= deadlineAt) return yield* invalid("The manual request is unavailable or expired")
    if (remote.repo !== request.repo || (request.workspaceId !== undefined && request.workspaceId !== remote.workspaceId)) {
      return yield* invalid("The schedule belongs to another workspace")
    }
    const current = yield* currentRegistration(request.slug)
    if (current.revision < 1 || !current.digest) return yield* invalid(`No schedule "${request.slug}" is registered on this repository.`)
    const requestId = request.requestId ?? Digest.digest(Digest.canonical(["repository/trigger/fire", request.repo, request.slug, current.revision]))
    const response = yield* remote.manual(`flow:${request.slug}`, requestId, json({ repo: request.repo, workspace_id: remote.workspaceId,
      revision: current.revision, digest: current.digest, step_id: "fire", prompt: `Run ${request.slug} now.` }))
    const row = record(response)
    if (typeof row.registration_id !== "string" || !String(row.dispatch_id) || row.revision !== current.revision || row.digest !== current.digest) {
      return yield* invalid("The manual dispatch did not retain the exact registered schedule")
    }
    return { requestId, slug: request.slug, flow: request.flow, dispatchId: String(row.dispatch_id), registrationId: row.registration_id,
      revision: current.revision, digest: current.digest, status: typeof row.status === "string" ? row.status : "submitted",
      ...(typeof row.run_id === "string" && row.run_id ? { runId: row.run_id } : {}) }
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The schedule could not be fired")))),
  ExecuteTrigger.toLayer(({ request, deadlineAt }) => Effect.gen(function*() {
    const owning = yield* Effect.serviceOption(ModuleOwner)
    if (Option.isNone(owning) || owning.value.flowId !== "repository/trigger") return yield* invalid("A schedule registration needs its approved Control entry")
    const runtime = yield* FlowRuntime.FlowRuntime, instance = yield* FlowRuntime.FlowInstance
    const key = (part: string) => Digest.digest(Digest.canonical(["repository/trigger/v1", instance.executionId, request.slug, part]))
    if (request.operation === "fire") return yield* runtime.execute(FireTrigger, { executionId: key("fire"), payload: { request, deadlineAt } })
    const plan = yield* runtime.execute(PrepareTrigger, { executionId: key("prepare"), payload: { request, deadlineAt } })
    return yield* runtime.execute(ActivateTrigger, { executionId: key("activate"), payload: { request, plan, deadlineAt } })
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : new CodingError({ code: "execution", message: "The schedule registration did not complete; inspect the retained run" }))))
).pipe(Layer.provideMerge(RunCatalogRead.layer))
