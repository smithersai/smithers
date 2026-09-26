/**
 * Gates on the in-memory engine: one delivery flow run ungated, behind a human
 * approval, behind a review, and with its gate removed again. The graph is the
 * proof that a gate is a node and an absent gate is not. No model runs: the
 * reviewer is a scripted handler and the approver answers through the same
 * `Gates.answer` call a Slack button or the CLI makes.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, DurableDeferred, Flow, Graph, HumanTask, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Gates from "../src/Gates.ts"
import * as GatesLive from "../src/GatesLive.ts"

const Build = Action.make("test/build", {
  implementationVersion: "build/v1",
  payload: { task: Schema.String },
  success: Schema.Struct({ diff: Schema.String })
})

const Ship = Action.make("test/ship", {
  implementationVersion: "ship/v1",
  payload: { diff: Schema.String },
  success: Schema.String
})

const release: Gates.At = { boundary: "release", target: "test/deliver" }

/** The one flow every variant runs: build, then the release gates, then ship. */
const Deliver = Flow.make("test/deliver", {
  payload: { task: Schema.String, gates: Gates.GatePolicy },
  success: Schema.String,
  error: Gates.GateRefused,
  body: Node.capture({ release }, function(payload) {
    return Build.call({ task: payload.task }).pipe(
      Node.bindPlanned(Node.capture({ gates: payload.gates, release: this.release }, function(built) {
        return Gates.before(this.gates, this.release, { diff: built.diff }, Ship.call({ diff: built.diff }))
      }))
    )
  })
})

const calls = { build: 0, ship: 0, review: 0 }

const actions = Layer.mergeAll(
  Build.toLayer(({ task }) =>
    Effect.sync(() => {
      calls.build++
      return { diff: `diff for ${task}` }
    }), { implementationVersion: "build/v1" }),
  Ship.toLayer(({ diff }) =>
    Effect.sync(() => {
      calls.ship++
      return `shipped ${diff}`
    }), { implementationVersion: "ship/v1" })
)

const engine = (review?: GatesLive.ReviewHandler<never>) =>
  Interpreter.layerWithImplementations(Deliver, Layer.mergeAll(actions, GatesLive.layer({ review }))).pipe(
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

const approvalSpec = {
  _tag: "Approval",
  id: "ship-approval",
  approver: "owner",
  prompt: "Ship it?",
  timeoutMs: 60_000
} as const
const reviewSpec = { _tag: "Review", id: "ship-review", reviewer: "checker" } as const

const ungated = Gates.empty("r1")
const approval: Gates.GatePolicy = { revision: "r2", gates: [{ at: release, spec: approvalSpec }] }
const review: Gates.GatePolicy = { revision: "r3", gates: [{ at: release, spec: reviewSpec }] }
const removed = Gates.empty("r4")

const task = "fix the bug"
const payload = (gates: Gates.GatePolicy) => ({ task, gates })

const actionsIn = (gates: Gates.GatePolicy) =>
  Graph.build(Deliver, payload(gates), { callbackIdentity: "stable" }).nodes.flatMap((node) =>
    node.ast._tag === "ActionCall" ? [node.ast.action] : []
  )

const gateOf = (policy: Gates.GatePolicy, index = 0): Gates.Gate => {
  const entry = policy.gates[index]!
  return { spec: entry.spec as Gates.Gate["spec"], at: entry.at, revision: policy.revision }
}

const subject = { diff: `diff for ${task}` }

const tokenFor = (policy: Gates.GatePolicy, executionId: string, attempt = 1) => {
  const binding = GatesLive.bind(gateOf(policy), subject)
  return {
    binding,
    token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred(binding.question, attempt), {
      flow: Deliver,
      executionId
    })
  }
}

const reset = () => {
  calls.build = 0
  calls.ship = 0
  calls.review = 0
}

