// The agent's catalog, scoped to the run that asks (src/flows/catalog.ts, decision 0014 §2): reads only while a draft
// is written, a person's flow's own list while one runs, and the whole catalog otherwise. The scope of a run's own
// agent is proved end to end in src/features/flows-ui/flows.test.ts; these are the rules and the failure of the read.
import { Action, Flow, FlowRuntime, HumanTask, Interpreter } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import { Cell } from "@smthrs/harness"
import { Node } from "@smthrs/plan"
import { Context, Deferred, Effect, Fiber, Layer, Logger, References, Schedule, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../../worker/ExecutionHost.vibe"
import { build } from "../../worker/test/flowHost.ts"
import { FlowDelete, RemoveFlow } from "../features/flows-ui/flows"
import { Ask, AskAnswer, AskRequest, tokenOf } from "../features/status/flows"
import { FlowPromptReference } from "../features/flows-ui/reference"
import { PROMPT_CATALOG } from "../features/flows-ui/callable"
import { AUTHOR_TOOLS } from "../features/flows-ui/contract"
import { agentFlows, callFlow, catalogDescription, NotApproved, publicError, scopeFor, scopeOf, source } from "./catalog.vibe"
import { entryOf, FlowRegistry } from "./registry"

test("approval-bearing catalog entries tell the agent the call asks the person itself", () => {
  expect(catalogDescription("flow/save")).toContain("Do not call app/agent/ask separately")
  expect(catalogDescription("flow/save")).toContain("Save this draft as your flow?")
  expect(catalogDescription("repo/tree")).not.toContain("Approval:")
})

describe("publicError", () => {
  test("the agent reads a failure's kind and numeric command limit, without its message", () => {
    expect(publicError({ _tag: "@smthrs/mvp/sandbox/SandboxCommandTooLong", maxSeconds: 1800, message: "private" }))
      .toBe("SandboxCommandTooLong: at most 1800 seconds")
    expect(publicError({ _tag: "OtherLimit", maxSeconds: 60 })).toBe("OtherLimit: at most 60 seconds")
  })

  test.each([undefined, null, "1800", { seconds: 1800 }])("a failure without a numeric limit (%s) stays its kind", (maxSeconds) => {
    expect(publicError({ _tag: "@smthrs/mvp/sandbox/SandboxCallRefused", maxSeconds, message: "private" }))
      .toBe("SandboxCallRefused")
  })

  test.each([null, undefined, "private", 1800, {}, { maxSeconds: 1800 }])("an untagged failure (%s) stays failed", (failure) => {
    expect(publicError(failure)).toBe("failed")
  })

  test("a tagged failure without a limit stays its kind", () => {
    expect(publicError({ _tag: "@smthrs/mvp/sandbox/SandboxCallFailed", message: "private" })).toBe("SandboxCallFailed")
  })
})

describe("scopeOf", () => {
  test("a draft's agent reads; a person's flow's agent calls what it lists that a person's flow may call", () => {
    expect(scopeOf("flow/new", undefined)).toEqual(AUTHOR_TOOLS)
    expect(scopeOf("flow/run/prompt", ["app/theme/set", "flow/new", "run/cancel", "nothing/here"])).toEqual([
      "app/theme/set",
    ])
    expect(scopeOf("flow/run/prompt", undefined)).toEqual([])
    expect(scopeOf("chat/Answer", undefined)).toBe("all")
  })
})

describe("scopeFor", () => {
  const read = (payload: unknown) => () => Effect.succeed(payload)

  test("reads a person's flow's list from its pinned payload", async () => {
    expect(await Effect.runPromise(scopeFor("flow/run/prompt", "run-1", read({ allowed: ["app/theme/set"] }))))
      .toEqual(["app/theme/set"])
    expect(await Effect.runPromise(scopeFor("chat/Answer", "run-1", () => Effect.die("never read")))).toBe("all")
  })

  test("a payload without a list, or one that can't be read, leaves the agent nothing to call", async () => {
    expect(await Effect.runPromise(scopeFor("flow/run/prompt", "run-1", read({ name: "x" })))).toEqual([])
    const lines: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }> = []
    const logger = Logger.make(({ message, logLevel, fiber }) =>
      void lines.push({ message: (message as ReadonlyArray<unknown>)[0], level: logLevel, annotations: fiber.getRef(References.CurrentLogAnnotations) }))
    const store = Object.assign(new Error("private store detail"), { _tag: "RunStoreError" })
    expect(await Effect.runPromise(scopeFor("flow/run/prompt", "run-1", () => Effect.fail(store)).pipe(Effect.provide(Logger.layer([logger])))))
      .toEqual([])
    // The read that failed is logged once at Warn by its code, never its message.
    expect(lines).toEqual([
      { message: "flow.scope.read", level: "Warn", annotations: { feature: "flows", outcome: "unreadable", errorCode: "RunStoreError" } },
    ])
    expect(JSON.stringify(lines)).not.toContain("private store detail")
  })
})

