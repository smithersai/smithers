import { Flow, Node } from "@smthrs/core"
import * as TestRuntime from "@smthrs/core/TestRuntime"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Bounded from "../src/Bounded.ts"
import * as CheckSuite from "../src/CheckSuite.ts"
import * as Debate from "../src/Debate.ts"
import * as DelegationChain from "../src/DelegationChain.ts"
import * as DriftDetector from "../src/DriftDetector.ts"
import * as Escalation from "../src/Escalation.ts"
import * as Kanban from "../src/Kanban.ts"
import * as Loop from "../src/Loop.ts"
import * as MapReduce from "../src/MapReduce.ts"
import * as MergeQueue from "../src/MergeQueue.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import * as ScanFixVerify from "../src/ScanFixVerify.ts"
import * as Sidecar from "../src/Sidecar.ts"
import * as Supervisor from "../src/Supervisor.ts"
import * as Trellis from "../src/Trellis.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"

type UnknownFlow = Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, never>

const flow = (name: string, answer: (input: unknown) => unknown): UnknownFlow =>
  Flow.make({
    name,
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => Node.succeed(answer(input))
  })

const body = (declaration: Flow.Any, input: unknown): Node.Any => {
  const implementation = (declaration as UnknownFlow).body
  if (implementation === undefined) throw new Error("declaration has no body")
  return implementation(input)
}

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const evaluate = (declaration: Flow.Any, input: unknown): unknown =>
  value(TestRuntime.evaluateInline(body(declaration, input)))