/** Gives the engine turns until the execution settles; `running` if it never does. */
const settled = (executionId: string) =>
  Effect.gen(function*() {
    for (let turn = 0; turn < 200; turn++) {
      const polled = yield* Deliver.poll(executionId)
      if (Option.isSome(polled)) return polled.value._tag
      yield* Effect.yieldNow
    }
    return "running"
  })

const refusalOf = <A>(exit: Exit.Exit<A, unknown>): Gates.GateRefused => {
  if (Exit.isSuccess(exit)) throw new Error("the flow passed its gate")
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure) || !(failure.value instanceof Gates.GateRefused)) {
    throw new Error(`the flow failed with something else: ${Cause.pretty(exit.cause)}`)
  }
  return failure.value
}

/** Starts a gated run, checks it parked before shipping, then runs `then`. */
const parkThen = <A, E, R>(
  policy: Gates.GatePolicy,
  executionId: string,
  then: Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    yield* Deliver.execute(payload(policy), { executionId, discard: true })
    expect(yield* settled(executionId)).toBe("Suspended")
    expect(calls.ship).toBe(0)
    return yield* then
  })

describe("the gate graph", () => {
  it("adds no node when the policy is empty, and none after a gate is removed", () => {
    const plain = actionsIn(ungated)
    expect(plain).toEqual(["test/build", "test/ship"])
    expect(actionsIn(removed)).toEqual(plain)
    expect(Graph.build(Deliver, payload(removed)).nodes.map((node) => node.id)).toEqual(
      Graph.build(Deliver, payload(ungated)).nodes.map((node) => node.id)
    )
  })

  it("puts an approval in front of the guarded node", () => {
    expect(actionsIn(approval)).toEqual([
      "test/build",
      "organization/gate-subject",
      "system/human-task",
      "organization/gate-decide",
      "test/ship"
    ])
  })

  it("puts a review in front of the guarded node", () => {
    expect(actionsIn(review)).toEqual([
      "test/build",
      "organization/gate-subject",
      "organization/gate-review",
      "organization/gate-decide",
      "test/ship"
    ])
  })

  it("stacks gates in policy order and ignores other boundaries and targets", () => {
    const stacked: Gates.GatePolicy = {
      revision: "r5",
      gates: [
        { at: { boundary: "release", target: "*" }, spec: reviewSpec },
        { at: release, spec: approvalSpec },
        { at: { boundary: "release", target: "other/flow" }, spec: { ...approvalSpec, id: "other" } },
        { at: { boundary: "task", target: "test/deliver" }, spec: { ...reviewSpec, id: "task-review" } }
      ]
    }
    expect(Gates.select(stacked, release).map((spec) => spec.id)).toEqual(["ship-review", "ship-approval"])
    expect(actionsIn(stacked)).toEqual([
      "test/build",
      "organization/gate-subject",
      "organization/gate-review",
      "organization/gate-decide",
      "organization/gate-subject",
      "system/human-task",
      "organization/gate-decide",
      "test/ship"
    ])
  })

  it("asks without a deadline when the approval names none", () => {
    const { timeoutMs: _, ...open } = approvalSpec
    const node = Gates.before(
      { revision: "r6", gates: [{ at: release, spec: open }] },
      release,
      subject,
      Ship.call(subject)
    )
    const question = Graph.build(node).nodes.find((graphNode) =>
      graphNode.ast._tag === "ActionCall" && graphNode.ast.action === HumanTask.tag
    )
    expect(question?.payload).toMatchObject({ kind: "json", maxAttempts: Gates.approvalAttempts })
    expect(question?.payload).not.toHaveProperty("timeoutMs")
  })

  it("returns the guarded node itself when there is nothing to attach", () => {
    const next = Ship.call({ diff: "d" })
    expect(Gates.before(undefined, release, {}, next)).toBe(next)
    expect(Gates.before(ungated, release, {}, next)).toBe(next)
  })

  it("refuses a kind that cannot run yet while the plan is built", () => {
    const next = Ship.call({ diff: "d" })
    const kinds: ReadonlyArray<Gates.GateSpec> = [
      { _tag: "Budget", id: "b", principal: "builder", tokens: 10 },
      { _tag: "Concurrency", id: "c", key: "k", limit: 1, retryAfterMs: 1_000 },
      { _tag: "Window", id: "w", cron: "0 6 * * 5", timezone: "UTC", openForMinutes: 60 },
      { _tag: "Condition", id: "s", signal: "green" }
    ]
    for (const spec of kinds) {
      const thrown = (() => {
        try {
          Gates.before({ revision: "r", gates: [{ at: release, spec }] }, release, {}, next)
        } catch (error) {
          return error
        }
      })()
      expect(thrown).toBeInstanceOf(Gates.GateUnsupported)
      expect((thrown as Gates.GateUnsupported).message).toBe(
        `${spec._tag} gates are not yet supported; only Approval and Review gates run`
      )
    }
  })

  it("refuses a policy that is only a planned reference", () => {
    const planned = Planned.make<Gates.GatePolicy>("upstream")
    expect(() => Gates.before(planned as unknown as Gates.GatePolicy, release, {}, Ship.call({ diff: "d" })))
      .toThrow("Gates.before needs a concrete policy")
  })

  it("decodes a policy with every kind but runs only two", () => {
    expect(Gates.supportedKinds).toEqual(["Approval", "Review"])
    expect(() =>
      Schema.decodeUnknownSync(Gates.GatePolicy)({
        revision: "r",
        gates: [{ at: release, spec: approvalSpec }, { at: release, spec: approvalSpec }]
      })
    ).toThrow("gate ids must be unique")
  })
})

