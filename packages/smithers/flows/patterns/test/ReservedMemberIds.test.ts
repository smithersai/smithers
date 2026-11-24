/**
 * A check, card or queue member may be named anything, including the names a
 * planned value answers as operations: `then`, `toString`, `valueOf` and
 * `toJSON`. Each batched declaration builds, executes and reports every such
 * member under its own name, exactly as its `run` form does.
 */
import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as CheckSuite from "../src/CheckSuite.vibe"
import * as Kanban from "../src/Kanban.vibe"
import * as MergeQueue from "../src/MergeQueue.vibe"
import { execute } from "./Execute.ts"

const reserved = ["then", "toString", "valueOf", "toJSON", "__proto__", "constructor", "a"]

const check = Flow.make("reserved/check", {
  payload: { check: Schema.Unknown, input: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed({ passed: true })
})

const card = Flow.make("reserved/card", {
  payload: { column: Schema.Unknown, item: Schema.Unknown, previous: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ column, item, previous }) =>
    Node.succeed({ column, id: (item as { readonly id: string }).id, previous: previous ?? null })
})

const land = Flow.make("reserved/land", {
  payload: { id: Schema.Unknown, position: Schema.Unknown, input: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ id }) => Node.succeed(`${id as string}-landed`)
})

describe("reserved member ids", () => {
  for (const continueOnFail of [false, true]) {
    for (const concurrency of [1, 3]) {
      it.effect(`passes every reserved check id (tolerant: ${continueOnFail}, width ${concurrency})`, () =>
        Effect.gen(function*() {
          const suite = CheckSuite.make({
            checks: Object.fromEntries(reserved.map((id) => [id, check])),
            strategy: "all-pass",
            concurrency,
            continueOnFail
          })
          const expected = yield* CheckSuite.run("head", {
            checks: Object.fromEntries(reserved.map((id) => [id, () => Effect.succeed({ passed: true })])),
            strategy: "all-pass",
            concurrency,
            continueOnFail
          })

          expect(expected).toEqual({ passed: reserved, failed: [], errors: {}, strategy: "all-pass", verdict: true })
          expect(
            yield* Effect.promise(() =>
              execute(suite, { input: "head" }, `reserved-check-${continueOnFail}-${concurrency}`)
            )
          ).toEqual(expected)
        }))
    }
  }

  for (const concurrency of [1, 3]) {
    it.effect(`moves every reserved card id across two columns (width ${concurrency})`, () =>
      Effect.gen(function*() {
        const items = reserved.map((id) => ({ id }))
        const columns = ["triage", "build"]
        const board = Kanban.make({ columns: columns.map((name) => ({ name, flow: card })), items, concurrency })
        const settled = (yield* Effect.promise(() =>
          execute(board, { input: "sprint" }, `reserved-kanban-${concurrency}`)
        )) as Kanban.Board<unknown, unknown>
        const expected = yield* Kanban.run(items, {
          concurrency,
          columns: columns.map((name) => ({
            name,
            run: ({ column, item, previous }) =>
              Effect.succeed({ column, id: item.id, previous: previous ?? null })
          }))
        })

        expect(settled.completed).toEqual(reserved)
        expect(settled.failed).toEqual([])
        for (const id of reserved) {
          const triage = { column: "triage", id, previous: null }
          expect(Object.hasOwn(settled.board, id)).toBe(true)
          // The build column saw the same card's triage output, not a
          // neighbour's and not a missing one.
          expect(settled.board[id]).toEqual({ triage, build: { column: "build", id, previous: triage } })
        }
        expect(settled).toEqual(expected)
      }))
  }

  for (const [concurrency, failurePolicy] of [[1, "halt"], [2, "quarantine"], [3, "quarantine"]] as const) {
    it.effect(`lands every reserved member id (${failurePolicy}, width ${concurrency})`, () =>
      Effect.gen(function*() {
        const queue = MergeQueue.make({
          members: reserved.map((id) => ({ id, flow: land })),
          concurrency,
          failurePolicy
        })
        const settled = yield* Effect.promise(() =>
          execute(queue, { input: "main" }, `reserved-queue-${failurePolicy}-${concurrency}`)
        )

        expect(settled).toEqual({
          landed: reserved.map((id) => ({ id, output: `${id}-landed` })),
          quarantined: [],
          order: reserved
        })
      }))
  }

  it("builds every batched declaration without a plan-time refusal", () => {
    const items = reserved.map((id) => ({ id }))
    const graphs = [
      Graph.build(
        CheckSuite.make({
          checks: Object.fromEntries(reserved.map((id) => [id, check])),
          strategy: "all-pass",
          concurrency: 2,
          continueOnFail: true
        }),
        { input: "head" }
      ),
      Graph.build(
        Kanban.make({
          columns: [{ name: "triage", flow: card }, { name: "build", flow: card }],
          items,
          concurrency: 2
        }),
        { input: "sprint" }
      ),
      Graph.build(
        MergeQueue.make({
          members: reserved.map((id) => ({ id, flow: land })),
          concurrency: 2,
          failurePolicy: "quarantine"
        }),
        { input: "main" }
      )
    ]
    for (const graph of graphs) expect(Graph.diagnostics(graph)).toEqual([])
  })
})

describe("generated pattern tags", () => {
  const checks = (ids: ReadonlyArray<string>) => Object.fromEntries(ids.map((id) => [id, check]))

  it("tells a tolerant suite from a fail-fast one", () => {
    const options = { checks: checks(["lint"]), strategy: "all-pass" as const, concurrency: 1 }
    const failFast = CheckSuite.make({ ...options, continueOnFail: false })
    const tolerant = CheckSuite.make({ ...options, continueOnFail: true })

    expect(failFast._tag).toBe("checkSuite(checks=lint, strategy=all-pass, concurrency=1)[reserved/check]")
    expect(tolerant._tag).toBe(
      "checkSuite(checks=lint, strategy=all-pass, concurrency=1, continueOnFail=true)[reserved/check]"
    )
  })

  it("tells check ids that differ only by where a comma falls", () => {
    const options = { strategy: "all-pass" as const, concurrency: 1, continueOnFail: false }
    const left = CheckSuite.make({ ...options, checks: checks(["a,b", "c"]) })
    const right = CheckSuite.make({ ...options, checks: checks(["a", "b,c"]) })

    expect(left._tag).not.toBe(right._tag)
    expect(left._tag).toBe(
      "checkSuite(checks=\"a,b\",c, strategy=all-pass, concurrency=1)[reserved/check, reserved/check]"
    )
  })

  it("tells two boards apart by their card ids, not their card count", () => {
    const columns = [{ name: "triage", flow: card }]
    const one = Kanban.make({ columns, items: [{ id: "a" }, { id: "b" }], concurrency: 1 })
    const other = Kanban.make({ columns, items: [{ id: "c" }, { id: "d" }], concurrency: 1 })

    expect(one._tag).not.toBe(other._tag)
    expect(one._tag).toBe("kanban@2(columns=triage, items=a,b, concurrency=1)[reserved/card, ]")
  })
})
