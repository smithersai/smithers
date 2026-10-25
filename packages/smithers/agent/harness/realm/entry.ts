import { canonicalize } from "@smthrs/canonical"
import { digestSync } from "@smthrs/crypto"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Crypto, Effect, Exit, Latch, Option, Schema, Scope } from "effect"

// This entry is bundled, never imported in the host. The SDK keeps its own
// deterministic intrinsics; repository code receives only public authoring APIs.
declare const __publish: (modules: unknown, run: (flow: unknown, input: any) => unknown) => void
// Records a closed refusal code. The realm refuses the evaluation with the
// first one recorded, even when repository code catches what it threw.
declare const __refuse: (code: "forbidden_import" | "action_not_allowed") => void
const unavailable = () => {
  throw new Error("unsupported_runtime_operation")
}
const crypto = Crypto.make({
  randomBytes: unavailable,
  digest: (algorithm, bytes) =>
    algorithm === "SHA-256"
      ? Effect.sync(() => Uint8Array.from(digestSync(bytes).match(/../g)!, (h) => parseInt(h, 16)))
      : Effect.die("unsupported_digest")
})

/** The host action every agent step is requested as. RealmFlow.agentAction names it too. */
const AGENT_ACTION = "@smthrs/agent/AgentAction"
/** What an agent step may declare: everything else is the host's policy. */
const AGENT_OPTIONS = ["payload", "output", "seat", "prompt"]

const declarations = new Map<string, any>()
const actions = {
  ...Action,
  make: (...args: any[]) => {
    const declaration = (Action.make as any)(...args)
    if (declarations.has(declaration.name)) throw new Error("duplicate_action")
    declarations.set(declaration.name, declaration)
    return declaration
  }
}
// An agent step is an ordinary declared action whose prompt is rendered here,
// from its decoded payload, and whose model call is the host's. The host runs
// the agent and journals its answer as the step's receipt.
const agentSteps = new Map<string, { readonly seat: string; readonly prompt: (payload: unknown) => unknown }>()
const AgentAction = {
  make: (tag: unknown, options: any) => {
    if (
      typeof options !== "object" || options === null || Object.keys(options).some((key) => !AGENT_OPTIONS.includes(key)) ||
      typeof options.seat !== "string" || options.seat.trim() === "" || typeof options.prompt !== "function"
    ) throw new Error("invalid_agent_step")
    const declaration = actions.make(tag, { payload: options.payload, success: options.output, error: Schema.Never })
    agentSteps.set(declaration.name, { seat: options.seat, prompt: options.prompt })
    return declaration
  }
}
__publish({
  "@smthrs/flow": { Flow, Action: actions },
  "@smthrs/plan": { Node },
  "@smthrs/agent": { AgentAction },
  "effect": { Schema },
  "effect/Schema": Schema
}, (declaration: any, input: any) => {
  if (!Flow.isFlow(declaration) || declaration._tag !== input.expectedTag) throw new Error("invalid_flow")
  const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(declaration.payloadSchema))(input.payload)
  const receipts = new Map(input.receipts.map((r: any) => [r.key, r]))
  if (receipts.size !== input.receipts.length) throw new Error("duplicate_receipt")
  const visited = new Set<string>()
  let request: unknown
  /** What crosses for one dispatch: the step's own action, or the host's agent action with the rendered prompt. */
  const crossing = (name: string, declaration: any, payload: unknown) => {
    const step = agentSteps.get(name)
    if (step === undefined) {
      return { name, payload: Schema.encodeSync(Schema.toCodecJson(declaration.payloadSchema))(payload) }
    }
    const prompt = step.prompt(payload)
    if (typeof prompt !== "string") throw new Error("invalid_prompt")
    return { name: AGENT_ACTION, payload: { step: name, seat: step.seat, prompt } }
  }
  const table = Action.Implementations.of({
    add: unavailable,
    get: (name) => {
      if (!input.allowedActions.includes(agentSteps.has(name) ? AGENT_ACTION : name)) {
        __refuse("action_not_allowed")
        return Effect.succeed(Option.none())
      }
      return Effect.succeed(Option.some({
        name,
        implementationVersion: declarations.get(name)?.implementationVersion,
        action: (payload) =>
          Effect.gen(function*() {
            const key = yield* Action.DispatchSite
            const declaration = declarations.get(name)
            if (declaration === undefined) return yield* Effect.die("undeclared_action")
            const crossed = crossing(name, declaration, payload)
            const receipt: any = receipts.get(key)
            if (receipt !== undefined) {
              visited.add(key)
              if (receipt.name !== crossed.name || canonicalize(receipt.payload) !== canonicalize(crossed.payload)) {
                return yield* Effect.die("receipt_changed")
              }
              if (receipt.outcome._tag === "Success") {
                return Schema.decodeUnknownSync(Schema.toCodecJson(declaration.successSchema))(
                  receipt.outcome.value
                )
              }
              return yield* Effect.fail(
                Schema.decodeUnknownSync(Schema.toCodecJson(declaration.errorSchema))(receipt.outcome.error)
              )
            }
            request ??= { _tag: "Action", key, name: crossed.name, payload: crossed.payload }
            return yield* Effect.fail("action_requested")
          })
      }))
    }
  })
  let recordBytes = 0
  const runtime = FlowRuntime.FlowRuntime.of(
    new Proxy({}, {
      get: (_, key) => {
        if (key === "recordNode") {
          return (record: unknown) =>
            Effect.sync(() => {
              recordBytes += new TextEncoder().encode(JSON.stringify(record)).byteLength
              if (recordBytes > 262144) throw new Error("plan_limit")
            })
        }
        if (key === "nodeRecordBytes") return undefined
        return unavailable
      }
    }) as any
  )
  const instance = FlowRuntime.FlowInstance.of({
    executionId: "realm",
    lineageId: "realm",
    flow: declaration,
    scope: Scope.makeUnsafe(),
    suspended: false,
    interrupted: false,
    waiting: undefined,
    handoff: undefined,
    cause: undefined,
    actionState: {
      count: 0,
      latch: Latch.makeUnsafe(),
      nextOrdinal: unavailable,
      snapshots: new Map(),
      keylessInFlight: new Set()
    }
  })
  // Process-local callback identity is reproducible here: the realm is fresh,
  // its nonce is fixed, and nothing in it reads a clock or randomness, so the
  // same pinned source, payload and receipts identify every callback the same
  // way in every evaluation. Receipts still bind each key to its action name and
  // canonical payload, so any drift refuses instead of replaying.
  const exit = Effect.runSyncExit(
    Interpreter.interpret(declaration, decoded, { callbackIdentity: "process-local" }).pipe(
      Effect.provideService(Action.Implementations, table),
      Effect.provideService(FlowRuntime.FlowRuntime, runtime),
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provideService(Crypto.Crypto, crypto)
    )
  )
  for (const key of receipts.keys()) if (!visited.has(key as string)) throw new Error("unused_receipt")
  if (request !== undefined) return request
  if (Exit.isFailure(exit)) throw new Error("interpretation_failed")
  const encoded = Schema.encodeSync(Schema.toCodecJson(declaration.successSchema))(exit.value.value)
  return { _tag: "Complete", value: encoded ?? null }
})