describe("running the gates", () => {
  it("runs ungated straight through", async () => {
    reset()
    const result = await Effect.runPromise(
      Deliver.execute(payload(ungated), { executionId: "ungated" }).pipe(Effect.provide(engine()))
    )
    expect(result).toBe(`shipped ${subject.diff}`)
    expect(calls).toEqual({ build: 1, ship: 1, review: 0 })
  })

  it("runs straight through again once the gate is removed", async () => {
    reset()
    const result = await Effect.runPromise(
      Deliver.execute(payload(removed), { executionId: "removed" }).pipe(Effect.provide(engine()))
    )
    expect(result).toBe(`shipped ${subject.diff}`)
    expect(calls).toEqual({ build: 1, ship: 1, review: 0 })
  })

  it("parks on a human approval and ships once the owner approves", async () => {
    reset()
    const { binding, token } = tokenFor(approval, "approved")
    const result = await Effect.runPromise(
      Effect.scoped(parkThen(
        approval,
        "approved",
        Effect.gen(function*() {
          yield* Gates.answer({ token, subjectDigest: binding.subjectDigest, approved: true })
          return yield* Deliver.execute(payload(approval), { executionId: "approved" })
        })
      )).pipe(Effect.provide(engine()))
    )
    expect(result).toBe(`shipped ${subject.diff}`)
    expect(calls).toEqual({ build: 1, ship: 1, review: 0 })
  })

  it("stops when the owner declines, and records why", async () => {
    reset()
    const { binding, token } = tokenFor(approval, "declined")
    const exit = await Effect.runPromise(
      Effect.scoped(parkThen(
        approval,
        "declined",
        Effect.gen(function*() {
          yield* Gates.answer({ token, subjectDigest: binding.subjectDigest, approved: false, reason: "not today" })
          return yield* Effect.exit(Deliver.execute(payload(approval), { executionId: "declined" }))
        })
      )).pipe(Effect.provide(engine()))
    )
    const refused = refusalOf(exit)
    expect(refused.record).toMatchObject({
      gateId: "ship-approval",
      kind: "Approval",
      boundary: "release",
      target: "test/deliver",
      revision: "r2",
      subjectDigest: binding.subjectDigest,
      outcome: "denied",
      reason: "not today",
      decidedBy: "owner"
    })
    expect(refused.message).toBe("gate ship-approval denied at release test/deliver")
    expect(calls.ship).toBe(0)
  })

  it("refuses an answer for another subject and asks again", async () => {
    reset()
    const first = tokenFor(approval, "rebound", 1)
    const second = tokenFor(approval, "rebound", 2)
    const result = await Effect.runPromise(
      Effect.scoped(parkThen(
        approval,
        "rebound",
        Effect.gen(function*() {
          yield* Gates.answer({ token: first.token, subjectDigest: "0".repeat(64), approved: true })
          yield* Deliver.execute(payload(approval), { executionId: "rebound", discard: true })
          expect(yield* settled("rebound")).toBe("Suspended")
          expect(calls.ship).toBe(0)
          yield* Gates.answer({ token: second.token, subjectDigest: second.binding.subjectDigest, approved: true })
          return yield* Deliver.execute(payload(approval), { executionId: "rebound" })
        })
      )).pipe(Effect.provide(engine()))
    )
    expect(result).toBe(`shipped ${subject.diff}`)
  })

  it("expires when nobody answers before the deadline; silence is not consent", async () => {
    reset()
    const exit = await Effect.runPromise(
      Effect.scoped(parkThen(
        approval,
        "silent",
        Effect.gen(function*() {
          yield* TestClock.adjust(60_001)
          return yield* Effect.exit(Deliver.execute(payload(approval), { executionId: "silent" }))
        })
      )).pipe(Effect.provide(engine()), Effect.provide(TestClock.layer()))
    )
    expect(refusalOf(exit).record).toMatchObject({ outcome: "expired", reason: "no answer before the deadline" })
    expect(calls.ship).toBe(0)
  })

  it("ships after the reviewer approves", async () => {
    reset()
    const requests: Array<Gates.ReviewRequest> = []
    const approve: GatesLive.ReviewHandler<never> = (request) =>
      Effect.sync(() => {
        calls.review++
        requests.push(request)
        return { decision: "approve", reason: "looks right", reviewer: request.reviewer }
      })
    const result = await Effect.runPromise(
      Deliver.execute(payload(review), { executionId: "reviewed" }).pipe(Effect.provide(engine(approve)))
    )
    expect(result).toBe(`shipped ${subject.diff}`)
    expect(calls).toEqual({ build: 1, ship: 1, review: 1 })
    expect(requests).toEqual([{
      gateId: "ship-review",
      reviewer: "checker",
      boundary: "release",
      target: "test/deliver",
      revision: "r3",
      subject
    }])
  })

  it("stops when the reviewer requests changes", async () => {
    reset()
    const changes: GatesLive.ReviewHandler<never> = (request) =>
      Effect.succeed({ decision: "request-changes", reason: "missing a test", reviewer: request.reviewer })
    const exit = await Effect.runPromise(
      Effect.exit(Deliver.execute(payload(review), { executionId: "changes" })).pipe(
        Effect.provide(engine(changes))
      )
    )
    expect(refusalOf(exit).record).toMatchObject({
      kind: "Review",
      outcome: "denied",
      reason: "missing a test",
      decidedBy: "checker",
      subjectDigest: GatesLive.subjectDigest(gateOf(review), subject)
    })
    expect(calls.ship).toBe(0)
  })

  it("denies a review gate when no reviewer is configured", async () => {
    reset()
    const exit = await Effect.runPromise(
      Effect.exit(Deliver.execute(payload(review), { executionId: "unconfigured" })).pipe(
        Effect.provide(engine())
      )
    )
    expect(refusalOf(exit).record).toMatchObject({ outcome: "denied", reason: "the reviewer produced no verdict" })
    expect(calls.ship).toBe(0)
  })

  it("accepts a reviewer node built by the caller", () => {
    const Custom = Action.make("test/custom-review", {
      payload: Gates.ReviewRequest,
      success: Gates.ReviewVerdict
    })
    const node = Gates.before(review, release, subject, Ship.call({ diff: "d" }), {
      reviewer: (request) => Custom.call(request)
    })
    const names = Graph.build(node).nodes.flatMap((graphNode) =>
      graphNode.ast._tag === "ActionCall" ? [graphNode.ast.action] : []
    )
    expect(names).toContain("test/custom-review")
    expect(names).not.toContain("organization/gate-review")
  })
})

