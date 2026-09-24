import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Kanban from "../src/Kanban.ts"
import { PatternError } from "../src/PatternError.ts"
import { execute } from "./Execute.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

// One card declaration, taking the payload a column hands a card, plus the
// completion payload. Counting calls by tag is what the old `FlowCall` count
// meant.
const card = (tag: string, answer: (payload: any) => Node.Node<unknown, unknown, any>) =>
  Flow.make(tag, {
    payload: {
      column: Schema.Unknown,
      item: Schema.Unknown,
      previous: Schema.Unknown,
      items: Schema.Unknown,
      board: Schema.Unknown
    },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: answer
  })

const step = card("card", ({ item }) => Node.succeed(item))
const completion = card("complete", (payload) => Node.succeed(payload))

const items = [{ id: "a" }, { id: "b" }, { id: "c" }]
const columns = [{ name: "triage", flow: step }, { name: "build", flow: step }]

const sprint = { input: "sprint" }

// A recording action, because what a column call is HANDED is a run-time fact:
// the graph carries a planned reference where `run` passes a real predecessor.
const probePayload = {
  column: Schema.optional(Schema.Unknown),
  item: Schema.optional(Schema.Unknown),
  previous: Schema.optional(Schema.Unknown),
  items: Schema.optional(Schema.Unknown),
  board: Schema.optional(Schema.Unknown)
}

const probed: Array<unknown> = []

const probe = Action.make("kanban/probe", {
  payload: Schema.Struct(probePayload),
  success: Schema.Unknown,
  error: Schema.Never,
  tier: "irreversible"
})

const probeLayer = probe.toLayer((payload) =>
  Effect.sync(() => {
    const seen = Object.fromEntries(
      Object.entries(payload as Record<string, unknown>).filter(([, value]) => value !== undefined)
    )
    probed.push(seen)
    const column = (seen as { readonly column?: string }).column
    const previous = (seen as { readonly previous?: number }).previous
    return column === undefined ? seen : (previous ?? 4) + 1
  })
)

const probing = card("probing", (payload) => probe.call(payload))

