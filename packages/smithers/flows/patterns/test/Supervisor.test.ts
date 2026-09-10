import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as TestRuntime from "@smthrs/core/TestRuntime"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Supervisor from "../src/Supervisor.ts"

const step = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const literal = (node: Graph.GraphNode): Record<string, unknown> => {
  const first = node.keyMaterial.inputs[0]
  if (first === undefined || first._tag !== "Literal") return {}
  const value = first.value
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

const phase = (node: Graph.GraphNode): unknown => literal(node).phase

const calls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall")

const inPhase = (graph: Graph.Graph, name: string): ReadonlyArray<Graph.GraphNode> =>
  calls(graph).filter((node) => phase(node) === name)

const plan = {
  tasks: [
    { id: "a", workerType: "coder" },
    { id: "b", workerType: "coder" },
    { id: "c", workerType: "tester" }
  ]
}

const goal = { goal: "ship the feature", tasks: plan.tasks }

describe("Supervisor", () => {
  it("declares one worker call per plan task per round and a single finalize", () => {
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: step, tester: step },
      review: step,
      finalize: step,
      maxRounds: 3,
      concurrency: 2
    })

    expect(Flow.isFlow(supervisor)).toBe(true)
    const graph = Graph.build(supervisor, goal)
    expect(calls(graph)).toHaveLength(14)
    expect(inPhase(graph, "plan")).toHaveLength(1)
    expect(inPhase(graph, "work")).toHaveLength(9)
    expect(inPhase(graph, "review")).toHaveLength(3)
    expect(inPhase(graph, "finalize")).toHaveLength(1)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("routes each declared worker call to the task's workerType", () => {
    const coder = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: (input) => Node.succeed(input) })
    const tester = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: () => Node.succeed("tested") })
    const workers = { coder, tester }
    const tasks = [
      { id: "a", workerType: "coder" },
      { id: "b", workerType: "tester" },
      { id: "c", workerType: "tester" },
      { id: "d", workerType: "coder" }
    ] as const
    const graph = Graph.build(
      Supervisor.make({
        plan: step,
        workers,
        review: step,
        finalize: step,
        maxRounds: 1,
        concurrency: 3
      }),
      { ...goal, tasks }
    )
    const routed = inPhase(graph, "work").map((node) => literal(node).task)

    expect(routed).toEqual(tasks)
    for (const [index, node] of inPhase(graph, "work").entries()) {
      const expected = calls(Graph.build(workers[tasks[index]!.workerType](literal(node))))[0]!
      expect(node.keyMaterial.body).toEqual(expected.keyMaterial.body)
    }
  })

  it.each([1, 2, 3])("declares every prototype-shaped task id at concurrency %i", (concurrency) => {
    const tasks = ["__proto__", "constructor", "toString"].map((id) => ({ id, workerType: "coder" }))
    const graph = Graph.build(
      Supervisor.make({
        plan: step,
        workers: { coder: step },
        review: step,
        finalize: step,
        maxRounds: 1,
        concurrency
      }),
      { tasks }
    )

    expect(inPhase(graph, "work").map((node) => literal(node).task)).toEqual(tasks)
    expect(calls(graph)).toHaveLength(tasks.length + 3)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it.each([1, 2, 3])("evaluates each task with its selected worker at concurrency %i", (concurrency) => {
    const tasks = [
      { id: "__proto__", workerType: "tester" },
      { id: "constructor", workerType: "coder" },
      { id: "toString", workerType: "tester" }
    ]
    const coder = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: () => Node.succeed("coded") })
    const tester = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: () => Node.succeed("tested") })
    const finalize = Flow.make({
      input: Schema.Unknown,
      output: Schema.Unknown,
      body: (input) => Node.succeed((input as { readonly results: unknown }).results)
    })
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder, tester },
      review: step,
      finalize,
      maxRounds: 1,
      concurrency
    })
    const result = TestRuntime.evaluateInline(supervisor({ tasks }))
    if (Result.isFailure(result)) throw result.failure

    expect(Object.keys(result.success as object)).toEqual(tasks.map((task) => task.id))
    expect(result.success).toEqual({ ["__proto__"]: "tested", constructor: "coded", toString: "tested" })
  })

  it("threads the previous round's review into the next round's worker calls", () => {
    const graph = Graph.build(
      Supervisor.make({
        plan: step,
        workers: { coder: step, tester: step },
        review: step,
        finalize: step,
        maxRounds: 2,
        concurrency: 3
      }),
      goal
    )
    const firstReview = inPhase(graph, "review").find((node) => literal(node).round === 1)
    const second = inPhase(graph, "work").filter((node) => literal(node).round === 2)

    expect(firstReview).toBeDefined()
    expect(second).toHaveLength(3)
    for (const node of second) {
      const refs = node.keyMaterial.inputs.filter((ref) => ref._tag === "Ref" && ref.from === firstReview!.id)
      expect(refs.map((ref) => ref._tag === "Ref" ? ref.path.join(".") : "").sort()).toEqual(["", "retriable"])
    }
    for (const node of inPhase(graph, "work").filter((node) => literal(node).round === 1)) {
      expect(node.keyMaterial.inputs.some((ref) => ref._tag === "Ref" && ref.from === firstReview!.id)).toBe(false)
    }
  })

  it("batches declared worker calls at the concurrency bound", () => {
    const workers = { coder: step, tester: step }
    const wide = Graph.build(
      Supervisor.make({ plan: step, workers, review: step, finalize: step, maxRounds: 1, concurrency: 3 }),
      goal
    )
    const narrow = Graph.build(
      Supervisor.make({ plan: step, workers, review: step, finalize: step, maxRounds: 1, concurrency: 1 }),
      goal
    )

    expect(Graph.nodes(wide).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Graph.nodes(narrow).filter((node) => node.kind === "All")).toHaveLength(3)
    expect(calls(wide)).toHaveLength(calls(narrow).length)
  })

  it("refuses to declare a plan it cannot route", () => {
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: step },
      review: step,
      finalize: step,
      maxRounds: 1,
      concurrency: 1
    })

    expect(() => Graph.build(supervisor, "ship the feature")).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor input must contain a tasks array"
      })
    )
    expect(() => Graph.build(supervisor, { tasks: [] })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor input must contain at least one task"
      })
    )
    expect(() => Graph.build(supervisor, { tasks: [{ id: "a" }] })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor tasks must each carry a string id and a string workerType"
      })
    )
    expect(() =>
      Graph.build(supervisor, { tasks: [{ id: "a", workerType: "coder" }, { id: "a", workerType: "coder" }] })
    )
      .toThrow(expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor task ids must be unique"
      }))
    expect(() => Graph.build(supervisor, { tasks: [{ id: "a", workerType: "painter" }] })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor has no worker named \"painter\""
      })
    )
  })

  it("rejects invalid bounds", () => {
    expect(() =>
      Supervisor.make({
        plan: step,
        workers: { coder: step },
        review: step,
        finalize: step,
        maxRounds: 0,
        concurrency: 1
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "Supervisor maxRounds must be a positive safe integer"
    }))
    expect(() =>
      Supervisor.make({
        plan: step,
        workers: { coder: step },
        review: step,
        finalize: step,
        maxRounds: 1,
        concurrency: 0
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "Supervisor concurrency must be a positive safe integer"
    }))
    expect(() =>
      Supervisor.make({
        plan: step,
        workers: {},
        review: step,
        finalize: step,
        maxRounds: 1,
        concurrency: 1
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "Supervisor requires at least one worker"
    }))
  })

  it.effect("re-delegates only the retriable tasks and finalizes every output", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      const reviews = [{ allDone: false, retriable: ["b"] }, { allDone: true, retriable: [] }]
      let bFailures = 0

      const result = yield* Supervisor.run("goal", {
        maxRounds: 3,
        concurrency: 2,
        plan: () => Effect.succeed(plan),
        worker: ({ round, task }) =>
          Effect.suspend(() => {
            attempts.push(`${round}:${task.id}`)
            if (task.id === "b" && bFailures === 0) {
              bFailures += 1
              return Effect.fail("b exploded")
            }
            return Effect.succeed(`${task.id}-done`)
          }),
        review: ({ round }) => Effect.succeed(reviews[round - 1]!),
        finalize: ({ results }) =>
          Effect.succeed(results.map((outcome) => outcome._tag === "Done" ? outcome.output : `${outcome.id}-failed`))
      })

      expect(attempts).toEqual(["1:a", "1:b", "1:c", "2:b"])
      expect(result.exhausted).toBe(false)
      expect(result).toMatchObject({ rounds: 2, final: ["a-done", "b-done", "c-done"] })
    }))

  it.effect("reports the last review as exhausted when the round bound is reached", () =>
    Effect.gen(function*() {
      let finalized = 0
      const review = { allDone: false, retriable: ["a", "b", "c"] }

      const result = yield* Supervisor.run("goal", {
        maxRounds: 2,
        concurrency: 3,
        plan: () => Effect.succeed(plan),
        worker: ({ task }) => Effect.succeed(`${task.id}-done`),
        review: () => Effect.succeed(review),
        finalize: () =>
          Effect.sync(() => {
            finalized += 1
            return "never"
          })
      })

      expect(result).toEqual({ exhausted: true, rounds: 2, review })
      expect(finalized).toBe(0)
    }))

  it.effect("stops when an unfinished review names nothing to re-delegate", () =>
    Effect.gen(function*() {
      const review = { allDone: false, retriable: [] }
      const rounds: Array<number> = []

      const result = yield* Supervisor.run("goal", {
        maxRounds: 5,
        concurrency: 3,
        plan: () => Effect.succeed(plan),
        worker: ({ round, task }) =>
          Effect.suspend(() => {
            rounds.push(round)
            return Effect.succeed(`${task.id}-done`)
          }),
        review: () => Effect.succeed(review),
        finalize: () => Effect.succeed("never")
      })

      expect(result).toEqual({ exhausted: true, rounds: 1, review })
      expect(rounds).toEqual([1, 1, 1])
    }))

  it.effect("never runs more workers at once than the concurrency bound", () =>
    Effect.gen(function*() {
      // The test holds every started worker on `held`, so the round cannot make
      // progress on its own: what runs concurrently is what the bound admits,
      // not what the scheduler happened to interleave.
      const held = yield* Latch.make()
      const saturated = yield* Latch.make()
      const entered: Array<string> = []
      let inFlight = 0
      let peak = 0

      const running = yield* Supervisor.run("goal", {
        maxRounds: 1,
        concurrency: 2,
        plan: () =>
          Effect.succeed({
            tasks: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, workerType: "coder" }))
          }),
        worker: ({ task }) =>
          Effect.gen(function*() {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            entered.push(task.id)
            if (entered.length === 2) yield* Latch.open(saturated)
            yield* Latch.await(held)
            inFlight -= 1
            return "ok"
          }),
        review: () => Effect.succeed({ allDone: true, retriable: [] }),
        finalize: () => Effect.succeed("done")
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(saturated)

      // Both slots are taken and neither can finish, so no third worker started.
      expect(entered).toEqual(["a", "b"])
      expect(inFlight).toBe(2)

      yield* Latch.open(held)
      const result = yield* Fiber.join(running)

      expect(result).toEqual({ exhausted: false, rounds: 1, final: "done" })
      expect(entered).toEqual(["a", "b", "c", "d", "e", "f"])
      expect(peak).toBe(2)
    }))

  it.effect("propagates a worker defect instead of capturing it as a Failed outcome", () =>
    Effect.gen(function*() {
      const defect = new Error("the worker threw")
      const exit = yield* Effect.exit(
        Supervisor.run("goal", {
          maxRounds: 1,
          concurrency: 2,
          plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }, { id: "b", workerType: "coder" }] }),
          worker: ({ task }) => task.id === "b" ? Effect.die(defect) : Effect.succeed(`${task.id}-done`),
          review: () => Effect.succeed({ allDone: true }),
          finalize: ({ results }) => Effect.succeed(results)
        })
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // Only a typed failure is an outcome the review can read. A defect is a
        // broken worker, so it fails the supervision as it would any other join.
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
      }
    }))

  it.effect("rejects a plan whose task ids repeat instead of reviewing one outcome twice", () =>
    Effect.gen(function*() {
      let ran = 0

      const failure = yield* Supervisor.run("goal", {
        maxRounds: 2,
        concurrency: 2,
        plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }, { id: "a", workerType: "coder" }] }),
        worker: () =>
          Effect.sync(() => {
            ran += 1
            return "ok"
          }),
        review: () => Effect.succeed({ allDone: true }),
        finalize: () => Effect.succeed("done")
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect((failure as PatternError).code).toBe("invalid_input")
      expect((failure as PatternError).message).toBe("Supervisor task ids must be unique")
      expect(ran).toBe(0)
    }))

  it.effect("rejects an empty runtime plan through the typed channel", () =>
    Effect.gen(function*() {
      let callbacks = 0
      const failure = yield* Supervisor.run("goal", {
        maxRounds: 2,
        concurrency: 1,
        plan: () => Effect.succeed({ tasks: [] }),
        worker: () => Effect.sync(() => (callbacks += 1, "ok")),
        review: () => Effect.sync(() => (callbacks += 1, { allDone: true })),
        finalize: () => Effect.sync(() => (callbacks += 1, "done"))
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect((failure as PatternError).code).toBe("invalid_input")
      expect((failure as PatternError).message).toBe("Supervisor input must contain at least one task")
      expect(callbacks).toBe(0)
    }))

  it.effect("rejects malformed runtime plans through the typed channel", () =>
    Effect.gen(function*() {
      const malformedPlans: ReadonlyArray<unknown> = [{ tasks: "nope" }, {}]
      for (const malformed of malformedPlans) {
        let callbacks = 0
        const failure = yield* Supervisor.run("goal", {
          maxRounds: 2,
          concurrency: 1,
          plan: () => Effect.succeed(malformed as Supervisor.Plan),
          worker: () => Effect.sync(() => (callbacks += 1, "ok")),
          review: () => Effect.sync(() => (callbacks += 1, { allDone: true })),
          finalize: () => Effect.sync(() => (callbacks += 1, "done"))
        }).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(PatternError)
        expect((failure as PatternError).code).toBe("invalid_input")
        expect((failure as PatternError).message).toBe("Supervisor input must contain a tasks array")
        expect(callbacks).toBe(0)
      }
    }))

  it.effect("rejects invalid runtime bounds", () =>
    Effect.gen(function*() {
      const failure = yield* Supervisor.run("goal", {
        maxRounds: 0,
        concurrency: 1,
        plan: () => Effect.succeed(plan),
        worker: () => Effect.succeed("ok"),
        review: () => Effect.succeed({ allDone: true }),
        finalize: () => Effect.succeed("done")
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Supervisor maxRounds and concurrency must be positive safe integers")
    }))

  it.effect("ignores malformed retriable values without re-delegating", () =>
    Effect.gen(function*() {
      const reviews: ReadonlyArray<unknown> = [null, { retriable: "a" }, { retriable: [1, false] }]

      for (const review of reviews) {
        let workers = 0
        const result = yield* Supervisor.run("goal", {
          maxRounds: 2,
          concurrency: 1,
          plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }] }),
          worker: () =>
            Effect.sync(() => {
              workers += 1
              return "done"
            }),
          review: () => Effect.succeed(review),
          finalize: () => Effect.succeed("unused")
        })

        expect(result).toEqual({ exhausted: true, rounds: 1, review })
        expect(workers).toBe(1)
      }
    }))

  it("gives two concurrency bounds different step identity at the same topology", () => {
    const material = (concurrency: number) =>
      Graph.nodes(Graph.build(
        Supervisor.make({
          plan: step,
          workers: { coder: step },
          review: step,
          finalize: step,
          maxRounds: 1,
          concurrency
        }),
        { goal: "ship the feature", tasks: [{ id: "a", workerType: "coder" }] }
      ))

    const one = material(1)
    const two = material(2)

    expect(one.map((node) => node.kind)).toEqual(two.map((node) => node.kind))
    expect(one.map((node) => node.keyMaterial.body)).not.toEqual(two.map((node) => node.keyMaterial.body))
  })

  it("declares from the snapshot make took of its options", () => {
    const other = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: () => Node.succeed("other") })
    const workers: Record<string, Flow.Any> = { coder: step, tester: step }
    const options = { plan: step, workers, review: step, finalize: step, maxRounds: 2, concurrency: 2 }
    const supervisor = Supervisor.make(options)
    const before = Graph.nodes(Graph.build(supervisor, goal)).map((node) => node.keyMaterial.body)

    // Every edit a caller can make after the call: a swapped worker, a removed
    // worker the plan still routes to, swapped boss flows, and tighter bounds.
    workers.coder = other
    delete workers.tester
    options.plan = other
    options.review = other
    options.finalize = other
    options.maxRounds = 1
    options.concurrency = 1

    const after = Graph.nodes(Graph.build(supervisor, goal))
    expect(after.map((node) => node.keyMaterial.body)).toEqual(before)
    expect(inPhase(Graph.build(supervisor, goal), "work")).toHaveLength(6)
  })

  it.effect("runs the snapshot run took of its callbacks", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const options = {
        maxRounds: 1,
        concurrency: 1,
        plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }] }),
        worker: ({ task }: { readonly task: Supervisor.Task }) =>
          Effect.sync(() => (trace.push(`work ${task.id}`), "done")),
        review: () => Effect.succeed({ allDone: true, retriable: [] }),
        finalize: () => Effect.succeed("final")
      }
      const supervision = Supervisor.run("goal", options)

      // A swapped worker, a swapped finalizer, and a widened round bound,
      // between the call and the execution.
      options.worker = () => Effect.sync(() => (trace.push("swapped"), "swapped"))
      options.finalize = () => Effect.succeed("swapped")
      options.maxRounds = 5

      const result = yield* supervision
      expect(trace).toEqual(["work a"])
      expect(result).toEqual({ exhausted: false, rounds: 1, final: "final" })
    }))
})