describe("reading a parked approval", () => {
  const question = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      task: "human",
      name: "gate/ship-approval/0123456789abcdef",
      kind: "json",
      prompt: "Ship it?",
      attempt: 1,
      maxAttempts: 3,
      schema: { properties: { subjectDigest: { enum: [`0123456789abcdef${"0".repeat(48)}`] } } },
      ...overrides
    })

  it("names the gate, the subject, and the attempt", () => {
    expect(Gates.pending(question())).toEqual({
      gateId: "ship-approval",
      subjectDigest: `0123456789abcdef${"0".repeat(48)}`,
      prompt: "Ship it?",
      attempt: 1,
      maxAttempts: 3
    })
  })

  it("ignores every other wait", () => {
    expect(Gates.pending("not json")).toBeUndefined()
    expect(Gates.pending(question({ name: "coding-clarification" }))).toBeUndefined()
    expect(Gates.pending(question({ name: "gate/ship-approval/ffffffffffffffff" }))).toBeUndefined()
    expect(Gates.pending(question({ kind: "ask" }))).toBeUndefined()
  })
})

describe("deciding", () => {
  const approvalGate = gateOf(approval)
  const reviewGate = gateOf(review)
  const digest = "a".repeat(64)
  const decide = (gate: Gates.Gate, response: Gates.Response) => GatesLive.decide(gate, digest, response, 7)
  const failure = (code: HumanTask.HumanTaskFailed["code"]) =>
    new HumanTask.HumanTaskFailed({ code, task: "t", attempts: 1, rejections: [], message: "m" })

  it("passes only an approving answer bound to the subject", () => {
    expect(decide(approvalGate, { _tag: "answered", value: { approved: true, subjectDigest: digest } })).toEqual({
      gateId: "ship-approval",
      kind: "Approval",
      boundary: "release",
      target: "test/deliver",
      revision: "r2",
      subjectDigest: digest,
      outcome: "passed",
      decidedBy: "owner",
      decidedAt: 7
    })
    expect(decide(approvalGate, { _tag: "answered", value: { approved: true, subjectDigest: "b".repeat(64) } }))
      .toMatchObject({ outcome: "denied", reason: "the answer was for a different subject" })
    expect(decide(approvalGate, { _tag: "answered", value: "yes" })).toMatchObject({
      outcome: "denied",
      reason: "the answer was malformed"
    })
  })

  it("never treats a missing answer as consent", () => {
    expect(decide(approvalGate, { _tag: "unanswered", failure: failure("timeout") }).outcome).toBe("expired")
    expect(decide(approvalGate, { _tag: "unanswered", failure: failure("rejected") })).toMatchObject({
      outcome: "denied",
      reason: "no acceptable answer"
    })
    expect(decide(approvalGate, { _tag: "unanswered", failure: failure("request_invalid") })).toMatchObject({
      outcome: "denied",
      reason: "the approval question was invalid"
    })
  })

  it("passes only an approving verdict from the configured reviewer", () => {
    const verdict = { decision: "approve", reason: "ok", reviewer: "checker" } as const
    expect(decide(reviewGate, { _tag: "reviewed", verdict })).toMatchObject({ outcome: "passed", decidedBy: "checker" })
    expect(decide(reviewGate, { _tag: "reviewed", verdict: { ...verdict, reviewer: "builder" } })).toMatchObject({
      outcome: "denied",
      reason: "the verdict came from a different reviewer"
    })
  })

  it("denies a response that reached the wrong kind of gate", () => {
    expect(decide(reviewGate, { _tag: "answered", value: { approved: true, subjectDigest: digest } })).toMatchObject({
      outcome: "denied",
      reason: "an answer reached a Review gate"
    })
    expect(
      decide(approvalGate, { _tag: "reviewed", verdict: { decision: "approve", reason: "ok", reviewer: "checker" } })
    ).toMatchObject({ outcome: "denied", reason: "a review reached an Approval gate" })
  })

  it("binds the prompt and question name to the subject digest", () => {
    const binding = GatesLive.bind(approvalGate, subject)
    expect(binding.subjectDigest).toBe(GatesLive.subjectDigest(approvalGate, subject))
    expect(binding.question).toBe(`gate/ship-approval/${binding.subjectDigest.slice(0, 16)}`)
    expect(binding.prompt.startsWith("Ship it?\n\nrelease test/deliver · r2 · ")).toBe(true)
    expect(GatesLive.bind(reviewGate, subject).prompt.startsWith("Review by checker")).toBe(true)
    const long = GatesLive.bind(approvalGate, { text: "x".repeat(GatesLive.maxExcerptLength) })
    expect(long.prompt.endsWith("\n…\n```")).toBe(true)
    expect(GatesLive.subjectDigest({ ...approvalGate, revision: "other" }, subject)).not.toBe(binding.subjectDigest)
  })
})