describe("Kanban", () => {
  it("unwraps a successful scalar predecessor in an executed declaration", async () => {
    const first = card("one", () => Node.succeed(5))
    const second = card("two", ({ previous }) => Node.map(Node.succeed(previous), (value) => (value as number) + 1))
    const declaration = Kanban.make({
      items: [{ id: "a" }],
      columns: [{ name: "one", flow: first }, { name: "two", flow: second }],
      concurrency: 1
    })

    expect(await execute(declaration, sprint, "kanban-scalar-previous")).toEqual({
      board: { a: { one: 5, two: 6 } },
      completed: ["a"],
      failed: [],
      iterations: 1
    })
    expect(Graph.diagnostics(Graph.build(declaration, sprint))).toEqual([])
  })

  it.effect("declares the payloads it executes", () =>
    Effect.gen(function*() {
      const executed: Array<unknown> = []
      const declared: Array<unknown> = []
      const result = yield* Kanban.run<Kanban.Item, number>(items, {
        concurrency: 2,
        columns: columns.map(({ name }) => ({
          name,
          run: (input) => Effect.sync(() => (executed.push(input), (input.previous ?? 4) + 1))
        })),
        onComplete: (input) => Effect.sync(() => executed.push(input))
      })
      const declaration = Kanban.make({
        columns: columns.map(({ name }) => ({ name, flow: probing })),
        items,
        concurrency: 2,
        onComplete: probing
      })
      probed.length = 0
      yield* Effect.promise(() => execute(declaration, sprint, "kanban-payloads", probeLayer))
      declared.push(...probed)

      expect(declared.slice(0, -1)).toEqual(executed.slice(0, -1))
      expect(declared.at(-1)).toEqual({ items, board: result })
      expect(declared).toEqual(executed)
    }))

  it.effect("drops a rejected card from later columns and settles the same board as run", () =>
    Effect.gen(function*() {
      const previous: Array<unknown> = []
      const declaredColumns = [
        {
          name: "triage",
          flow: card(
            "triage",
            ({ item }: { readonly item: { readonly id: string } }) =>
              item.id === "a" ? Node.fail("triage failed") : Node.succeed(5)
          )
        },
        {
          name: "build",
          flow: card("build", (input: { readonly item: { readonly id: string }; readonly previous: unknown }) => {
            previous.push(input.previous)
            return input.item.id === "b" ? Node.fail("build failed") : Node.succeed(6)
          })
        }
      ]
      const declaration = Kanban.make({ columns: declaredColumns, items, concurrency: 2, onComplete: completion })
      const evaluated = yield* Effect.promise(() => execute(declaration, sprint, "kanban-quarantine"))
      const result = yield* Kanban.run<Kanban.Item, number, string>(items, {
        concurrency: 2,
        columns: [
          { name: "triage", run: ({ item }) => item.id === "a" ? Effect.fail("triage failed") : Effect.succeed(5) },
          { name: "build", run: ({ item }) => item.id === "b" ? Effect.fail("build failed") : Effect.succeed(6) }
        ]
      })

      // The predecessor a build card is handed is a planned reference while
      // the graph builds, so what it names is the node, not the value the run
      // produced. The values themselves are asserted by the settlement below.
      expect(previous).toHaveLength(3)
      expect(result).toEqual({
        board: { b: { triage: 5 }, c: { triage: 5, build: 6 } },
        completed: ["c"],
        failed: [{ id: "a", column: "triage", error: "triage failed" }, {
          id: "b",
          column: "build",
          error: "build failed"
        }],
        iterations: 1
      })
      // `onComplete` sees the board, and its own answer is discarded in both
      // forms: the declaration settles to the board `run` returns.
      expect(evaluated).toEqual(result)
    }))

  it("preserves marker-shaped successful values and prototype-shaped board keys", async () => {
    const value = { _tag: "Quarantined", member: "data", error: "ordinary value" }
    const first = card("first", () => Node.succeed(value))
    const second = card("second", ({ previous }: { readonly previous: unknown }) => Node.succeed(previous))
    const declaration = Kanban.make({
      items: [{ id: "__proto__" }],
      columns: [{ name: "__proto__", flow: first }, { name: "constructor", flow: second }],
      concurrency: 1,
      onComplete: completion
    })

    expect(await execute(declaration, sprint, "kanban-marker-shaped")).toEqual({
      board: { ["__proto__"]: { ["__proto__"]: value, constructor: value } },
      completed: ["__proto__"],
      failed: [],
      iterations: 1
    })
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const board = Kanban.make({ columns, items, concurrency: 3, name: "sprint-9", description: "Move every card." })

    expect(board._tag).toBe("sprint-9")
    expect(board.description).toBe("Move every card.")
    expect(Kanban.make({ columns, items, concurrency: 3 }).description).toBeUndefined()
  })

  it("declares one call per item per column", () => {
    const board = Kanban.make({ columns, items, concurrency: 3 })

    expect(Flow.isFlow(board)).toBe(true)
    const graph = Graph.build(board, sprint)
    expect(callsTo(graph, "card")).toHaveLength(6)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("batches a column at the concurrency bound and adds the completion call", () => {
    const graph = Graph.build(Kanban.make({ columns, items, concurrency: 2, onComplete: completion }), sprint)

    expect(callsTo(graph, "card")).toHaveLength(6)
    expect(callsTo(graph, "complete")).toHaveLength(1)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(4)
    // Six maps wrap successful card values in unambiguous quarantine-protocol
    // envelopes, one unwraps predecessors, and one builds the completion board
    // from every column. The two batch merges are gone: a batch's rows are
    // carried on as planned references and assembled once.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Map")).toHaveLength(8)
  })

  it("declares one recovery arm per card so a rejected card leaves its column alone", () => {
    const graph = Graph.build(Kanban.make({ columns, items, concurrency: 3 }), sprint)

    // Three cards through two columns: six calls, six arms. Without them the
    // first rejected card fails its column's join and interrupts every card
    // beside it, which is not the board `run` works.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(6)
    // The value a `Succeed` carries lives on the graph node's payload rather
    // than inside its key material body, which is where core kept it.
    const recovery = Graph.nodes(graph).find((node) => node.id.endsWith("all.a.failure"))
    expect(recovery?.draft.material.body).toMatchObject({ _tag: "Succeed" })
    expect(recovery?.payload).toMatchObject({ _tag: "Quarantined", member: "a" })
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("carries each item's previous column result into the next column", () => {
    const graph = Graph.build(Kanban.make({ columns, items, concurrency: 3 }), sprint)
    const later = callsTo(graph, "card").filter((node) => payloadOf(node).column === "build")

    expect(later).toHaveLength(3)
    for (const node of later) {
      // The predecessor is a planned reference into the earlier column's node,
      // which the graph records as a dependency of this call.
      expect(node.dependencies.length).toBeGreaterThan(0)
    }
  })

  it("rejects an empty board and an invalid concurrency", () => {
    expect(() => Kanban.make({ columns: [], items, concurrency: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Kanban requires at least one column" })
    )
    expect(() => Kanban.make({ columns, items: [], concurrency: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Kanban requires at least one item" })
    )
    expect(() => Kanban.make({ columns, items, concurrency: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Kanban concurrency must be a positive safe integer"
      })
    )
  })

  it("refuses duplicate column names in a declaration", () => {
    let refusal: unknown
    try {
      Kanban.make({
        columns: [{ name: "same", flow: step }, { name: "same", flow: step }],
        items: [{ id: "a" }],
        concurrency: 1
      })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(PatternError)
    expect((refusal as PatternError).code).toBe("invalid_decorator")
    expect((refusal as PatternError).message).toBe("Kanban column names must be unique")
  })

  it.effect("finishes a column for every item before the next column starts", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []

      const result = yield* Kanban.run(items, {
        concurrency: 3,
        columns: columns.map((column) => ({
          name: column.name,
          run: ({ column: name, item, previous }) =>
            Effect.gen(function*() {
              trace.push(`start ${name}:${item.id}`)
              yield* Effect.yieldNow
              trace.push(`end ${name}:${item.id}`)
              return previous === undefined ? name : `${String(previous)}>${name}`
            })
        }))
      })

      expect(trace.indexOf("end triage:a")).toBeLessThan(trace.indexOf("start build:a"))
      expect(trace.indexOf("end triage:c")).toBeLessThan(trace.indexOf("start build:a"))
      expect(result.completed).toEqual(["a", "b", "c"])
      expect(result.board.a).toEqual({ triage: "triage", build: "triage>build" })
      expect(result.failed).toEqual([])
      expect(result.iterations).toBe(1)
    }))

  it.effect("never runs more items at once than the per-column concurrency bound", () =>
    Effect.gen(function*() {
      // The test holds every started item on `held`, so the column cannot make
      // progress on its own: what runs concurrently is what the bound admits,
      // not what the scheduler happened to interleave.
      const held = yield* Latch.make()
      const saturated = yield* Latch.make()
      const entered: Array<string> = []
      let inFlight = 0
      let peak = 0

      const running = yield* Kanban.run([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], {
        concurrency: 2,
        columns: [{
          name: "triage",
          run: ({ item }) =>
            Effect.gen(function*() {
              inFlight += 1
              peak = Math.max(peak, inFlight)
              entered.push(item.id)
              if (entered.length === 2) yield* Latch.open(saturated)
              yield* Latch.await(held)
              inFlight -= 1
              return "ok"
            })
        }]
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(saturated)

      // Both slots are taken and neither can finish, so no third item started.
      expect(entered).toEqual(["a", "b"])
      expect(inFlight).toBe(2)

      yield* Latch.open(held)
      const result = yield* Fiber.join(running)

      expect(result.completed).toEqual(["a", "b", "c", "d"])
      expect(entered).toEqual(["a", "b", "c", "d"])
      expect(peak).toBe(2)
    }))

  it.effect("drops a failed item and lets the rest finish the board", () =>
    Effect.gen(function*() {
      const seen: Array<string> = []

      const result = yield* Kanban.run(items, {
        concurrency: 3,
        columns: columns.map((column) => ({
          name: column.name,
          run: ({ column: name, item }) =>
            Effect.suspend(() => {
              seen.push(`${name}:${item.id}`)
              return item.id === "b" && name === "triage"
                ? Effect.fail("b is blocked")
                : Effect.succeed(name)
            })
        }))
      })

      expect(result.completed).toEqual(["a", "c"])
      expect(result.failed).toEqual([{ id: "b", column: "triage", error: "b is blocked" }])
      expect(seen).toEqual(["triage:a", "triage:b", "triage:c", "build:a", "build:c"])
      expect(result.board.b).toEqual(undefined)
    }))

  it.effect("propagates a card defect instead of dropping the item from the board", () =>
    Effect.gen(function*() {
      const defect = new Error("the card threw")
      const exit = yield* Effect.exit(
        Kanban.run([{ id: "a" }, { id: "b" }], {
          concurrency: 2,
          columns: [{
            name: "triage",
            run: ({ item }) => item.id === "b" ? Effect.die(defect) : Effect.succeed("ok")
          }]
        })
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // A column rejects an item by failing. A defect is not a rejection, so
        // it fails the pass rather than listing the card in `failed`.
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
      }
    }))

  it.effect("does not admit a column appended while a pass is in flight", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const runtimeColumns: Array<Kanban.RuntimeColumn<Kanban.Item, string, never, never>> = []
      const late: Kanban.RuntimeColumn<Kanban.Item, string, never, never> = {
        name: "late",
        run: () => Effect.sync(() => (trace.push("late"), "late-done"))
      }
      runtimeColumns.push({
        name: "first",
        run: () => Effect.sync(() => (trace.push("first"), runtimeColumns.push(late), "first-done"))
      })

      const result = yield* Kanban.run([{ id: "a" }], { columns: runtimeColumns, concurrency: 1 })

      expect(trace).toEqual(["first"])
      expect(result).toEqual({
        board: { a: { first: "first-done" } },
        completed: ["a"],
        failed: [],
        iterations: 1
      })
    }))

  it.effect("materialises prototype-shaped item and column names as own data properties", () =>
    Effect.gen(function*() {
      const names = ["__proto__", "constructor", "toString", "normal"]
      const result = yield* Kanban.run(
        names.map((id) => ({ id })),
        {
          concurrency: 4,
          columns: names.map((name) => ({
            name,
            run: ({ item }) => Effect.succeed(`${item.id}:${name}`)
          }))
        }
      )

      expect(Object.getPrototypeOf(result.board)).toBe(Object.prototype)
      for (const id of names) {
        expect(Object.hasOwn(result.board, id)).toBe(true)
        const row = result.board[id]!
        expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
        for (const column of names) {
          expect(Object.hasOwn(row, column)).toBe(true)
          expect(row[column]).toBe(`${id}:${column}`)
        }
      }
    }))

  it.effect("stops the until loop at maxIterations", () =>
    Effect.gen(function*() {
      let passes = 0

      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 3,
        until: () => false,
        columns: [{
          name: "triage",
          run: () =>
            Effect.sync(() => {
              passes += 1
              return "ok"
            })
        }]
      })

      expect(passes).toBe(3)
      expect(result.iterations).toBe(3)
    }))

  it.effect("evaluates until on the final allowed pass", () =>
    Effect.gen(function*() {
      let calls = 0
      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 1,
        until: () => {
          calls += 1
          return true
        },
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      })

      expect(result.iterations).toBe(1)
      expect(calls).toBe(1)
    }))

  it.effect("evaluates until once per completed pass before stopping on pass two", () =>
    Effect.gen(function*() {
      let calls = 0
      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 3,
        until: () => {
          calls += 1
          return calls === 2
        },
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      })

      expect(result.iterations).toBe(2)
      expect(calls).toBe(2)
    }))

  it.effect("stops the until loop as soon as the predicate holds", () =>
    Effect.gen(function*() {
      let passes = 0

      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 5,
        until: (board) => board.iterations === 2,
        columns: [{
          name: "triage",
          run: () =>
            Effect.sync(() => {
              passes += 1
              return "ok"
            })
        }]
      })

      expect(passes).toBe(2)
      expect(result.iterations).toBe(2)
    }))

  it.effect("runs maxIterations passes when no predicate is given", () =>
    Effect.gen(function*() {
      let passes = 0
      const column = {
        name: "triage",
        run: () =>
          Effect.sync(() => {
            passes += 1
            return "ok"
          })
      }

      const bounded = yield* Kanban.run([{ id: "a" }], { concurrency: 1, maxIterations: 3, columns: [column] })

      expect(passes).toBe(3)
      expect(bounded.iterations).toBe(3)

      passes = 0
      const once = yield* Kanban.run([{ id: "a" }], { concurrency: 1, columns: [column] })

      expect(passes).toBe(1)
      expect(once.iterations).toBe(1)
    }))

  it.effect("calls onComplete exactly once with the final board", () =>
    Effect.gen(function*() {
      const seen: Array<{ readonly items: ReadonlyArray<Kanban.Item>; readonly board: Kanban.Board<string, never> }> =
        []
      const declaredItems = [{ id: "a" }]
      const result = yield* Kanban.run(declaredItems, {
        concurrency: 1,
        maxIterations: 2,
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }],
        onComplete: (input) => Effect.sync(() => seen.push(input))
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual({ items: declaredItems, board: result })

      const without = yield* Kanban.run(declaredItems, {
        concurrency: 1,
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      })
      expect(without).toEqual({
        board: { a: { triage: "ok" } },
        completed: ["a"],
        failed: [],
        iterations: 1
      })
    }))

  it.effect("uses an onComplete failure as the run failure", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Kanban.run([{ id: "a" }], {
          concurrency: 1,
          columns: [{ name: "triage", run: () => Effect.succeed("ok") }],
          onComplete: () => Effect.fail("report failed")
        })
      )

      expect(failure).toBe("report failed")
    }))

  it.effect("rejects an invalid runtime concurrency", () =>
    Effect.gen(function*() {
      const failure = yield* Kanban.run(items, {
        concurrency: 0,
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban concurrency must be a positive safe integer")
    }))

  it("rejects duplicate item ids", () => {
    expect(() => Kanban.make({ columns, items: [{ id: "a" }, { id: "a" }], concurrency: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Kanban item ids must be unique" })
    )
  })

  it.effect("rejects duplicate item ids at runtime instead of collapsing the board", () =>
    Effect.gen(function*() {
      let ran = 0

      const failure = yield* Kanban.run([{ id: "a" }, { id: "a" }], {
        concurrency: 2,
        columns: [{
          name: "triage",
          run: () =>
            Effect.sync(() => {
              ran += 1
              return "ok"
            })
        }]
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban item ids must be unique")
      expect(ran).toBe(0)
    }))

  it.effect("refuses duplicate column names at runtime before a column runs", () =>
    Effect.gen(function*() {
      let ran = 0
      const duplicate = {
        name: "same",
        run: () => Effect.sync(() => (ran += 1, "ok"))
      }
      const failure = yield* Effect.flip(
        Kanban.run([{ id: "a" }], { concurrency: 1, columns: [duplicate, duplicate] })
      )

      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban column names must be unique")
      expect(ran).toBe(0)
    }))

  it.effect("refuses an empty runtime board before a column runs", () =>
    Effect.gen(function*() {
      let ran = 0
      const failure = yield* Effect.flip(
        Kanban.run([], {
          concurrency: 1,
          columns: [{ name: "triage", run: () => Effect.sync(() => (ran += 1, "ok")) }]
        })
      )

      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban requires at least one item")
      expect(ran).toBe(0)
    }))

  it.effect("refuses an unbounded until loop and an invalid bound", () =>
    Effect.gen(function*() {
      const column = { name: "triage", run: () => Effect.succeed("ok") }

      const unbounded = yield* Kanban.run(items, {
        concurrency: 1,
        until: () => false,
        columns: [column]
      }).pipe(Effect.flip)
      expect(unbounded.code).toBe("invalid_decorator")
      expect(unbounded.message).toBe("Kanban until requires maxIterations")

      const negative = yield* Kanban.run(items, {
        concurrency: 1,
        maxIterations: 0,
        until: () => false,
        columns: [column]
      }).pipe(Effect.flip)
      expect(negative.code).toBe("invalid_decorator")
      expect(negative.message).toBe("Kanban maxIterations must be a positive safe integer")

      const empty = yield* Kanban.run(items, { concurrency: 1, columns: [] }).pipe(Effect.flip)
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("Kanban requires at least one column")
    }))

  it("gives two concurrency bounds different step identity at the same topology", () => {
    const material = (concurrency: number) =>
      Graph.nodes(Graph.build(Kanban.make({ columns, items: [{ id: "a" }], concurrency }), sprint))

    const one = material(1)
    const two = material(2)

    expect(one.map((node) => node.kind)).toEqual(two.map((node) => node.kind))
    expect(one.map((node) => node.draft.material.body)).not.toEqual(two.map((node) => node.draft.material.body))
  })

  it("declares from the snapshot make took of its options", () => {
    const other = card("other", () => Node.succeed("other"))
    const mutableColumns = [{ name: "triage", flow: step }, { name: "build", flow: step }]
    const mutableItems = [{ id: "a" }, { id: "b" }]
    const options = { columns: mutableColumns, items: mutableItems, concurrency: 2, onComplete: completion }
    const board = Kanban.make(options)
    const before = Graph.nodes(Graph.build(board, sprint)).map((node) => node.draft.material.body)

    // Every edit a caller can make after the call: a swapped column flow, an
    // appended column, a renamed item, an appended item, a widened bound, and
    // a swapped completion flow.
    mutableColumns[0]!.flow = other
    mutableColumns.push({ name: "release", flow: other })
    mutableItems[0]!.id = "z"
    mutableItems.push({ id: "c" })
    options.concurrency = 1
    options.onComplete = other

    const after = Graph.nodes(Graph.build(board, sprint))
    expect(after.map((node) => node.draft.material.body)).toEqual(before)
    expect(after.filter((node) => node.kind === "FlowCall")).toHaveLength(6)
  })

  it.effect("runs the snapshot run took of its items and columns", () =>
    Effect.gen(function*() {
      const seen: Array<string> = []
      const column: Kanban.RuntimeColumn<Kanban.Item, string, never, never> = {
        name: "triage",
        run: ({ item }) => Effect.sync(() => (seen.push(item.id), "ok"))
      }
      const mutableItems = [{ id: "a" }]
      const mutableColumns = [column]
      const options = { columns: mutableColumns, concurrency: 1 }
      const board = Kanban.run(mutableItems, options)

      // Every edit a caller can make between the call and the execution: a
      // duplicate id the validation already refused, a swapped column, an
      // appended column, and a widened bound.
      mutableItems.push({ id: "a" })
      mutableColumns[0] = { name: "triage", run: () => Effect.sync(() => (seen.push("swapped"), "swapped")) }
      mutableColumns.push({ name: "late", run: () => Effect.sync(() => (seen.push("late"), "late")) })
      options.concurrency = 5

      const result = yield* board
      expect(seen).toEqual(["a"])
      expect(result).toEqual({ board: { a: { triage: "ok" } }, completed: ["a"], failed: [], iterations: 1 })
    }))

  it.effect("keys the board by the id an item carried when run was called", () =>
    Effect.gen(function*() {
      const item = { id: "a" }
      const board = Kanban.run([item], {
        concurrency: 1,
        columns: [{ name: "triage", run: ({ item: card }) => Effect.succeed(card === item) }]
      })

      // The record itself stays the caller's: the column receives the same
      // object. Its id was read once, so the row keeps the original name.
      item.id = "renamed"

      const result = yield* board
      expect(result.board).toEqual({ a: { triage: true } })
      expect(result.completed).toEqual(["a"])
    }))
})
