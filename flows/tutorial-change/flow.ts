import { Flow } from "@smthrs/core"
import { Option, Schema } from "effect"
import * as Executable from "@smthrs/registry/Executable"
import { Plan, Result } from "../coding/schema"

/** The coding runtime persists the plan and journals recursive implementation/check calls. */
export default Flow.make({
  description: "Execute the reviewed tutorial plan through coding/RunPlan. Re-read HEAD before any writes; refuse if it differs from plan.base.commitId. Require exactly one change and one atom. Do not push. Return the exact coding result; never invent revision evidence.",
  input: Schema.Struct({ plan: Plan }), output: Result,
  capabilities: ["*"], flows: ["tutorial-change/Run"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "sealed" }
})

export const suggestion = Flow.make({
  description: "Inspect the supplied repository files and executable catalog. Suggest one small useful feature justified by actual code. Produce exactly one Change with one atomic commit, the captured HEAD, real native revision identifiers, real implementation/check flow digests, and required fast and slow checks. Use coding Plan. This is planning only: execute no implementation scripts and write no files. If the repository or executable catalog cannot support a real plan, fail honestly.",
  input: Schema.Struct({ repo: Schema.NonEmptyString, head: Schema.NonEmptyString, files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })), feature: Schema.optional(Schema.String) }),
  output: Plan, capabilities: ["fs:read:**"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})

// These gates execute inside the same durable engine as the recursive coding flow.
import { Action, Flow as EngineFlow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer } from "effect"
import { CodingError } from "../coding/schema"
import { ImplementPlan } from "../coding/workflow"
export const Preflight = Action.make("tutorial-change/preflight", {
  payload: { plan: Plan }, success: Plan, error: CodingError, nondeterministic: true
})
export const Verify = Action.make("tutorial-change/verify", {
  payload: { plan: Plan, result: Result }, success: Result, error: CodingError, nondeterministic: true
})
export const Execute = EngineFlow.make("tutorial-change/Execute", {
  payload: { plan: Plan }, success: Result, error: CodingError,
  body: ({ plan }) => Preflight.call({ plan }).pipe(Node.bindPlanned(checked =>
    ImplementPlan.call({ plan: checked }).pipe(Node.bindPlanned(result => Verify.call({ plan: checked, result })))))
})
export const Refuse = Action.make("tutorial-change/refuse", { payload: {}, success: Result, error: CodingError })
export const Run = EngineFlow.make("tutorial-change/Run", {
  payload: Executable.Invocation, success: Result, error: CodingError,
  body: ({ input }): Node.Node<typeof Result.Type, CodingError, Node.Services<ReturnType<typeof Execute.call>> | Action.Requirement<typeof Refuse.name>> => {
    const decoded = Schema.decodeUnknownOption(Schema.Struct({ plan: Plan }))(input)
    return Option.isSome(decoded) ? Execute.call(decoded.value) : Refuse.call({})
  }
})
/** The deployment supplies its scoped repository host; no browser-supplied paths. */
export const executionLayers = (host: {
  preflight(plan: typeof Plan.Type): Promise<void>
  verify(plan: typeof Plan.Type, result: typeof Result.Type): Promise<void>
}) => Layer.mergeAll(
  Preflight.toLayer(({ plan }) => Effect.tryPromise({ try: async () => { await host.preflight(plan); return plan },
    catch: cause => new CodingError({ code: "stale_revision", message: String(cause) }) })),
  Verify.toLayer(({ plan, result }) => Effect.tryPromise({ try: async () => { await host.verify(plan, result); return result },
    catch: cause => new CodingError({ code: "invalid_receipt", message: String(cause) }) })),
  Refuse.toLayer(() => Effect.fail(new CodingError({ code: "invalid_plan", message: "A reviewed change plan is required." }))),
  Interpreter.layer(Execute),
  Interpreter.layer(Run)
)
