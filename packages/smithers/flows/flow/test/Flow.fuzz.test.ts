import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as PlanEffects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import {
  Arbitrary,
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Result,
  Schema,
  Stream
} from "effect"
import { PersistedQueue } from "effect/persistence"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as FlowPkg from "../src/index.ts"
import {
  Action,
  Deadline,
  DurableClock,
  DurableDeferred,
  DurableQueue,
  ExternalJob,
  Fault,
  Flow,
  FlowRuntime,
  Graph,
  HumanTask,
  Interpreter,
  JournalDecode,
  Poll,
  RetryPolicy,
  RunMetrics,
  Sleep,
  SpanFailure,
  Stall,
  StepIdentity,
  WaitFor
} from "../src/index.ts"
import { layerMemory, layerWired, makeInstance, makeMemoryState } from "./MemoryFlowRuntime.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const pureExecutions = Math.max(24, Math.min(baseExecutions, 140))
const ioExecutions = Math.max(12, Math.min(Math.ceil(baseExecutions / 4), 35))
const simExecutions = Math.max(10, Math.min(Math.ceil(baseExecutions / 6), 22))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number; readonly execution?: Fuzz.Execution }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (value) => predicate(value).pipe(Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const SafeName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,12}$/))
const AsciiText = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{0,40}$/))