describe("what a person's flow may call", () => {
  test("every one carries the description the drafting agent reads, and none is an authoring or run act", () => {
    expect(PROMPT_CATALOG.length).toBeGreaterThan(0)
    for (const entry of PROMPT_CATALOG) {
      expect([entry.name, entry.description.length > 0]).toEqual([entry.name, true])
      expect(entry.name).not.toMatch(/^(flow|run)\//)
    }
  })
})

const Call = Action.make("test/catalog/call", {
  payload: { scoped: Schema.Boolean }, success: Schema.Null, tier: "sealed",
})
const Caller = Flow.make("test/CatalogCaller", {
  payload: {}, success: Schema.Null,
  body: Node.capture({ call: Call.name }, () => Call.call({ scoped: false })),
})
const ScopedCaller = Flow.make(FlowPromptReference._tag, {
  payload: { allowed: Schema.Array(Schema.String) }, success: Schema.Null,
  body: Node.capture({ call: Call.name }, () => Call.call({ scoped: true })),
})

test.each([true, false])("the catalog respects approval %s across child calls", (approved) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const flowId = crypto.randomUUID()
    const saved = new Set<string>([flowId])
    const reader = yield* Deferred.make<EngineStore.RunInspection.RunInspection["Service"]>()

    const ask = Interpreter.layerWithImplementations(Ask, Layer.mergeAll(
      AskRequest.toLayer(({ kind, prompt }) => Effect.succeed({
        kind: kind === "approval" ? "json" : "ask",
        prompt,
        timeoutMs: 15_000,
        maxAttempts: 1,
      })),
      AskAnswer.toLayer(({ value }) => Effect.succeed(typeof value === "boolean"
        ? { answered: true, approved: value }
        : typeof value === "string" ? { answered: true, answer: value } : { answered: false })),
      HumanTask.layer,
    ))
    const remove = Interpreter.layerWithImplementations(FlowDelete, RemoveFlow.toLayer(({ flowId }) =>
      Effect.sync(() => ({ deleted: saved.delete(flowId) }))))
    const bindingsForRun = Effect.gen(function* () {
      const inspection = yield* Deferred.await(reader)
      const catalog = yield* source.pipe(
        Effect.provide(FlowRegistry.layer),
        Effect.provideService(EngineStore.RunInspection.RunInspection, inspection),
      )
      return yield* catalog.bindings()
    })
    const implementation = Call.toLayer(({ scoped }) =>
      Effect.gen(function* () {
        const bindings = yield* bindingsForRun
        if (scoped) {
          expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["app/theme/set"])
          return null
        }
        expect(bindings.map((binding) => binding.descriptor.name)).toEqual(agentFlows)

        const runtime = yield* FlowRuntime.FlowRuntime
        const inspection = yield* Deferred.await(reader)
        const call = callFlow({ entryOf }, runtime, inspection)
        const input = { flowId }
        const askAgain = call("app/agent/ask", { kind: "approval", prompt: "May I continue?" }, "catalog/call/0.2")
        if (approved) {
          const binding = bindings.find((entry) => entry.descriptor.name === "flow/delete")!
          const identity = new Cell.CallIdentity({
            session: "catalog", frame: 0, ordinal: 1, cell: "catalog-test",
            declaration: Cell.declarationDigest(binding.descriptor), layers: [],
          })
          const receipt = yield* binding.run(Cell.callOf(binding.descriptor, { input, identity }))
          expect(receipt).toMatchObject({ outcome: "success", value: { deleted: true } })
        } else {
          expect(yield* Effect.flip(call("flow/delete", input, "catalog/call/0.1"))).toEqual(new NotApproved())
          expect(yield* Effect.flip(call("flow/delete", input, "catalog/call/0.3"))).toEqual(new NotApproved())
        }
        expect(yield* askAgain).toEqual({ answered: true, approved })
        if (!approved) {
          const question = { kind: "question", prompt: "Which flow should I use?" }
          expect(yield* call("app/agent/ask", question, "catalog/call/0.4")).toEqual({
            answered: true, answer: "Use the other flow.",
          })
        }
        return null
      }).pipe(Effect.orDie))
    const caller = Interpreter.layerWithImplementations(Caller, implementation)
    const scopedCaller = Interpreter.layerWithImplementations(ScopedCaller, implementation)

    const { context, engine } = yield* build(Layer.mergeAll(ask, remove, caller, scopedCaller))
    const server = yield* TestDatabase.serverUrl
    const inspection = yield* Layer.build(EngineStore.RunInspection.layerWith({ flows: [Ask, FlowDelete, Caller, ScopedCaller] }).pipe(
      Layer.provide(ExecutionHost.readDatabase(server.toString(), engine.schema)),
    ))
    yield* Deferred.succeed(reader, Context.get(inspection, EngineStore.RunInspection.RunInspection))
    const runtime = Context.get(context, FlowRuntime.FlowRuntime)
    const running = yield* Effect.forkScoped(runtime.execute(Caller, { executionId: "catalog", payload: {} }))
    const answer = (executionId: string, value: boolean | string = approved) => HumanTask.answer({ token: tokenOf(executionId), value }).pipe(
      Effect.provideService(FlowRuntime.FlowRuntime, runtime),
      Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
    )

    yield* answer("catalog/call/0.1/confirm")
    if (approved) yield* answer("catalog/call/0.2")
    else yield* answer("catalog/call/0.4", "Use the other flow.")
    expect(yield* Fiber.join(running)).toBeNull()
    expect(saved.has(flowId)).toBe(!approved)
    if (approved) {
      const bindings = yield* Effect.provide(bindingsForRun, context)
      expect(bindings.map((binding) => binding.descriptor.name)).toEqual(agentFlows)
      yield* runtime.execute(ScopedCaller, {
        executionId: "scoped",
        payload: { allowed: ["app/theme/set", "flow/delete"] },
      })
    } else {
      expect(yield* engine.status("catalog/call/0.1")).toBeUndefined()
      expect(yield* engine.status("catalog/call/0.3/confirm")).toBeUndefined()
      expect(yield* engine.status("catalog/call/0.2")).toBeUndefined()
    }
  }))))
