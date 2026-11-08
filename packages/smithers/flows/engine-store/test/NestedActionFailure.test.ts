import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const Root = Flow.make("NestedFailure/Root", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})
const Child = Flow.make("NestedFailure/Child", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})
// This unhappy path has no filesystem work: fail if the engine asks the host for any.
const noWorkspace = () => Effect.die(new Error("sealed nested-failure actions must not touch a workspace"))
const jj = Jj.make({
  snapshot: noWorkspace,
  restore: noWorkspace,
  diff: noWorkspace,
  workspaceAdd: noWorkspace,
  workspaceForget: noWorkspace,
  status: noWorkspace
})

describe("nested action failure coordinates", () => {
  for (
    const [name, credential, expected, whole] of [
      ...["smm_", "smt1.e30."].flatMap((prefix) =>
        [
          ["ordinary", "aB0_-".repeat(8) + "aAQ"],
          ["interior provider key", "A".repeat(30) + "-sk-" + "B".repeat(8) + "Q"],
          ["interior machine token", "AAAA-smm_" + "B".repeat(33) + "Q_upstream"]
        ].map(([shape, suffix]) => [`${prefix} (${shape})`, prefix + suffix, "[REDACTED]"])
      ),
      ["enclosing API key", `sk-proj-ABsmm_${"B".repeat(42)}Q`, "[REDACTED]"],
      ["enclosing GitHub PAT", `github_pat_ABCsmm_${"B".repeat(42)}Q`, "[REDACTED]"],
      ["enclosing GitLab token", `glpat-ABCsmm_${"B".repeat(42)}Q`, "[REDACTED]"],
      ["enclosing JWT", `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJpbnZlbnRlZCJ9.smm_${"B".repeat(38)}Q_upstream`, "[REDACTED]"],
      ...["smm_", "smt1.e30."].flatMap((prefix) => {
        const token = prefix + "A".repeat(42) + "Q"
        return [
          [`contextual ${prefix} Basic`, `Authorization: Basic ${token}`, "[REDACTED]", true],
          [`contextual ${prefix} bearer`, `Authorization: Bearer ${token}+remainingSecret`, "[REDACTED]", true],
          [`contextual ${prefix} query`, `https://example.test/?sig=${token}+remainingSecret`, "[REDACTED]", true],
          [`contextual ${prefix} assignment`, `${token}_password=remainingSecret`, "[REDACTED]", true]
        ]
      }),
      ...["smm_", "smt1.e30."].map((prefix) => [
        `fragmented contextual ${prefix}`,
        `password=${prefix}${"A".repeat(42)}Q_password=tail`,
        "[REDACTED]",
        true
      ]),
      ...["smm_", "smt1.e30."].map((prefix) => [
        `overlapping PEM ${prefix}`,
        prefix + "A".repeat(30) + "-----BEGINABQ PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----",
        "[REDACTED]",
        true
      ])
    ]
  ) {
    it.live(`redacts ${name} in the stored terminal failure and replay`, () =>
      withCrypto(Effect.scoped(
        Effect.gen(function*() {
          const message = `upstream rejected ${credential}`
          let calls = 0
          const engine = yield* EngineStore.make({ owner: { hostId: "token-failure" }, journalSource: "token-failure" })
          const action = Action.make({
            name: "TokenFailure/Action",
            success: Schema.String,
            error: Schema.String,
            idempotencyKey: "token-failure",
            execute: Effect.suspend(() => {
              calls++
              return Effect.fail(message)
            })
          })
          yield* engine.register(Root, () => action)
          for (let attempt = 0; attempt < 2; attempt++) {
            const exit = yield* Effect.exit(engine.execute(Root, { executionId: "token-root", payload: {} }))
            expect(
              Exit.isFailure(exit) &&
                exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === message)
            ).toBe(true)
            const row = yield* (yield* RunStore.RunStore).get("token-root")
            expect(row.status).toBe("failed")
            const failure = JSON.parse(row.stateJson).failure
            expect(failure).toMatchObject({ action: "TokenFailure/Action", attempts: 1 })
            expect(failure.message).toBe(JSON.stringify(whole ? expected : `upstream rejected ${expected}`))
            expect(JSON.stringify(failure)).not.toContain(credential)
          }
          expect(calls).toBe(1)
        }).pipe(
          Effect.provideService(Jj.Jj, jj),
          Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer())
        )
      )))
  }

  for (const prefix of ["smm_", "smt1.e30."]) {
    it.live(`preserves a structured token error through failed-attempt crash replay (${prefix})`, () =>
      withCrypto(Effect.scoped(
        Effect.gen(function*() {
          const token = prefix + "A".repeat(42) + "Q"
          const error = { _tag: "TokenRejected", message: `rejected ${token}`, stack: `at upstream (${token})` }
          const schema = Schema.Struct({
            _tag: Schema.Literal(error._tag),
            message: Schema.Literal(error.message),
            stack: Schema.Literal(error.stack)
          })
          const flow = Flow.make("StructuredToken/Root", {
            payload: {},
            success: Schema.String,
            error: schema,
            body: opaqueHandlerBody
          })
          const reached = yield* Deferred.make<void>()
          const finish = yield* Deferred.make<void>()
          let calls = 0
          const action = Action.make({
            name: "StructuredToken/Action",
            success: Schema.String,
            error: schema,
            idempotencyKey: "structured-token",
            execute: Effect.suspend(() => {
              calls++
              return Effect.fail(error)
            })
          })
          const create = Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: "structured-token" },
              journalSource: "structured-token",
              isAlive: () => Effect.succeed(false)
            })
            yield* engine.register(flow, () =>
              Effect.gen(function*() {
                const exit = yield* Effect.exit(Effect.gen(function*() {
                  return yield* action
                }))
                yield* Deferred.succeed(reached, undefined)
                yield* Deferred.await(finish)
                return yield* exit
              }))
            return engine
          })
          const first = yield* create
          const running = yield* Effect.forkChild(first.execute(flow, { executionId: "structured-root", payload: {} }))
          yield* Deferred.await(reached)
          const runs = yield* RunStore.RunStore
          expect((yield* runs.get("structured-root")).status).toBe("running")
          const journal = yield* Journal.Journal
          yield* journal.flush
          const entries = yield* journal.entries({ runId: "structured-root" as never, limit: 100 })
          const settled = entries.entries.find((entry) => entry.eventType === "flows.engine.attempt-finished")!
          expect(settled).toBeDefined()
          const identity = settled.payload as { runId: string; stepKeyDigest: string; attempt: number }
          const attempts = yield* AttemptStore.AttemptStore
          const recorded = yield* attempts.get(identity)
          expect(recorded._tag).toBe("Some")
          if (recorded._tag === "Some") expect(recorded.value.state).toBe("failed")
          // Interrupt only after the attempt is durable, while root settlement is held.
          yield* Fiber.interrupt(running)
          yield* Deferred.succeed(finish, undefined)
          const restarted = yield* create
          const exit = yield* Effect.exit(restarted.execute(flow, { executionId: "structured-root", payload: {} }))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const reason = exit.cause.reasons.find(Cause.isFailReason)
            expect(reason?.error).toEqual(error)
          }
          if (recorded._tag === "Some") {
            expect(recorded.value.error).toMatchObject({ reasons: [{ _tag: "Fail", error }] })
          }
          expect(calls).toBe(1)
          const row = yield* runs.get("structured-root")
          expect(row.status).toBe("failed")
          const diagnostic = JSON.stringify(JSON.parse(row.stateJson).failure)
          expect(diagnostic).not.toContain(token)
          expect(diagnostic).toContain("[REDACTED")
        }).pipe(
          Effect.provideService(Jj.Jj, jj),
          Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer())
        )
      )))
  }

  for (const replay of [false, true]) {
    it.live(`keeps separate origins when the parent handles only the first child failure (${replay ? "replay" : "live"})`, () =>
      withCrypto(Effect.scoped(
        Effect.gen(function*() {
          const calls = { A: 0, B: 0 }
          const action = (name: "A" | "B", count: number) =>
            Action.make({
              name: `Composite/${name}`,
              success: Schema.String,
              error: Schema.String,
              idempotencyKey: name,
              retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: count }),
              execute: Effect.suspend(() => {
                calls[name]++
                return Effect.fail(name)
              })
            })
          const a = action("A", 2), b = action("B", 3)
          const create = Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: "composite-failure" },
              journalSource: "composite-failure",
              isAlive: () => Effect.succeed(false)
            })
            yield* engine.register(Child, () =>
              Effect.gen(function*() {
                const first = yield* Effect.exit(a), second = yield* Effect.exit(b)
                if (Exit.isSuccess(first) || Exit.isSuccess(second)) {
                  return yield* Effect.die("expected both actions to fail")
                }
                return yield* Effect.failCause(Cause.fromReasons([...first.cause.reasons, ...second.cause.reasons]))
              }))
            yield* engine.register(
              Root,
              () =>
                engine.execute(Child, { executionId: "composite-child", payload: {} }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.failCause(Cause.fromReasons(cause.reasons.flatMap((reason) =>
                      Cause.isFailReason(reason) && reason.error === "B"
                        ? [Cause.makeFailReason(reason.error).annotate(Cause.reasonAnnotations(reason))] :
                        []
                    )))
                  )
                )
            )
            return engine
          })
          let engine = yield* create
          if (replay) {
            yield* Effect.exit(engine.execute(Child, { executionId: "composite-child", payload: {} }))
            engine = yield* create
          }
          const exit = yield* Effect.exit(engine.execute(Root, { executionId: "composite-root", payload: {} }))
          expect(Exit.isFailure(exit)).toBe(true)
          const store = yield* RunStore.RunStore
          const child = JSON.parse((yield* store.get("composite-child")).stateJson)
          expect(child.failureSites.map((site: { action: string }) => site.action)).toEqual([
            "Composite/A",
            "Composite/B"
          ])
          const root = JSON.parse((yield* store.get("composite-root")).stateJson)
          expect(root.failure).toMatchObject({ executionId: "composite-child", action: "Composite/B", attempts: 3 })
          expect(calls).toEqual({ A: 2, B: 3 })
        }).pipe(
          Effect.provideService(Jj.Jj, jj),
          Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer())
        )
      )))
  }

  it.live("keeps an inline failure separate from a later interpreted defect", () =>
    withCrypto(Effect.scoped(
      Effect.gen(function*() {
        let calls = 0
        const a = Action.make({
          name: "Mixed/A",
          success: Schema.String,
          error: Schema.String,
          execute: Effect.fail("A")
        })
        const engine = yield* EngineStore.make({ owner: { hostId: "mixed-failure" }, journalSource: "mixed-failure" })
        yield* engine.register(Root, () =>
          Effect.gen(function*() {
            calls++
            const first = yield* Effect.exit(a)
            if (Exit.isSuccess(first)) return yield* Effect.die("expected A to fail")
            const second = Cause.makeDieReason({ _tag: "SecondDefect", message: "B" })
              .annotate(Context.make(Interpreter.DefectSite, { nodeId: "node-B", action: "Mixed/B" }))
            return yield* Effect.failCause(Cause.fromReasons([...first.cause.reasons, second]))
          }))
        for (let attempt = 0; attempt < 2; attempt++) {
          const exit = yield* Effect.exit(engine.execute(Root, { executionId: "mixed-root", payload: {} }))
          expect(Exit.isFailure(exit)).toBe(true)
          const row = yield* (yield* RunStore.RunStore).get("mixed-root")
          expect(row.status).toBe("failed")
          const failure = JSON.parse(row.stateJson).failure
          expect(failure).toMatchObject({ tag: "failed", message: JSON.stringify("A"), action: "Mixed/A", attempts: 1 })
          expect(failure.nodeId).toBeUndefined()
        }
        expect(calls).toBe(1)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layer())
      )
    )))

  it.live("settles and replays a message whose emoji crosses the projection boundary", () =>
    withCrypto(Effect.scoped(
      Effect.gen(function*() {
        const message = "x".repeat(1023) + "🔥"
        const engine = yield* EngineStore.make({
          owner: { hostId: "unicode-failure" },
          journalSource: "unicode-failure"
        })
        const UnicodeRoot = Flow.make("NestedFailure/Unicode", {
          payload: {},
          success: Schema.String,
          error: Schema.Struct({ message: Schema.String }),
          body: opaqueHandlerBody
        })
        yield* engine.register(UnicodeRoot, () => Effect.fail({ message }))
        for (let attempt = 0; attempt < 2; attempt++) {
          const exit = yield* Effect.exit(engine.execute(UnicodeRoot, { executionId: "unicode-root", payload: {} }))
          expect(
            Exit.isFailure(exit) && exit.cause.reasons.some((reason) =>
              Cause.isFailReason(reason) && typeof reason.error === "object" && "message" in reason.error &&
              reason.error.message === message
            )
          ).toBe(true)
        }
        const row = yield* (yield* RunStore.RunStore).get("unicode-root")
        expect(row.status).toBe("failed")
        expect(JSON.parse(row.stateJson).failure.message).toBe("x".repeat(1023) + "…")
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layer())
      )
    )))

  for (const annotated of [false, true]) {
    it.live(`settles and replays 26000 reasons without optional metadata overflowing state (${annotated ? "coordinates" : "no coordinates"})`, () =>
      withCrypto(Effect.scoped(
        Effect.gen(function*() {
          let calls = 0
          const engine = yield* EngineStore.make({ owner: { hostId: "large-cause" }, journalSource: "large-cause" })
          yield* engine.register(Root, () =>
            Effect.suspend(() => {
              calls++
              return Effect.failCause(Cause.fromReasons(Array.from({ length: 26_000 }, (_, index) => {
                const reason = Cause.makeFailReason(`failure-${index}`)
                return annotated
                  ? reason.annotate(
                    Context.make(FlowEngine.FailureSite, {
                      executionId: "large-root",
                      action: `action-${index}`,
                      attempts: 1
                    })
                  )
                  : reason
              })))
            }))
          for (let attempt = 0; attempt < 2; attempt++) {
            const exit = yield* Effect.exit(engine.execute(Root, { executionId: "large-root", payload: {} }))
            expect(Exit.isFailure(exit) && exit.cause.reasons.length).toBe(26_000)
            if (Exit.isFailure(exit)) {
              expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
                .toEqual(Array.from({ length: 26_000 }, (_, index) => `failure-${index}`))
            }
          }
          const row = yield* (yield* RunStore.RunStore).get("large-root")
          expect(row.status).toBe("failed")
          expect(JSON.parse(row.stateJson).failureSites).toBeUndefined()
          expect(calls).toBe(1)
        }).pipe(
          Effect.provideService(Jj.Jj, jj),
          Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer())
        )
      )))
  }

  it.live("bounds and redacts every diagnostic coordinate before the terminal transaction", () =>
    withCrypto(Effect.scoped(
      Effect.gen(function*() {
        const credential = "ghp_" + "q".repeat(36)
        const signed = "signed-value-for-diagnostic-test"
        const token = "token-value-for-diagnostic-test"
        const unsafe =
          `${credential}\nhttps://example.test/object?X-Amz-Signature=${signed}\nAuthorization: Token ${token}\n` +
          "🔥".repeat(10_000)
        const action = Action.make({
          name: "Unsafe/Action",
          success: Schema.String,
          error: Schema.String,
          execute: Effect.failCause(
            Cause.fromReasons([
              Cause.makeFailReason(unsafe).annotate(Context.make(FlowEngine.FailureSite, {
                executionId: unsafe,
                action: unsafe,
                nodeId: unsafe,
                attempts: 1
              }))
            ])
          )
        })
        const engine = yield* EngineStore.make({
          owner: { hostId: "bounded-failure" },
          journalSource: "bounded-failure"
        })
        yield* engine.register(Root, () => action)
        yield* Effect.exit(engine.execute(Root, { executionId: "bounded-root", payload: {} }))
        const state = JSON.parse((yield* (yield* RunStore.RunStore).get("bounded-root")).stateJson)
        const diagnostic = JSON.stringify(state.failure)
        for (const secret of [credential, signed, token]) {
          expect(diagnostic).not.toContain(secret)
          expect(JSON.stringify(state.failureSites)).not.toContain(secret)
        }
        expect(new TextEncoder().encode(diagnostic).length).toBeLessThanOrEqual(16 * 1024)
        expect(JSON.stringify(state.failureSites)).not.toContain(credential)
        for (const key of ["executionId", "action", "nodeId"]) {
          expect(state.failure[key]).toContain("[REDACTED]")
          expect(new TextEncoder().encode(JSON.stringify(state.failure[key])).length).toBeLessThanOrEqual(512)
        }
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layer())
      )
    )))

  for (const metadata of ["ordinary", "oversized", "accessor", "proxy"] as const) {
    for (const replay of [false, true]) {
      it.live(`retains the child action's three attempts through an outer action with ${metadata} metadata (${replay ? "failed-attempt replay" : "live"})`, () =>
        withCrypto(Effect.scoped(
          Effect.gen(function*() {
            const reached = yield* Deferred.make<void>()
            const finish = yield* Deferred.make<void>()
            let innerCalls = 0
            let outerCalls = 0
            let metadataReads = 0
            const coordinates = { executionId: "nested-child", action: "NestedFailure/Inner", attempts: 3 }
            const annotated = metadata === "oversized" ?
              { ...coordinates, nodeId: "x".repeat(300_000) }
              : metadata === "accessor" ?
              {
                ...coordinates,
                get action(): string {
                  metadataReads++
                  throw new Error("must not invoke metadata getters")
                }
              }
              : metadata === "proxy" ?
              new Proxy(coordinates, {
                getOwnPropertyDescriptor() {
                  metadataReads++
                  throw new Error("must not inspect a metadata proxy")
                }
              })
              : undefined
            const inner = Action.make({
              name: "NestedFailure/Inner",
              success: Schema.String,
              error: Schema.String,
              idempotencyKey: "nested-inner",
              retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 }),
              execute: Effect.suspend(() => {
                innerCalls++
                const reason = Cause.makeFailReason("nested provider unavailable")
                return Effect.failCause(
                  Cause.fromReasons([
                    annotated === undefined ? reason : reason.annotate(Context.make(FlowEngine.FailureSite, annotated))
                  ])
                )
              })
            })
            const create = Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: "nested-failure" },
                journalSource: "nested-failure",
                isAlive: () => Effect.succeed(false)
              })
              yield* engine.register(Child, () => inner)
              const outer = Action.make({
                name: "NestedFailure/Outer",
                success: Schema.String,
                error: Schema.String,
                idempotencyKey: "nested-outer",
                retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 }),
                // The child's failure is its declared string error; the engine's cycle refusal cannot occur on this one-level call.
                execute: Effect.suspend(() => {
                  outerCalls++
                  return engine.execute(Child, { executionId: "nested-child", payload: {} }) as Effect.Effect<
                    string,
                    string
                  >
                })
              })
              yield* engine.register(Root, () =>
                Effect.gen(function*() {
                  const exit = yield* Effect.exit(Effect.gen(function*() {
                    return yield* outer
                  }))
                  yield* Deferred.succeed(reached, undefined)
                  yield* Deferred.await(finish)
                  return yield* exit
                }))
              return engine
            })
            const first = yield* create
            let result: Exit.Exit<unknown, unknown>
            if (replay) {
              const running = yield* Effect.forkChild(first.execute(Root, { executionId: "nested-root", payload: {} }))
              yield* Deferred.await(reached)
              yield* Fiber.interrupt(running)
              yield* Deferred.succeed(finish, undefined)
              const restarted = yield* create
              result = yield* Effect.exit(restarted.execute(Root, { executionId: "nested-root", payload: {} }))
            } else {
              yield* Deferred.succeed(finish, undefined)
              result = yield* Effect.exit(first.execute(Root, { executionId: "nested-root", payload: {} }))
            }
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) {
              const reason = result.cause.reasons.find(Cause.isFailReason)
              expect(reason, String(result.cause)).toBeDefined()
              expect(reason!.error).toBe("nested provider unavailable")
              if (metadata === "ordinary" || metadata === "oversized") {
                expect(Context.getOrUndefined(Cause.reasonAnnotations(reason!), FlowEngine.FailureSite))
                  .toMatchObject({ executionId: "nested-child", action: "NestedFailure/Inner", attempts: 3 })
              }
            }
            const store = yield* RunStore.RunStore
            const root = yield* store.get("nested-root")
            expect(root.status).toBe("failed")
            const failure = JSON.parse(root.stateJson).failure
            expect(failure.message).toBe(JSON.stringify("nested provider unavailable"))
            if (metadata === "ordinary" || metadata === "oversized") {
              expect(failure).toMatchObject({ executionId: "nested-child", action: "NestedFailure/Inner", attempts: 3 })
            }
            expect(metadataReads).toBe(0)
            expect(innerCalls).toBe(3)
            expect(outerCalls).toBe(1)
          }).pipe(
            Effect.provideService(Jj.Jj, jj),
            Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
            Effect.provide(StepBoundary.layerTest()),
            Effect.provide(TestStores.layer())
          )
        )))
    }
  }
})