describe("pattern declaration execution", () => {
  it("executes batched merge and ordering callbacks through their real AST", () => {
    expect(value(TestRuntime.evaluate(Bounded.all({
      a: Node.succeed("a"),
      b: Node.succeed("b"),
      c: Node.succeed("c")
    }, { concurrency: 1 })))).toEqual({ a: "a", b: "b", c: "c" })

    const check = flow("check", (input) => ({
      ok: (input as { readonly check: string }).check !== "typecheck"
    }))
    expect(evaluate(
      CheckSuite.make({
        checks: { lint: check, typecheck: check, test: check },
        strategy: "all-pass",
        concurrency: 1,
        continueOnFail: false
      }),
      "head"
    )).toEqual({
      passed: ["lint", "test"],
      failed: ["typecheck"],
      errors: {},
      strategy: "all-pass",
      verdict: false
    })

    const card = flow("card", (input) => (input as { readonly item: { readonly id: string } }).item.id)
    const board = evaluate(
      Kanban.make({
        columns: [{ name: "build", flow: card }],
        items: [{ id: "a" }, { id: "b" }, { id: "c" }],
        concurrency: 1
      }),
      "sprint"
    ) as Record<string, unknown>
    expect(Object.keys(board)).toEqual(["a", "b", "c"])

    const map = flow("map", (input) => (input as { readonly index: number }).index)
    const reduce = flow("reduce", (input) => (input as { readonly mapped: ReadonlyArray<number> }).mapped)
    expect(evaluate(MapReduce.make({ map, reduce, concurrency: 2, onEmpty: "reduce" }), {
      shards: ["c", "a", "b"]
    })).toEqual([0, 1, 2])

    const land = flow("land", (input) => (input as { readonly id: string }).id)
    expect(evaluate(
      MergeQueue.make({
        members: [
          { id: "a", flow: land },
          { id: "b", flow: land },
          { id: "c", flow: land }
        ],
        concurrency: 2,
        failurePolicy: "quarantine"
      }),
      "main"
    )).toEqual({ a: "a", b: "b", c: "c" })

    const scan = flow("scan", () => ["a", "b", "c"])
    const fix = flow("fix", (input) => (input as { readonly index: number }).index)
    const verify = flow("verify", () => "checked")
    expect(evaluate(
      ScanFixVerify.make({
        scan,
        fix,
        verify,
        maxRetries: 1,
        maxIssues: 3,
        concurrency: 2
      }),
      "tree"
    )).toEqual({
      iterations: 1,
      remaining: ["a", "b", "c"],
      resolved: false,
      verifications: ["checked"]
    })

    const plan = flow("plan", () => "plan")
    const worker = flow("worker", (input) => (input as { readonly task: { readonly id: string } }).task.id)
    const review = flow("review", () => true)
    const finalize = flow("finalize", (input) => (input as { readonly results: unknown }).results)
    expect(evaluate(
      Supervisor.make({
        plan,
        workers: { coder: worker },
        review,
        finalize,
        maxRounds: 1,
        concurrency: 2
      }),
      {
        tasks: [
          { id: "a", workerType: "coder" },
          { id: "b", workerType: "coder" },
          { id: "c", workerType: "coder" }
        ]
      }
    )).toEqual({ a: "a", b: "b", c: "c" })

    let reviewRound = 0
    const unfinishedThenDone = flow("unfinished-then-done", () => ++reviewRound === 1 ? null : true)
    expect(evaluate(
      Supervisor.make({
        plan,
        workers: { coder: worker },
        review: unfinishedThenDone,
        finalize,
        maxRounds: 2,
        concurrency: 1
      }),
      { tasks: [{ id: "a", workerType: "coder" }] }
    )).toEqual({ a: "a" })

    const leaf = flow("leaf", (input) => (input as Trellis.Leaf).goal)
    expect(value(TestRuntime.evaluateInline(Trellis.compile({
      parallel: [
        { agent: { goal: "zero" } },
        { agent: { goal: "one" } },
        { agent: { goal: "two" } }
      ]
    }, { leaf })))).toEqual(["zero", "one", "two"])
    expect(value(TestRuntime.evaluateInline(Trellis.compile({
      sequence: [{ agent: { goal: "first" } }, { agent: { goal: "second" } }]
    }, { leaf })))).toEqual(["first", "second"])
  })

  it("executes transcript, alert, scoring, and finalizer maps", () => {
    const proponent = flow(
      "proponent",
      (input) => `p${(input as { readonly transcript: ReadonlyArray<unknown> }).transcript.length}`
    )
    const opponent = flow("opponent", (input) => `o:${(input as { readonly proponent: string }).proponent}`)
    const judge = flow("judge", (input) => (input as { readonly transcript: unknown }).transcript)
    expect(evaluate(Debate.make({ proponent, opponent, judge, rounds: 2 }), "topic")).toEqual([
      { proponent: "p0", opponent: "o:p0" },
      { proponent: "p1", opponent: "o:p1" }
    ])

    const capture = flow("capture", () => "snapshot")
    const compare = flow("compare", () => ({ drifted: true }))
    const alert = flow("alert", () => "paged")
    expect(evaluate(DriftDetector.make({ capture, compare, alert, baseline: "before" }), "target")).toEqual({
      snapshot: "snapshot",
      comparison: { drifted: true },
      alert: "paged"
    })

    const primary = flow("primary", () => "expensive")
    const shadow = flow("shadow", () => "cheap")
    const score = flow("score", () => ({ primary: 0.8, shadow: 0.5 }))
    expect(evaluate(Sidecar.make({ primary, shadow, score }), "prompt")).toEqual({
      primary: "expensive",
      shadow: { quarantined: false, value: "cheap" },
      delta: { primary: 0.8, shadow: 0.5, difference: 0.3, cheaperWins: false }
    })

    const attempt = flow("attempt", () => "value")
    const finalizer = flow("finalizer", () => "cleaned")
    expect(evaluate(TryCatchFinally.make({ try: attempt, finally: finalizer }), "input")).toBe("value")
  })

  it("takes runtime-only declaration branches from real resolved decisions", () => {
    const first = flow("first", () => "first")
    const second = flow("second", () => "second")
    const doNotEscalate = flow("do-not-escalate", () => false)
    expect(evaluate(
      Escalation.make({
        rungs: [{ flow: first, escalateIf: doNotEscalate }, second]
      }),
      "input"
    )).toEqual({ level: 0, result: "first", exhausted: false })

    const accept = flow("accept", () => true)
    expect(evaluate(Escalation.make({ rungs: [first, second], accept }), "input")).toEqual({
      level: 0,
      result: "first",
      exhausted: false
    })

    const loopBody = flow("loop-body", () => "value")
    const until = flow("until", () => true)
    expect(evaluate(Loop.make({ body: loopBody, until, maxIterations: 3 }), "input")).toEqual({
      value: "value",
      iterations: 1,
      exhausted: false
    })

    const produce = flow("produce", () => "draft")
    const approve = flow("approve", () => ({ approved: true }))
    const revise = flow("revise", () => "revised")
    expect(evaluate(ReviewLoop.make({ produce, review: approve, revise, maxRounds: 2 }), "input")).toEqual({
      _tag: "Approved",
      output: "draft"
    })

    const refine = flow("refine", () => "goal")
    const author = flow("author", () => ({ agent: { goal: "leaf" } }))
    const derisk = flow("derisk", () => ({ approved: true }))
    const execute = flow("execute", () => "output")
    const delegationReview = flow("delegation-review", () => ({ approved: true }))
    const settle = flow("settle", (input) => (input as { readonly leaves: unknown }).leaves)
    expect(evaluate(
      DelegationChain.make({
        refine,
        plan: author,
        derisk,
        execute: { weak: execute },
        review: delegationReview,
        settle,
        tierOrder: ["weak"],
        maxDepth: 1,
        maxDeriskRounds: 1,
        maxAttempts: 1
      }),
      "prompt"
    )).toBe("output")
  })
})