describe("surviving a restart", () => {
  /** A durable SQLite host over `root`, as a separate process would build it. */
  const host = (root: string, hostId: string) =>
    NodeRuntime.layerHost(
      { filename: join(root, "state", "engine.db"), workspaceRoot: root, owner: { hostId }, signals: [] },
      Interpreter.layerWithImplementations(Deliver, Layer.mergeAll(actions, GatesLive.layer()))
    )

  const waitingRow = (executionId: string) =>
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* state.waiting(executionId)
      if (Option.isNone(row)) return yield* Effect.die("the run is not parked")
      return row.value
    })

  it("parks on an approval, closes the runtime, reopens, answers, and resumes", async () => {
    reset()
    const root = realpathSync(mkdtempSync(join(tmpdir(), "organization-gates-")))
    try {
      const executionId = "restart"
      // First process: build runs, the approval parks, the runtime closes.
      const parked = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          yield* Deliver.execute(payload(approval), { executionId, discard: true })
          for (let turn = 0; turn < 200; turn++) {
            const state = yield* DurableEngineState.DurableEngineState
            if (Option.isSome(yield* state.waiting(executionId))) break
            yield* Effect.sleep(5)
          }
          return yield* waitingRow(executionId)
        }).pipe(Effect.provide(host(root, "first")))
      ))
      expect(parked.reason).toBe("approval")
      expect(calls).toEqual({ build: 1, ship: 0, review: 0 })

      // Second process: read the question off the durable row, answer it the
      // way the CLI or a Slack button does, and resume the same execution.
      const result = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const row = yield* waitingRow(executionId)
          const question = Gates.pending(row.request)!
          expect(question).toMatchObject({ gateId: "ship-approval", attempt: 1, maxAttempts: Gates.approvalAttempts })
          expect(question.subjectDigest).toBe(GatesLive.subjectDigest(gateOf(approval), subject))
          yield* Gates.answer({
            token: Schema.decodeUnknownSync(DurableDeferred.Token)(row.token),
            subjectDigest: question.subjectDigest,
            approved: true
          })
          return yield* Deliver.execute(payload(approval), { executionId })
        }).pipe(Effect.provide(host(root, "second")))
      ))
      expect(result).toBe(`shipped ${subject.diff}`)
      // The build step replayed from the journal; only the ship step ran anew.
      expect(calls).toEqual({ build: 1, ship: 1, review: 0 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