describe("@smthrs/flow fuzz", () => {
  it("fuzzes RetryPolicy, Fault, and Stall", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        initialMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        factor: Schema.Literals([1, 2, 3]),
        maxMs: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 5000 })),
        jitterRatio: Schema.Literals([0, 0.25, 0.5]),
        attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
        elapsedMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 })),
        expirationMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 4000 }))),
        faultClass: Fault.Class,
        faultTag: SafeName,
        faultCode: SafeName,
        stallRounds: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 4 })),
        stallOn: Stall.On,
        observations: Schema.Array(
          Schema.Struct({
            tree: Schema.Literals(["t1", "t2"]),
            checks: Schema.Literals(["c1", "c2", "ok"]),
            output: Schema.Literals(["o1", "o2"])
          })
        ).check(Schema.isMinLength(1), Schema.isMaxLength(8))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // RetryPolicy
          const maxDelay = Math.max(v.initialMs, v.maxMs)
          const policy = RetryPolicy.make({
            maxAttempts: v.maxAttempts,
            initialMs: v.initialMs,
            factor: v.factor,
            maxMs: maxDelay,
            jitterRatio: v.jitterRatio,
            ...(v.expirationMs !== undefined ? { expirationMs: v.expirationMs } : {}),
            nonRetryable: ["FatalTag"]
          })
          expect(RetryPolicy.defaultRetryPolicy).toBeDefined()
          expect(RetryPolicy.transient).toBeDefined()
          expect(RetryPolicy.retryAfter(10)._tag).toBe("RetryAfter")
          expect(RetryPolicy.giveUp("exhausted")._tag).toBe("GiveUp")
          expect(RetryPolicy.giveUp("expired")._tag).toBe("GiveUp")
          expect(RetryPolicy.giveUp("nonRetryable")._tag).toBe("GiveUp")

          const d = RetryPolicy.nextDelay(policy, v.attempt, { random: 0.5 })
          if (Option.isSome(d)) {
            expect(d.value).toBeGreaterThanOrEqual(0)
            expect(d.value).toBeLessThanOrEqual(maxDelay)
          }

          const dEff = yield* RetryPolicy.nextDelayEffect(policy, v.attempt)
          if (Option.isSome(dEff)) {
            expect(dEff.value).toBeGreaterThanOrEqual(0)
            expect(dEff.value).toBeLessThanOrEqual(maxDelay)
          }

          expect(RetryPolicy.errorTag({ _tag: "CustomErr" })).toBe("CustomErr")
          expect(RetryPolicy.errorTag(new TypeError("x"))).toBe("TypeError")
          expect(RetryPolicy.errorTag(null)).toBeUndefined()
          expect(RetryPolicy.failureType(Cause.fail({ _tag: "Boom" }))).toBe("Boom")
          expect(RetryPolicy.isNonRetryable(policy, { _tag: "FatalTag" })).toBe(true)
          expect(RetryPolicy.isNonRetryable(policy, { _tag: "TransientTag" })).toBe(false)

          const dec = RetryPolicy.decide(policy, {
            attempt: v.attempt,
            elapsedMs: v.elapsedMs,
            error: { _tag: "TransientTag" },
            random: 0.5
          })
          if (v.attempt >= v.maxAttempts) {
            expect(dec._tag).toBe("GiveUp")
          }
          const decNonRetry = RetryPolicy.decide(policy, {
            attempt: 1,
            elapsedMs: 0,
            error: { _tag: "FatalTag" }
          })
          expect(decNonRetry._tag).toBe("GiveUp")
          const decEff = yield* RetryPolicy.decideEffect(policy, {
            attempt: v.attempt,
            elapsedMs: v.elapsedMs,
            error: { _tag: "TransientTag" }
          })
          expect(decEff._tag === "RetryAfter" || decEff._tag === "GiveUp").toBe(true)
          expect(RetryPolicy.schedule(policy)).toBeDefined()
          expect(
            new RetryPolicy.RetryPolicyExpired({ actionName: "a", attempt: 1, expirationMs: 10 })._tag
          ).toBeDefined()
          expect(
            new RetryPolicy.RetryAttemptsExhausted({ actionName: "a", attempt: 2, maxAttempts: 2 })._tag
          ).toBeDefined()

          // Fault
          const regTag = `fuzz/${v.faultTag}/${v.faultCode}/${v.faultClass}`
          Fault.register(regTag, { [v.faultCode]: v.faultClass })
          // Idempotent re-register succeeds
          Fault.register(regTag, { [v.faultCode]: v.faultClass })
          // Conflicting re-register throws
          const otherClass = v.faultClass === "bug" ? "infra" : "bug"
          expect(() => Fault.register(regTag, { [v.faultCode]: otherClass })).toThrow()
          const f1 = Fault.of({ _tag: regTag, code: v.faultCode })
          expect(f1.class).toBe(v.faultClass)
          expect(f1.tag).toBe(`${regTag}/${v.faultCode}`)
          const fNested = Fault.of({ _tag: "unregistered", cause: { _tag: regTag, code: v.faultCode } })
          expect(fNested.class).toBe(v.faultClass)
          const fUnknown = Fault.of(new Error("unregistered"))
          expect(fUnknown.class).toBe("bug")
          const resp = Fault.respond(f1, {
            attempt: v.attempt,
            seatsLeft: v.attempt % 2,
            parksLeft: (v.attempt + 1) % 2,
            replans: v.attempt % 3,
            veryHard: v.attempt % 2 === 0
          })
          expect(Fault.Response.literals).toContain(resp)

          // Stall
          expect(() => Stall.policy({ rounds: 1 })).toThrow(RangeError)
          const sp = Stall.policy({
            rounds: v.stallRounds,
            on: v.stallOn
          })
          let state = Stall.initial
          for (const obs of v.observations) {
            const next = Stall.observe(sp, state, {
              tree: obs.tree,
              checks: obs.checks === "ok" ? [] : [obs.checks],
              output: obs.output
            })
            state = next.state
            if (next.stalled !== undefined) {
              expect(next.stalled.on).toBe(v.stallOn)
              expect(Stall.Signal.literals).toContain(next.stalled.signal)
            }
          }
          expect(FlowPkg.Stall.initial).toEqual(Stall.initial)
          return true
        }),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("fuzzes Deadline, StepIdentity, RunMetrics, JournalDecode, and SpanFailure", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        actionName: SafeName,
        scopeA: SafeName,
        scopeB: SafeName,
        keyA: SafeName,
        keyB: SafeName,
        ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
        deadlineMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 2000 })),
        workMs: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 2500 })),
        door: Schema.String.check(Schema.isPattern(/^[a-z-]{0,16}$/)),
        actor: Schema.String.check(Schema.isPattern(/^[a-z-]{0,16}$/)),
        placement: Schema.String.check(Schema.isPattern(/^[a-z-]{0,16}$/)),
        waitReason: Schema.Literals(["timer", "signal", "approval", "quota", "human", "custom"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // StepIdentity injectivity & stability
          const id1: StepIdentity.AllocationIdentity = {
            kind: "action",
            name: v.actionName,
            idempotency: v.keyA,
            site: v.scopeA
          }
          const id2: StepIdentity.AllocationIdentity = {
            kind: "action",
            name: v.actionName,
            idempotency: v.keyB,
            site: v.scopeB
          }
          const s1 = yield* StepIdentity.allocationScope(id1)
          const s1Again = yield* StepIdentity.allocationScope(id1)
          expect(s1).toBe(s1Again)
          const s2 = yield* StepIdentity.allocationScope(id2)
          if (v.keyA !== v.keyB || v.scopeA !== v.scopeB) {
            expect(s1).not.toBe(s2)
          } else {
            expect(s1).toBe(s2)
          }
          const invKey = yield* StepIdentity.invocationKey({
            runId: `exec-${v.scopeA}`,
            ordinal: v.ordinal,
            tier: "irreversible"
          })
          expect(typeof invKey).toBe("string")
          yield* StepIdentity.reportDispatch({ outcome: "executed", attempt: 1 })

          // Deadline under TestClock
          const boundedFlow = Flow.make(`dl/${v.actionName}`, {
            payload: {},
            success: Schema.String,
            deadline: Duration.millis(v.deadlineMs),
            body: () => Node.succeed("ok")
          })
          const inst = makeInstance(boundedFlow, `exec-${v.actionName}`)
          yield* Effect.gen(function*() {
            const dl = yield* Deadline.start({
              flowName: `dl/${v.actionName}`,
              deadline: Duration.millis(v.deadlineMs)
            })
            expect(dl).toBeDefined()
            if (dl !== undefined) {
              const rem = yield* Deadline.remainingMs(dl)
              expect(rem).toBeGreaterThan(0)
            }

            const fib = yield* Effect.forkChild(
              Deadline.within(dl, `dl/${v.actionName}`)(
                Effect.sleep(Duration.millis(v.workMs)).pipe(Effect.as("finished"))
              )
            )
            yield* TestClock.adjust(Duration.millis(Math.min(v.workMs, v.deadlineMs) + 50))
            const exit = yield* Fiber.await(fib)
            if (v.workMs < v.deadlineMs) {
              expect(Exit.isSuccess(exit)).toBe(true)
            } else if (v.workMs > v.deadlineMs) {
              expect(Exit.isFailure(exit)).toBe(true)
            }

            // Deadline.bound combinator
            const boundRes = yield* Deadline.bound({
              flowName: `dl/${v.actionName}`,
              deadline: Duration.millis(500)
            })(Effect.succeed("fast"))
            expect(boundRes).toBe("fast")
          }).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, inst),
            Effect.provide(layerMemory)
          )

          // RunMetrics
          expect(typeof RunMetrics.door(v.door)).toBe("string")
          expect(typeof RunMetrics.actor(v.actor)).toBe("string")
          expect(typeof RunMetrics.placement(v.placement)).toBe("string")
          expect(RunMetrics.waitKinds).toContain(RunMetrics.waitKind(v.waitReason))
          expect(typeof RunMetrics.clean(` ${v.actionName} `)).toBe("string")
          const labels = RunMetrics.makeLabels(3)
          expect(labels.of("a")).toBe("a")
          expect(labels.of("b")).toBe("b")
          expect(labels.of("c")).toBe("c")
          expect(labels.of("d")).toBe("other")
          expect(typeof RunMetrics.flow(v.actionName)).toBe("string")
          expect(typeof RunMetrics.model("smart")).toBe("string")
          expect(RunMetrics.code("none")).toBe("none")
          expect(RunMetrics.settlement(Exit.succeed(1)).outcome).toBe("succeeded")
          expect(RunMetrics.settlement(Exit.fail({ _tag: "E", code: "bad" })).outcome).toBe("failed")
          expect(RunMetrics.settlement(Exit.die(new Error("die"))).outcome).toBe("failed")
          expect(RunMetrics.settlement(Exit.interrupt(1 as never)).outcome).toBe("lost")
          const runLbls: RunMetrics.RunLabels = {
            flow: v.actionName,
            door: "cli",
            actor: "agent",
            placement: "local"
          }
          yield* RunMetrics.withOrigin({ door: "cli", actor: "agent" })(
            Effect.gen(function*() {
              yield* RunMetrics.recordStarted({ ...runLbls, executionId: "e1" })
              yield* RunMetrics.recordFirstStep({ flow: v.actionName, placement: "local", delayMs: 12 })
              yield* RunMetrics.recordStep({
                flow: v.actionName,
                attempt: 1,
                outcome: "succeeded",
                code: "none"
              })
              yield* RunMetrics.recordWait({ flow: v.actionName, kind: "timer" })
              yield* RunMetrics.recordWaitEnded({ flow: v.actionName, kind: "timer", durationMs: 100 })
              yield* RunMetrics.recordModelCall({
                flow: v.actionName,
                model: "smart",
                outcome: "succeeded",
                inputTokens: 10,
                outputTokens: 5
              })
              yield* RunMetrics.recordSettled({
                ...runLbls,
                executionId: "e1",
                outcome: "succeeded",
                code: "none",
                durationMs: 30
              })
            })
          ).pipe(Effect.provide(RunMetrics.layerInfoLines))

          // JournalDecode
          const jdErr = new JournalDecode.JournalDecodeError({
            stepTag: v.actionName,
            objectId: "obj-1",
            codeVersion: "1"
          })
          expect(jdErr._tag).toBe("JournalDecodeError")
          yield* JournalDecode.report(v.actionName, "payload")

          // SpanFailure
          const redacted = SpanFailure.exit(Exit.fail({ _tag: "SecretErr", code: "bad", message: "SECRET_TOKEN" }))
          expect(Exit.isFailure(redacted)).toBe(true)
          expect(JSON.stringify(redacted)).not.toContain("SECRET_TOKEN")
          const okRedacted = SpanFailure.exit(Exit.succeed("ok"))
          expect(Exit.isSuccess(okRedacted)).toBe(true)
          const sfRes = yield* Effect.result(SpanFailure.effect(Effect.fail({ _tag: "E", message: "secret" })))
          expect(Result.isFailure(sfRes)).toBe(true)
          const sfStream = yield* Effect.result(Stream.runCollect(SpanFailure.stream(Stream.make(1, 2))))
          expect(Result.isSuccess(sfStream)).toBe(true)
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 2, executions: ioExecutions }
    )
  })

  it("fuzzes Graph.build, Action declarations, Flow declarations, and FlowRuntime error schemas", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: SafeName,
        tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
        mode: Schema.Literals(["hermetic", "expected"]),
        x: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        y: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        useRace: Schema.Boolean,
        useCatch: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const eff = PlanEffects.make({
            reads: ["src/*"],
            writes: ["dist/*"],
            mode: v.mode,
            onConflict: "serialize",
            tier: v.tier
          })

          const actA = Action.make(`g/${v.name}/a`, {
            payload: { x: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            tier: v.tier,
            effects: eff,
            capabilities: ["fs:read"]
          })
          const actB = Action.make(`g/${v.name}/b`, {
            payload: { y: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            tier: "sealed"
          })

          const flow = Flow.make(`g/${v.name}/flow`, {
            payload: { x: Schema.Number, y: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            effects: eff,
            capabilities: ["fs:read"],
            modelInvocable: true,
            body: ({ x, y }) => {
              const a = actA.call({ x }).pipe(Node.priority(1))
              const b = actB.call({ y })
              const combined = v.useRace
                ? Node.race({ l: a, r: b })
                : Node.all({ l: a, r: b }).pipe(Node.map(({ l, r }) => l + r))
              return v.useCatch
                ? combined.pipe(Node.andThen(Node.succeed(0)))
                : combined
            }
          })

          const graph = Graph.build(flow, { x: v.x, y: v.y })
          const nodes = Graph.nodes(graph)
          const drafts = Graph.drafts(graph)
          expect(nodes.length).toBeGreaterThanOrEqual(2)
          expect(drafts.length).toBeGreaterThanOrEqual(2)

          // Flow.make invalid deadline refusal
          expect(() =>
            Flow.make(`g/${v.name}/bad`, {
              payload: {},
              success: Schema.Number,
              deadline: -1 as never,
              body: () => Node.succeed(1)
            })
          ).toThrow()

          // Action error types
          expect(
            new Action.AttemptTimedOut({
              actionName: v.name,
              attempt: 1,
              bound: "attempt",
              timeoutMs: 100,
              message: "timed out"
            })._tag
          ).toBeDefined()
          expect(new Action.DuplicateImplementation({ name: v.name })._tag).toBeDefined()
          expect(
            new Action.ImplementationVersionMismatch({
              actionName: v.name,
              declaredVersion: "1",
              registeredVersion: "2",
              message: "mismatch"
            })._tag
          ).toBeDefined()
          const infra = new Action.InfraInterrupt({ reason: "evicted" })
          expect(infra._tag).toBeDefined()
          expect(
            new Action.InfraInterruptRetriesExhausted({
              actionName: v.name,
              attempts: 3,
              interrupt: infra,
              message: "exhausted"
            })._tag
          ).toBeDefined()
          expect(
            new Action.IrreversibleRetryRequiresIdempotencyKey({ actionName: v.name, attempt: 2 })._tag
          ).toBeDefined()
          expect(new Action.ConcurrentKeylessDispatch({ actionName: v.name })._tag).toBeDefined()
          expect(
            new Action.UncanonicalIdempotencyKey({
              actionName: v.name,
              reason: "nan",
              path: "$",
              message: "bad"
            })._tag
          ).toBeDefined()

          // FlowRuntime error types
          expect(
            new FlowRuntime.CancelRequestFailed({
              code: "cancel_request_failed",
              executionId: "e1",
              reason: "gone"
            })._tag
          ).toBeDefined()
          expect(
            new FlowRuntime.ExecutionIdentityConflict({
              executionId: "e1",
              field: "flow",
              expected: v.name,
              actual: "other",
              message: "conflict"
            })._tag
          ).toBeDefined()
          expect(new FlowRuntime.FlowCycleDetected({ path: [v.name] })._tag).toBeDefined()
          expect(new FlowRuntime.FlowExecutionNotFound({ executionId: "e1" })._tag).toBeDefined()
          expect(
            new FlowRuntime.RetryFromRefused({
              code: "not_settled",
              executionId: "e1",
              step: "s1"
            })._tag
          ).toBeDefined()
          expect(new FlowRuntime.StoreUnavailable({ executionId: "e1" })._tag).toBeDefined()
          return true
        }),
      { seed: seed + 3, executions: pureExecutions }
    )
  })

  it("fuzzes Interpreter, Action combinators (once/retry), child flows, and concurrent replay under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeName,
        a: Schema.Int.check(Schema.isBetween({ minimum: -30, maximum: 30 })),
        b: Schema.Int.check(Schema.isBetween({ minimum: -30, maximum: 30 })),
        failFirst: Schema.Boolean,
        useChild: Schema.Boolean,
        useCatch: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          let attempts = 0
          const seenOnce = new Map<string, number>()
          const Add = Action.make(`interp/${v.id}/add`, {
            payload: { x: Schema.Number, y: Schema.Number },
            success: Schema.Number,
            error: Schema.String
          })
          const Flaky = Action.make(`interp/${v.id}/flaky`, {
            payload: { n: Schema.Number },
            success: Schema.Number,
            error: Schema.String
          })
          const Child = Flow.make(`interp/${v.id}/child`, {
            payload: { x: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            body: ({ x }) => Add.call({ x, y: 10 })
          })
          const Parent = Flow.make(`interp/${v.id}/parent`, {
            payload: { a: Schema.Number, b: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            idempotencyKey: ({ a, b }) => `${v.id}:${a}:${b}`,
            body: ({ a, b }) => {
              const left = v.useChild ? Child.call({ x: a }) : Add.call({ x: a, y: 10 })
              const right = Flaky.call({ n: b })
              const joined = Node.all({ l: left, r: right }).pipe(Node.map(({ l, r }) => l + r))
              return v.useCatch ? joined.pipe(Node.map((n) => n)) : joined
            }
          })

          const state = makeMemoryState()
          const layer = layerWired(
            Layer.mergeAll(
              Add.toLayer(({ x, y }) =>
                Action.once(`once-${v.id}-${x}-${y}`, {
                  find: (k) => Effect.sync(() => Option.fromNullishOr(seenOnce.get(k))),
                  perform: (k) =>
                    Effect.sync(() => {
                      const val = x + y
                      seenOnce.set(k, val)
                      return val
                    })
                })
              ),
              Flaky.toLayer(({ n }) =>
                Action.retry(
                  Effect.suspend(() => {
                    attempts += 1
                    if (v.failFirst && attempts === 1) return Effect.fail("transient")
                    return Effect.succeed(n * 2)
                  }),
                  { times: 2 }
                )
              ),
              Interpreter.layer(Child),
              Interpreter.layer(Parent)
            ),
            state
          )

          const out = yield* Parent.execute({ a: v.a, b: v.b }).pipe(
            Effect.provide(layer),
            Effect.provide(NodeCrypto.layer)
          )
          expect(out).toBe(v.a + 10 + v.b * 2)

          // Re-executing with same idempotencyKey replays the result cleanly!
          const replayOut = yield* Parent.execute({ a: v.a, b: v.b }).pipe(
            Effect.provide(layer),
            Effect.provide(NodeCrypto.layer)
          )
          expect(replayOut).toBe(out)
          return true
        }),
      { seed: seed + 4, executions: simExecutions, execution: FuzzSimulation.execution() }
    )
  })

  it("fuzzes Sleep, DurableClock, WaitFor, and DurableDeferred (succeed/fail/tokenInvalid)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeName,
        sleepMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })),
        waitOutcome: Schema.Literals(["succeed", "fail"]),
        val: AsciiText
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // Sleep flow under TestClock
          const SleepFlow = Flow.make(`slp/${v.id}`, {
            payload: { ms: Schema.Number },
            success: Schema.String,
            error: Sleep.SleepRequestInvalid,
            idempotencyKey: ({ ms }) => `${v.id}:${ms}`,
            body: ({ ms }) =>
              Sleep.action.call({ millis: ms }).pipe(
                Node.map(() => "woke")
              )
          })
          const sleepLayer = layerWired(Layer.mergeAll(Sleep.layer, Interpreter.layer(SleepFlow)))
          const sleepRes = yield* Effect.gen(function*() {
            const fib = yield* Effect.forkChild(SleepFlow.execute({ ms: v.sleepMs }))
            yield* Effect.yieldNow
            yield* TestClock.adjust(Duration.millis(v.sleepMs + 50))
            return yield* Fiber.await(fib)
          }).pipe(Effect.provide(sleepLayer))
          expect(Exit.isSuccess(sleepRes)).toBe(true)

          // DurableDeferred token + succeed/fail + WaitFor
          const Gate = DurableDeferred.make(`gate/${v.id}`, {
            success: Schema.String,
            error: Schema.String
          })
          const GateAct = Action.make(`gate/${v.id}/act`, {
            payload: { id: Schema.String },
            success: Schema.String,
            error: Schema.String
          })
          const GateFlow = Flow.make(`gate/${v.id}/flow`, {
            payload: { id: Schema.String },
            success: Schema.String,
            error: Schema.String,
            idempotencyKey: ({ id }) => id,
            body: (p) => GateAct.call(p)
          })
          const gateLayer = layerWired(
            Layer.mergeAll(
              WaitFor.layer,
              GateAct.toLayer(() => DurableDeferred.await(Gate)),
              Interpreter.layer(GateFlow)
            )
          )

          yield* Effect.gen(function*() {
            const execId = yield* GateFlow.executionId({ id: v.id })
            const tok = DurableDeferred.tokenFromExecutionId(Gate, {
              flow: GateFlow,
              executionId: execId
            })
            const fib = yield* Effect.forkChild(GateFlow.execute({ id: v.id }))
            yield* Effect.yieldNow
            if (v.waitOutcome === "succeed") {
              yield* DurableDeferred.succeed(Gate, { token: tok, value: v.val })
            } else {
              yield* DurableDeferred.fail(Gate, { token: tok, error: "denied" })
            }
            yield* Effect.yieldNow
            const exit = yield* Fiber.await(fib)
            if (v.waitOutcome === "succeed") {
              expect(Exit.isSuccess(exit) && exit.value === v.val).toBe(true)
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
            }
            // Invalid token rejected
            const badTok = yield* Effect.result(
              DurableDeferred.succeed(Gate, { token: "not-a-valid-token" as never, value: "x" })
            )
            expect(Result.isFailure(badTok)).toBe(true)
          }).pipe(Effect.provide(gateLayer))

          expect(WaitFor.deferred(v.id)).toBeDefined()
          expect(DurableClock).toBeDefined()
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 5, executions: ioExecutions }
    )
  })

  it("fuzzes DurableQueue process and worker", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeName,
        n: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        shouldFail: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const Q = DurableQueue.make({
            name: `dq/${v.id}`,
            payload: { id: Schema.String, n: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            idempotencyKey: ({ id }) => id
          })
          const Offer = Action.make(`dq/${v.id}/offer`, {
            payload: { id: Schema.String, n: Schema.Number },
            success: Schema.Number,
            error: Schema.String
          })
          const QFlow = Flow.make(`dq/${v.id}/flow`, {
            payload: { id: Schema.String, n: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            idempotencyKey: ({ id }) => id,
            body: (p) => Offer.call(p)
          })
          const pqLayer = PersistedQueue.layer.pipe(Layer.provideMerge(PersistedQueue.layerStoreMemory))
          const layer = Layer.mergeAll(
            Offer.toLayer((p) => DurableQueue.process(Q, p)),
            Interpreter.layer(QFlow),
            DurableQueue.worker(Q, ({ n }) =>
              v.shouldFail ? Effect.fail("worker-failed") : Effect.succeed(n * 3)
            )
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(layerMemory),
            Layer.provideMerge(pqLayer),
            Layer.provideMerge(NodeCrypto.layer)
          )

          const res = yield* Effect.result(QFlow.execute({ id: v.id, n: v.n }).pipe(Effect.provide(layer)))
          if (v.shouldFail) {
            expect(Result.isFailure(res)).toBe(true)
          } else {
            expect(Result.isSuccess(res) && res.success === v.n * 3).toBe(true)
          }
          return true
        }),
      { seed: seed + 6, executions: Math.min(ioExecutions, 18) }
    )
  })

  it("fuzzes Poll delayMillis and multi-round polling", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeName,
        backoff: Schema.Literals(["fixed", "linear", "exponential"]),
        intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 200 })),
        attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        until: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const d = Poll.delayMillis({
            attempt: v.attempt,
            intervalMs: v.intervalMs,
            backoff: v.backoff
          })
          expect(d).toBeGreaterThanOrEqual(v.intervalMs)

          const Probe = Action.make(`poll/${v.id}/probe`, {
            payload: { attempt: Schema.Number, until: Schema.Number },
            success: Poll.CheckResult(Schema.String)
          })
          const Poller = Poll.make(`poll/${v.id}`, {
            input: { until: Schema.Number },
            result: Schema.String,
            intervalMs: 10,
            backoff: v.backoff,
            maxAttempts: 2,
            check: ({ attempt, until }) => Probe.call({ attempt, until })
          })
          const layer = layerWired(
            Layer.mergeAll(
              Sleep.layer,
              Poll.layer,
              Probe.toLayer(({ attempt, until }) =>
                Effect.succeed({ satisfied: attempt >= until, output: `ok:${attempt}` })
              ),
              Interpreter.layer(Poller)
            )
          )

          const res = yield* Effect.gen(function*() {
            const fib = yield* Effect.forkChild(Poller.execute({ until: v.until, attempt: 1 }))
            for (let i = 0; i < 6; i++) {
              yield* Effect.yieldNow
              yield* TestClock.adjust(Duration.millis(50))
            }
            return yield* Fiber.await(fib)
          }).pipe(Effect.provide(layer))
          if (v.until === 1) {
            expect(Exit.isSuccess(res) && res.value === "ok:1").toBe(true)
          }
          expect(Poll.exhaustedTag).toBe("system/poll-exhausted")
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 7, executions: ioExecutions }
    )
  })

  it("fuzzes HumanTask schema validation, answer validation across all 4 kinds, and ExternalJob declarations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: HumanTask.Kind,
        text: AsciiText,
        flag: Schema.Boolean,
        num: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        choice: Schema.Literals(["alpha", "beta", "invalid"]),
        badSchemaKind: Schema.Literals([
          "valid-obj",
          "valid-arr",
          "valid-enum",
          "valid-nullable",
          "bad-keyword",
          "bad-type",
          "not-object",
          "deep-schema"
        ]),
        jobId: SafeName,
        jobOutcome: Schema.Literals(["succeeded", "failed"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          // HumanTask.validate across ask/confirm/select/json
          if (v.kind === "ask") {
            expect(HumanTask.validate(v.text, { kind: "ask" })).toBeUndefined()
            expect(HumanTask.validate(123, { kind: "ask" })).toBeDefined()
          } else if (v.kind === "confirm") {
            expect(HumanTask.validate(v.flag, { kind: "confirm" })).toBeUndefined()
            expect(HumanTask.validate("yes", { kind: "confirm" })).toBeDefined()
          } else if (v.kind === "select") {
            const res = HumanTask.validate(v.choice, { kind: "select", options: ["alpha", "beta"] })
            if (v.choice === "invalid") expect(res).toBeDefined()
            else expect(res).toBeUndefined()
          } else {
            const schema = {
              type: "object",
              properties: {
                name: { type: "string" },
                count: { type: "integer" },
                ok: { type: "boolean" }
              },
              required: ["name", "count"]
            }
            expect(HumanTask.validateSchema(schema)).toBeUndefined()
            expect(HumanTask.validate({ name: v.text, count: v.num, ok: v.flag }, { kind: "json", schema })).toBeUndefined()
            expect(HumanTask.validate({ name: v.text }, { kind: "json", schema })).toBeDefined()
            expect(HumanTask.validate({ name: 42, count: v.num }, { kind: "json", schema })).toBeDefined()
          }

          // HumanTask.validateSchema edge cases
          switch (v.badSchemaKind) {
            case "valid-obj":
              expect(HumanTask.validateSchema({ type: "object", properties: { a: { type: "number" } } })).toBeUndefined()
              break
            case "valid-arr":
              expect(HumanTask.validateSchema({ type: "array", items: { type: "string" } })).toBeUndefined()
              expect(HumanTask.validate(["a", "b"], { kind: "json", schema: { type: "array", items: { type: "string" } } })).toBeUndefined()
              expect(HumanTask.validate([1], { kind: "json", schema: { type: "array", items: { type: "string" } } })).toBeDefined()
              break
            case "valid-enum":
              expect(HumanTask.validateSchema({ enum: ["x", 1, null, true] })).toBeUndefined()
              expect(HumanTask.validate("x", { kind: "json", schema: { enum: ["x", 1] } })).toBeUndefined()
              expect(HumanTask.validate("y", { kind: "json", schema: { enum: ["x", 1] } })).toBeDefined()
              break
            case "valid-nullable":
              expect(HumanTask.validateSchema({ type: "string", nullable: true })).toBeUndefined()
              expect(HumanTask.validate(null, { kind: "json", schema: { type: "string", nullable: true } })).toBeUndefined()
              break
            case "bad-keyword":
              expect(HumanTask.validateSchema({ type: "string", pattern: "^a$" })).toBeDefined()
              break
            case "bad-type":
              expect(HumanTask.validateSchema({ type: "bigint" })).toBeDefined()
              break
            case "not-object":
              expect(HumanTask.validateSchema(null)).toBeDefined()
              break
            case "deep-schema": {
              let deep: Record<string, unknown> = { type: "string" }
              for (let i = 0; i <= HumanTask.maxSchemaDepth + 2; i++) {
                deep = { type: "object", properties: { n: deep } }
              }
              expect(HumanTask.validateSchema(deep)).toBeDefined()
              break
            }
          }

          expect(HumanTask.deferred(v.jobId, 1)).toBeDefined()
          expect(
            new HumanTask.HumanTaskFailed({
              code: "rejected",
              task: v.jobId,
              attempts: 1,
              rejections: ["bad"],
              message: "c"
            })._tag
          ).toBeDefined()
          expect(new HumanTask.HumanAnswerInvalid({ message: "bad" })._tag).toBeDefined()

          // ExternalJob declaration + errors + Status schema
          const Job = ExternalJob.make(`ej/${v.jobId}`, {
            payload: { value: Schema.String },
            handle: Schema.String,
            success: Schema.String,
            error: Schema.String,
            probe: { every: "50 millis", max: "100 millis" },
            timeout: "1 second",
            restarts: 1
          })
          expect(Job).toBeDefined()
          expect(new ExternalJob.Again({ message: "retry" })._tag).toBeDefined()
          expect(new ExternalJob.ExternalJobLost({ key: "k1", message: "lost" })._tag).toBeDefined()
          expect(new ExternalJob.ExternalJobTimedOut({ key: "k1", message: "timed out" })._tag).toBeDefined()
          const st = Schema.decodeUnknownSync(ExternalJob.Status)(
            v.jobOutcome === "succeeded" ? { _tag: "Exited", exitCode: 0 } : { _tag: "Running" }
          )
          expect(st._tag).toBeDefined()
          return true
        }),
      { seed: seed + 8, executions: pureExecutions }
    )
  })

  it("fuzzes live execution of WaitFor, HumanTask (answer/re-ask/exhausted), ExternalJob lifecycle, and Action.raceAll", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeName,
        scenario: Schema.Literals([
          "waitfor-valid",
          "waitfor-invalid-empty",
          "waitfor-invalid-both",
          "waitfor-invalid-token",
          "humantask-ok",
          "humantask-reask-then-ok",
          "humantask-exhausted",
          "externaljob-ok",
          "externaljob-again",
          "externaljob-lost",
          "externaljob-start-fail",
          "externaljob-run-fast",
          "externaljob-run-handoff",
          "action-race-all"
        ]),
        val: AsciiText
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const Host = Flow.make(`live/${v.id}/host`, {
            payload: {},
            success: Schema.Unknown,
            body: () => Node.succeed(undefined)
          })

          if (v.scenario.startsWith("waitfor-")) {
            const layer = layerWired(WaitFor.layer)
            yield* Effect.gen(function*() {
              const inst = makeInstance(Host, `exec-${v.id}`)
              if (v.scenario === "waitfor-valid") {
                const first = yield* Flow.intoResult(
                  Interpreter.interpret(WaitFor.action.call({ name: v.id }))
                ).pipe(Effect.provideService(FlowRuntime.FlowInstance, inst))
                expect(first._tag).toBe("Suspended")
                const tok = DurableDeferred.tokenFromExecutionId(WaitFor.deferred(v.id), {
                  flow: Host,
                  executionId: inst.executionId
                })
                yield* DurableDeferred.succeed(WaitFor.deferred(v.id), { token: tok, value: v.val })
                const second = yield* Flow.intoResult(
                  Interpreter.interpret(WaitFor.action.call({ name: v.id }))
                ).pipe(Effect.provideService(FlowRuntime.FlowInstance, inst))
                expect(second._tag).toBe("Complete")
              } else {
                const payload = v.scenario === "waitfor-invalid-empty"
                  ? {}
                  : v.scenario === "waitfor-invalid-both"
                  ? { name: v.id, token: "t" }
                  : { token: "not-a-valid-token" }
                const res = yield* Flow.intoResult(
                  Interpreter.interpret(WaitFor.action.call(payload))
                ).pipe(Effect.provideService(FlowRuntime.FlowInstance, inst))
                expect(res._tag).toBe("Complete")
              }
            }).pipe(Effect.provide(layer))
            return true
          }

          if (v.scenario.startsWith("humantask-")) {
            const payload = {
              name: v.id,
              kind: "select" as const,
              prompt: "Pick one",
              options: ["yes", "no"],
              maxAttempts: 2
            }
            const HTFlow = Flow.make(`live-ht/${v.id}`, {
              payload: { id: Schema.String },
              success: Schema.Json,
              error: HumanTask.HumanTaskFailed,
              idempotencyKey: ({ id }) => id,
              body: () => HumanTask.action.call(payload)
            })
            const layer = layerWired(Interpreter.layer(HTFlow).pipe(Layer.provideMerge(HumanTask.layer)))
            yield* Effect.gen(function*() {
              const execId = yield* HTFlow.executionId({ id: v.id })
              const submit = (attempt: number, value: Schema.Json) =>
                HumanTask.answer({
                  token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred(v.id, attempt), {
                    flow: HTFlow,
                    executionId: execId
                  }),
                  value
                })
              const yieldTurns = Effect.gen(function*() {
                for (let t = 0; t < 20; t++) yield* Effect.yieldNow
              })

              yield* HTFlow.execute({ id: v.id }, { discard: true })
              yield* yieldTurns
              if (v.scenario === "humantask-ok") {
                yield* submit(1, "yes")
                yield* yieldTurns
                const polled = yield* HTFlow.poll(execId)
                expect(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isSuccess(polled.value.exit)).toBe(true)
              } else if (v.scenario === "humantask-reask-then-ok") {
                yield* submit(1, "bad-choice")
                yield* yieldTurns
                yield* submit(2, "no")
                yield* yieldTurns
                const polled = yield* HTFlow.poll(execId)
                expect(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isSuccess(polled.value.exit)).toBe(true)
              } else {
                yield* submit(1, "bad-1")
                yield* yieldTurns
                yield* submit(2, "bad-2")
                yield* yieldTurns
                const polled = yield* HTFlow.poll(execId)
                expect(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isFailure(polled.value.exit)).toBe(true)
              }
            }).pipe(Effect.provide(layer))
            return true
          }

          if (v.scenario === "action-race-all") {
            const RAct = Action.make(`race/${v.id}/act`, { payload: { id: Schema.String }, success: Schema.String })
            const RFlow = Flow.make(`race/${v.id}/flow`, {
              payload: { id: Schema.String },
              success: Schema.String,
              idempotencyKey: ({ id }) => id,
              body: (p) => RAct.call(p)
            })
            const a1 = Action.make({ name: `race/${v.id}/a1`, success: Schema.String, execute: Effect.succeed("first") })
            const a2 = Action.make({ name: `race/${v.id}/a2`, success: Schema.String, execute: Effect.succeed("second") })
            const layer = layerWired(
              Interpreter.layer(RFlow).pipe(
                Layer.provideMerge(RAct.toLayer(() => Action.raceAll(`r-${v.id}`, [a1, a2])))
              )
            )
            const out = yield* RFlow.execute({ id: v.id }).pipe(Effect.provide(layer))
            expect(out === "first" || out === "second").toBe(true)
            return true
          }

          // ExternalJob live lifecycle on FlowEngine.layerMemory (execute + run)
          const Job = ExternalJob.make(`live-ej/${v.id}`, {
            payload: { value: Schema.String },
            handle: Schema.String,
            success: Schema.String,
            error: Schema.String,
            probe: { every: "10 millis", max: "20 millis" },
            timeout: "10 seconds",
            restarts: v.scenario === "externaljob-again" ? 1 : 0
          })
          let againOnce = v.scenario === "externaljob-again"
          const statuses: Array<ExternalJob.Status> = v.scenario === "externaljob-lost"
            ? [{ _tag: "Lost" }]
            : v.scenario === "externaljob-run-fast"
            ? [{ _tag: "Exited", exitCode: 0 }]
            : [{ _tag: "Running" }, { _tag: "Exited", exitCode: 0 }]

          const operations: ExternalJob.Operations<
            { readonly value: string },
            string,
            string,
            string,
            never
          > = {
            start: (_p, key) =>
              v.scenario === "externaljob-start-fail" ? Effect.fail("start-boom") : Effect.succeed(key),
            status: () => Effect.sync(() => statuses.shift() ?? { _tag: "Exited" as const, exitCode: 0 }),
            collect: () =>
              Effect.suspend(() => {
                if (againOnce) {
                  againOnce = false
                  return Effect.fail(new ExternalJob.Again({ message: "retry" }))
                }
                return Effect.succeed(v.val || "collected")
              }),
            cancel: () => Effect.void
          }
          const layer = Job.toLayer(operations).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory)
          )

          yield* Effect.gen(function*() {
            const eff = v.scenario === "externaljob-run-fast" || v.scenario === "externaljob-run-handoff"
              ? Job.run({ value: v.id }, { executionId: `ej-${v.id}`, operations })
              : Effect.flatMap(FlowRuntime.FlowRuntime, (rt) =>
                rt.execute(Job, { payload: { value: v.id }, executionId: `ej-${v.id}` })
              )
            const fib = yield* Effect.forkChild(Effect.exit(eff))
            for (let t = 0; t < 60; t++) {
              if (fib.pollUnsafe() !== undefined) break
              yield* Effect.yieldNow
              yield* TestClock.adjust(Duration.millis(25))
            }
            const exit = yield* Fiber.join(fib)
            if (v.scenario === "externaljob-lost" || v.scenario === "externaljob-start-fail") {
              expect(Exit.isFailure(exit)).toBe(true)
            } else {
              expect(Exit.isSuccess(exit)).toBe(true)
            }
          }).pipe(Effect.provide(layer))
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 9, executions: Math.max(ioExecutions, 42) }
    )
  })

  it("fuzzes Graph inspection/edges, Flow capability ceilings & execution IDs, Action FileBoundary/context, and Interpreter combinators/refusals", async () => {
    const CapPattern = Schema.Literals(["fs:read", "fs:write", "net:http", "fs:*", "*", "invalid pattern!"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeName,
        a: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        b: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        branchFlag: Schema.Boolean,
        failFirst: Schema.Boolean,
        capsLeft: Schema.Array(CapPattern).check(Schema.isMaxLength(3)),
        capsRight: Schema.Array(CapPattern).check(Schema.isMaxLength(3)),
        mode: Schema.Literals([
          "all-race-branch-catch",
          "die-and-defectOf",
          "unresolved-action",
          "interrupt-and-poll",
          "derived-vs-fresh-ids",
          "capability-ceilings"
        ])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          if (v.mode === "capability-ceilings") {
            const left = v.capsLeft.length > 0 ? [v.capsLeft] : []
            const right = v.capsRight.length > 0 ? [v.capsRight] : []
            const parsedLeft = Flow.parseCapabilityCeilings(left)
            expect(parsedLeft.length).toBe(left.length)
            const inter = Flow.intersectCeilings(left, right)
            expect(Flow.ceilingWithin(inter, left)).toBe(true)
            expect(Flow.ceilingWithin(inter, right)).toBe(true)
            expect(Flow.ceilingWithin(left, [])).toBe(true)
            const att = Flow.attenuateCapabilities(left)
            expect(typeof att).toBe("function")
            // FileBoundary schema (valid + disjoint writeSet/removes refusal) + Action.heartbeat
            const fb = Schema.decodeUnknownSync(Action.FileBoundary)({
              readSet: [],
              writeSet: ["dist/out.js"],
              removes: ["tmp/old.js"],
              boundaryMode: "hard"
            })
            expect(fb.writeSet).toEqual(["dist/out.js"])
            const badFb = Schema.decodeUnknownExit(Action.FileBoundary)({
              readSet: [],
              writeSet: ["dist/out.js"],
              removes: ["dist/out.js"],
              boundaryMode: "expected"
            })
            expect(Exit.isFailure(badFb)).toBe(true)
            yield* Action.heartbeat
            return true
          }

          if (v.mode === "derived-vs-fresh-ids") {
            const IdFlow = Flow.make(`id-test/${v.id}`, {
              payload: { n: Schema.Number },
              success: Schema.Number,
              body: ({ n }) => Node.succeed(n)
            })
            const d1 = yield* Flow.derived.mint(IdFlow, { n: v.a })
            const d2 = yield* Flow.derived.mint(IdFlow, { n: v.a })
            expect(d1).toBe(d2)
            const f1 = yield* Flow.fresh.mint(IdFlow, { n: v.a })
            const f2 = yield* Flow.fresh.mint(IdFlow, { n: v.a })
            expect(f1).not.toBe(f2)
            // Through Flow.layerExecutionIds(Flow.derived)
            const e1 = yield* IdFlow.executionId({ n: v.a }).pipe(
              Effect.provide(Flow.layerExecutionIds(Flow.derived))
            )
            const e2 = yield* IdFlow.executionId({ n: v.a }).pipe(
              Effect.provide(Flow.layerExecutionIds(Flow.derived))
            )
            expect(e1).toBe(e2)
            // Interpreter.childExecutionId determinism
            const c1 = yield* Interpreter.childExecutionId(`p-${v.id}`, "n1", "callee/a", { x: v.a })
            const c2 = yield* Interpreter.childExecutionId(`p-${v.id}`, "n1", "callee/a", { x: v.a })
            const c3 = yield* Interpreter.childExecutionId(`p-${v.id}`, "n2", "callee/a", { x: v.a })
            expect(c1).toBe(c2)
            expect(c1).not.toBe(c3)
            return true
          }

          const StepA = Action.make(`comb/${v.id}/a`, {
            payload: { n: Schema.Number },
            success: Schema.Number,
            error: Schema.String
          })
          const StepB = Action.make(`comb/${v.id}/b`, {
            payload: { n: Schema.Number },
            success: Schema.Number,
            error: Schema.String
          })

          if (v.mode === "unresolved-action") {
            const UnwiredJob = ExternalJob.make(`unwired-ej/${v.id}`, {
              payload: { value: Schema.String },
              handle: Schema.String,
              success: Schema.String,
              probe: { every: "10 millis", max: "20 millis" },
              timeout: "1 second"
            })
            // Graph.inspect + Graph.edges + Graph.diagnostics
            const insp = Graph.inspect(UnwiredJob)
            expect(insp.nodes.length).toBeGreaterThanOrEqual(1)
            expect(Array.isArray(insp.steps)).toBe(true)
            const g = Graph.build(UnwiredJob, { value: v.id })
            expect(Graph.edges(g).length).toBeGreaterThanOrEqual(0)
            expect(Graph.diagnostics(g).length).toBe(0)
            expect(Flow.capabilityCeilings(UnwiredJob.annotations)).toEqual([])

            const layer = layerWired(Interpreter.layer(UnwiredJob))
            const exit = yield* Effect.flatMap(FlowRuntime.FlowRuntime, (rt) =>
              rt.execute(UnwiredJob, { payload: { value: v.id }, executionId: `unw-${v.id}` })
            ).pipe(Effect.exit, Effect.provide(layer))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Interpreter.refusalCode(exit.cause)).toEqual(Option.some("unresolved_action"))
              expect(Interpreter.defectOf(exit.cause)).toBeDefined()
            }
            return true
          }

          if (v.mode === "die-and-defectOf") {
            const DieFlow = Flow.make(`die/${v.id}`, {
              payload: { n: Schema.Number },
              success: Schema.Number,
              error: Schema.String,
              idempotencyKey: ({ n }) => `d-${n}`,
              body: ({ n }) => StepA.call({ n })
            })
            const layer = layerWired(
              Interpreter.layer(DieFlow).pipe(
                Layer.provideMerge(StepA.toLayer(() => Effect.die(new Error(`boom-${v.id}`))))
              )
            )
            const exit = yield* DieFlow.execute({ n: v.a }).pipe(Effect.exit, Effect.provide(layer))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const def = Interpreter.defectOf(exit.cause)
              expect(def).toBeDefined()
              expect(def?.message).toContain(`boom-${v.id}`)
              expect(Interpreter.refusalCode(exit.cause)).toEqual(Option.none())
            }
            return true
          }

          if (v.mode === "interrupt-and-poll") {
            const SlowFlow = Flow.make(`slow/${v.id}`, {
              payload: { n: Schema.Number },
              success: Schema.Json,
              error: WaitFor.WaitForRequestInvalid,
              idempotencyKey: ({ n }) => `s-${n}`,
              body: () => WaitFor.action.call({ name: `wait-${v.id}` })
            })
            const layer = layerWired(Interpreter.layer(SlowFlow).pipe(Layer.provideMerge(WaitFor.layer)))
            yield* Effect.gen(function*() {
              const execId = yield* SlowFlow.executionId({ n: v.a })
              yield* SlowFlow.execute({ n: v.a }, { discard: true })
              for (let t = 0; t < 15; t++) yield* Effect.yieldNow
              yield* SlowFlow.interrupt(execId)
              for (let t = 0; t < 15; t++) yield* Effect.yieldNow
              const polled = yield* SlowFlow.poll(execId)
              expect(Option.isSome(polled)).toBe(true)
            }).pipe(Effect.provide(layer))
            return true
          }

          // all-race-branch-catch
          const CombFlow = Flow.make(`comb/${v.id}/flow`, {
            payload: { a: Schema.Number, b: Schema.Number, flag: Schema.Boolean },
            success: Schema.Number,
            error: Schema.String,
            capabilities: ["fs:read"],
            idempotencyKey: ({ a, b, flag }) => `${a}:${b}:${flag}`,
            body: ({ a, b, flag }) => {
              const caught = StepA.call({ n: a }).pipe(
                Node.catch({ error: Schema.String, onFailure: () => Node.succeed(a * 2) })
              )
              const raced = Node.race({ l: StepB.call({ n: b }), r: Node.succeed(b + 1) })
              return Node.all({ c: caught, r: raced }).pipe(
                Node.branch({
                  if: () => flag,
                  then: (pair) => Node.succeed(pair).pipe(Node.map(({ c, r }) => c + r)),
                  else: (pair) => Node.succeed(pair).pipe(Node.map(({ c, r }) => c - r))
                })
              )
            }
          })
          expect(Flow.capabilityCeilings(CombFlow.annotations)).toEqual([["fs:read"]])
          const g = Graph.build(CombFlow, { a: v.a, b: v.b, flag: v.branchFlag })
          expect(Graph.nodes(g).length).toBeGreaterThanOrEqual(2)
          expect(Graph.edges(g).length).toBeGreaterThanOrEqual(1)

          const layer = layerWired(
            Interpreter.layer(CombFlow).pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  StepA.toLayer(({ n }) => (v.failFirst ? Effect.fail("err-a") : Effect.succeed(n + 1))),
                  StepB.toLayer(({ n }) => Effect.succeed(n + 1))
                )
              )
            )
          )
          const res = yield* CombFlow.execute({ a: v.a, b: v.b, flag: v.branchFlag }).pipe(Effect.provide(layer))
          const expectedC = v.failFirst ? v.a * 2 : v.a + 1
          const expectedR = v.b + 1
          expect(res).toBe(v.branchFlag ? expectedC + expectedR : expectedC - expectedR)
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 10, executions: Math.max(ioExecutions, 40) }
    )
  })
})
