import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as CheckSuite from "../src/CheckSuite.ts"
import { PatternError } from "../src/PatternError.ts"
import { execute } from "./Execute.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

const checkFlow = (tag: string, answer: () => Node.Node<unknown, unknown, never>) =>
  Flow.make(tag, {
    payload: { check: Schema.Unknown, input: Schema.Unknown },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: answer
  })

const step = checkFlow("check", () => Node.succeed({ ok: true }))

const checks = { lint: step, typecheck: step, test: step }

const head = { input: "head" }

const results = [
  { id: "lint", passed: true },
  { id: "typecheck", passed: true },
  { id: "test", passed: false }
]

describe("CheckSuite", () => {
  for (
    const [passing, total, decided] of [
      [0, 1, false],
      [1, 2, false],
      [2, 4, false],
      [1, 3, false],
      [2, 3, true],
      [1, 1, true]
    ] as const
  ) {
    for (const continueOnFail of [false, true]) {
      it.effect(`requires a strict majority for ${passing}/${total} passes (tolerant: ${continueOnFail})`, () =>
        Effect.gen(function*() {
          const classified = Array.from({ length: total }, (_, index) => ({
            id: `check-${index}`,
            passed: index < passing
          }))
          const expected = {
            passed: classified.slice(0, passing).map(({ id }) => id),
            failed: classified.slice(passing).map(({ id }) => id),
            errors: {},
            strategy: "majority",
            verdict: decided
          }
          const options = { strategy: "majority" as const, concurrency: 2, continueOnFail }
          const suite = CheckSuite.make({
            ...options,
            checks: Object.fromEntries(
              classified.map(({ id, passed }) => [id, checkFlow(`check-${id}`, () => Node.succeed({ passed }))])
            )
          })
          const declared = yield* Effect.promise(() =>
            execute(suite, head, `majority-${passing}-${total}-${continueOnFail}`)
          )

          // Compare complete outcomes for the reducer and both execution paths.
          expect(CheckSuite.verdict(classified, "majority")).toEqual(expected)
          expect(declared).toEqual(expected)
          expect(
            yield* CheckSuite.run("head", {
              ...options,
              checks: Object.fromEntries(classified.map(({ id, passed }) => [id, () => Effect.succeed({ passed })]))
            })
          ).toEqual(expected)
        }))
    }
  }

  it("keeps the caller's name and description on the declared flow", () => {
    const options = { checks, strategy: "all-pass" as const, concurrency: 1, continueOnFail: false }
    const suite = CheckSuite.make({ ...options, name: "ci", description: "Run every gate." })

    expect(suite._tag).toBe("ci")
    expect(suite.description).toBe("Run every gate.")
    expect(CheckSuite.make(options).description).toBeUndefined()
  })

  it("decodes quarantine envelopes only with the documented third argument", () => {
    const values = { test: { _tag: "Succeeded", member: "test", value: { passed: false } } }
    const ids = ["test"]

    expect(CheckSuite.rows(values, ids)).toEqual([{ id: "test", passed: true }])
    expect(CheckSuite.rows(values, ids, false)).toEqual(CheckSuite.rows(values, ids))
    expect(CheckSuite.rows(values, ids, true)).toEqual([{ id: "test", passed: false }])
    expect(CheckSuite.verdict(CheckSuite.rows(values, ids), "all-pass").verdict).toBe(true)
    expect(CheckSuite.verdict(CheckSuite.rows(values, ids, true), "all-pass").verdict).toBe(false)
  })

  for (const error of [new Error("tsc: 14 errors in src/Foo.ts"), "tsc exited 2", undefined, null, false, 0, ""]) {
    it.effect(`retains tolerated errors through rows, make, and run: ${String(error)}`, () =>
      Effect.gen(function*() {
        // A prototype-shaped id must remain an own key in the diagnostics record.
        const id = "__proto__"
        const expected = {
          passed: ["lint"],
          failed: [id],
          errors: { [id]: error },
          strategy: "any-pass",
          verdict: true
        }
        const classified = CheckSuite.rows(
          {
            lint: { _tag: "Succeeded", member: "lint", value: { ok: true } },
            [id]: { _tag: "Quarantined", member: id, error }
          },
          ["lint", id],
          true
        )
        expect(classified).toStrictEqual([{ id: "lint", passed: true }, { id, passed: false, error }])
        const reduced = CheckSuite.verdict(classified, "any-pass")
        expect(reduced).toStrictEqual(expected)
        expect(Object.hasOwn(reduced.errors, id)).toBe(true)
        expect(reduced.errors[id]).toBe(error)

        const options = { strategy: "any-pass" as const, concurrency: 1, continueOnFail: true }
        const suite = CheckSuite.make({
          ...options,
          checks: {
            lint: checkFlow("lint", () => Node.succeed({ ok: true })),
            [id]: checkFlow("boom", () => Node.fail(error))
          }
        })
        if (error instanceof Error) {
          // A plan stores a failure as data. `@smthrs/plan` refuses an `Error`
          // instance outright rather than storing `{}` for it, which is what
          // `@smthrs/core` did. The tolerated-error contract is asserted for
          // every data-valued failure below and by `run` for this one.
          yield* Effect.promise(() =>
            execute(suite, head, `tolerated-${String(error)}`).then(
              () => expect.fail("a plan must refuse an Error instance as a declared failure"),
              (refusal: unknown) =>
                expect(String((refusal as { readonly message?: unknown }).message)).toContain(
                  "unsupported prototype"
                )
            )
          )
        } else {
          const declared = yield* Effect.promise(() => execute(suite, head, `tolerated-${String(error)}`))
          expect(declared).toStrictEqual(expected)
          expect((declared as CheckSuite.Verdict).errors[id]).toStrictEqual(error)
        }

        const executed = yield* CheckSuite.run("head", {
          ...options,
          checks: { lint: () => Effect.succeed({ ok: true }), [id]: () => Effect.fail(error) }
        })
        expect(executed).toStrictEqual(expected)
        expect(Object.hasOwn(executed.errors, id)).toBe(true)
        expect(executed.errors[id]).toBe(error)
      }))
  }

  it("retains failure-row diagnostics without interpreting arbitrary rows as envelopes", () => {
    const values = {
      failure: { error: "3 failing" },
      empty: { error: "" },
      nil: { error: null },
      absent: { error: undefined },
      clear: { error: false }
    }
    const ids = Object.keys(values)
    const expected = [
      { id: "failure", passed: false, error: "3 failing" },
      { id: "empty", passed: false, error: "" },
      { id: "nil", passed: true },
      { id: "absent", passed: true },
      { id: "clear", passed: true }
    ]
    expect(CheckSuite.rows(values, ids)).toStrictEqual(expected)
    expect(CheckSuite.rows(
      Object.fromEntries(
        Object.entries(values).map(([member, value]) => [
          member,
          { _tag: "Succeeded", member, value }
        ])
      ),
      ids,
      true
    )).toStrictEqual(expected)
    expect(CheckSuite.rows({ invalid: { ok: true } }, ["invalid"], true)).toEqual([
      { id: "invalid", passed: false }
    ])
  })

  it("resolves each verdict strategy from the same results", () => {
    expect(CheckSuite.verdict(results, "all-pass")).toEqual({
      passed: ["lint", "typecheck"],
      failed: ["test"],
      errors: {},
      strategy: "all-pass",
      verdict: false
    })
    expect(CheckSuite.verdict(results, "majority").verdict).toBe(true)
    expect(CheckSuite.verdict(results, "any-pass").verdict).toBe(true)
  })

  it("treats an empty suite as unpassed under all-pass and any-pass", () => {
    expect(CheckSuite.verdict([], "all-pass").verdict).toBe(false)
    expect(CheckSuite.verdict([], "any-pass").verdict).toBe(false)
    expect(CheckSuite.verdict([], "majority").verdict).toBe(false)
  })

  it("reads a failure signal out of a check row", () => {
    expect(CheckSuite.passed({ ok: true })).toBe(true)
    expect(CheckSuite.passed(undefined)).toBe(false)
    expect(CheckSuite.passed({ passed: false })).toBe(false)
    expect(CheckSuite.passed({ ok: false })).toBe(false)
    expect(CheckSuite.passed({ failed: true })).toBe(false)
    expect(CheckSuite.passed({ error: "boom" })).toBe(false)
    expect(CheckSuite.passed({ error: false })).toBe(true)
    expect(CheckSuite.passed("done")).toBe(true)
  })

  it("classifies a batch record in declaration order", () => {
    expect(CheckSuite.rows({ test: { ok: false }, lint: { ok: true } }, ["lint", "typecheck", "test"])).toEqual([
      { id: "lint", passed: true },
      { id: "typecheck", passed: false },
      { id: "test", passed: false }
    ])
    expect(CheckSuite.rows("not a record", ["lint"])).toEqual([{ id: "lint", passed: false }])
    expect(CheckSuite.rows({ nil: null, absent: undefined, text: "done" }, ["nil", "absent", "text"]))
      .toEqual([{ id: "nil", passed: false }, { id: "absent", passed: false }, { id: "text", passed: true }])
  })

  it("treats inherited prototype-shaped rows as missing", () => {
    const ids = ["__proto__", "constructor", "toString", "normal"]

    expect(CheckSuite.rows({}, ids)).toEqual(ids.map((id) => ({ id, passed: false })))

    const values = Object.fromEntries(ids.map((id) => [id, { ok: true }]))
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype)
    expect(CheckSuite.rows(values, ids)).toEqual(ids.map((id) => ({ id, passed: true })))
  })

  it("declares one call per check plus the verdict map", () => {
    const suite = CheckSuite.make({ checks, strategy: "all-pass", concurrency: 3, continueOnFail: false })

    expect(Flow.isFlow(suite)).toBe(true)
    const graph = Graph.build(suite, head)
    expect(callsTo(graph, "check")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Graph.nodes(graph).filter((node) => node.kind === "Map")).toHaveLength(1)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("declares one recovery arm per check when continueOnFail is true", () => {
    const suite = CheckSuite.make({ checks, strategy: "all-pass", concurrency: 3, continueOnFail: true })

    const graph = Graph.build(suite, head)
    // One Catch per check is what makes the tolerant suite tolerant in the
    // PLAN and not only at run time: the join can no longer fail on a check's
    // behalf, so a failing check does not interrupt its siblings.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(callsTo(graph, "check")).toHaveLength(3)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("reads a quarantined check as failed, whatever the check failed with", () => {
    // A tolerant join returns an explicit outcome envelope. Interpreting that
    // protocol is opt-in, so an arbitrary check row cannot impersonate it.
    const boom = { _tag: "Quarantined", member: "test", error: new Error("boom") }
    const falsy = { _tag: "Quarantined", member: "test", error: null }
    const lint = { _tag: "Succeeded", member: "lint", value: { ok: true } }

    expect(CheckSuite.passed(boom)).toBe(false)
    expect(CheckSuite.passed(falsy)).toBe(true)
    expect(CheckSuite.rows({ lint, test: falsy }, ["lint", "test"], true)).toEqual([
      { id: "lint", passed: true },
      { id: "test", passed: false, error: null }
    ])
  })

  it("batches declared check calls at the concurrency bound", () => {
    const graph = Graph.build(
      CheckSuite.make({ checks, strategy: "all-pass", concurrency: 2, continueOnFail: false }),
      head
    )

    expect(callsTo(graph, "check")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
    // The batches no longer merge through a `Map`: the rows a batch produced
    // are carried on as planned references and assembled once, so the only
    // `Map` left is the verdict.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Map")).toHaveLength(1)
  })

  it("rejects an empty suite, an empty id, and an invalid concurrency", () => {
    expect(() => CheckSuite.make({ checks: {}, strategy: "all-pass", concurrency: 1, continueOnFail: false }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "CheckSuite requires at least one check"
      }))
    expect(() => CheckSuite.make({ checks, strategy: "all-pass", concurrency: 0, continueOnFail: false }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "CheckSuite concurrency must be a positive safe integer"
      }))
    expect(() => CheckSuite.make({ checks: { "": step }, strategy: "all-pass", concurrency: 1, continueOnFail: false }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "CheckSuite check ids must not be empty"
      }))
  })

  it("names one graph member per check id", () => {
    const graph = Graph.build(
      CheckSuite.make({ checks, strategy: "all-pass", concurrency: 3, continueOnFail: false }),
      head
    )
    const named = callsTo(graph, "check").map((node) => payloadOf(node).check)

    expect(named.sort()).toEqual(["lint", "test", "typecheck"])
  })

  it.effect("stops at the first failing check when continueOnFail is false", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []

      const failure = yield* CheckSuite.run("head", {
        strategy: "all-pass",
        concurrency: 1,
        continueOnFail: false,
        checks: {
          lint: () => Effect.sync(() => ran.push("lint")).pipe(Effect.as({ ok: true })),
          typecheck: () =>
            Effect.suspend(() => {
              ran.push("typecheck")
              return Effect.fail("tsc exited 2")
            }),
          test: () => Effect.sync(() => ran.push("test")).pipe(Effect.as({ ok: true }))
        }
      }).pipe(Effect.flip)

      expect(failure).toBe("tsc exited 2")
      expect(ran).toEqual(["lint", "typecheck"])
    }))

  it.effect("runs every check and lists the failed one when continueOnFail is true", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []

      const verdict = yield* CheckSuite.run("head", {
        strategy: "majority",
        concurrency: 3,
        continueOnFail: true,
        checks: {
          lint: () => Effect.sync(() => ran.push("lint")).pipe(Effect.as({ ok: true })),
          typecheck: () =>
            Effect.suspend(() => {
              ran.push("typecheck")
              return Effect.fail("tsc exited 2")
            }),
          test: () => Effect.sync(() => ran.push("test")).pipe(Effect.as({ ok: true }))
        }
      })

      expect(verdict.errors).toEqual({ typecheck: "tsc exited 2" })
      expect(ran.sort()).toEqual(["lint", "test", "typecheck"])
      expect(verdict).toEqual({
        passed: ["lint", "test"],
        failed: ["typecheck"],
        errors: { typecheck: "tsc exited 2" },
        strategy: "majority",
        verdict: true
      })
    }))

  it.effect("propagates a check defect even when continueOnFail is true", () =>
    Effect.gen(function*() {
      const defect = new Error("the check threw")
      const exit = yield* Effect.exit(
        CheckSuite.run("head", {
          strategy: "all-pass",
          concurrency: 2,
          continueOnFail: true,
          checks: { lint: () => Effect.succeed({ ok: true }), typecheck: () => Effect.die(defect) }
        })
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // `continueOnFail` tolerates a check that fails, not one that is broken:
        // a defect has no row to list in the verdict.
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
      }
    }))

  it.effect("fails a check whose row reports a failure", () =>
    Effect.gen(function*() {
      const verdict = yield* CheckSuite.run<string, unknown, never, never>("head", {
        strategy: "all-pass",
        concurrency: 2,
        continueOnFail: true,
        checks: {
          lint: () => Effect.succeed({ ok: true }),
          test: () => Effect.succeed({ passed: false, error: "3 failing" })
        }
      })

      expect(verdict.errors).toEqual({ test: "3 failing" })
      expect(verdict.failed).toEqual(["test"])
      expect(verdict.verdict).toBe(false)
    }))

  it.effect("rejects an invalid runtime concurrency", () =>
    Effect.gen(function*() {
      const failure = yield* CheckSuite.run("head", {
        strategy: "all-pass",
        concurrency: 0,
        continueOnFail: true,
        checks: { lint: () => Effect.succeed({ ok: true }) }
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("CheckSuite concurrency must be a positive safe integer")
    }))

  it.effect("rejects an empty runtime suite and an empty runtime id before a check runs", () =>
    Effect.gen(function*() {
      let ran = 0
      const check = () =>
        Effect.sync(() => {
          ran += 1
          return { ok: true }
        })

      const empty = yield* CheckSuite.run<string, { readonly ok: boolean }, never, never>("head", {
        strategy: "all-pass",
        concurrency: 2,
        continueOnFail: true,
        checks: {}
      }).pipe(Effect.flip)

      expect(empty).toBeInstanceOf(PatternError)
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("CheckSuite requires at least one check")

      const unnamed = yield* CheckSuite.run<string, { readonly ok: boolean }, never, never>("head", {
        strategy: "all-pass",
        concurrency: 2,
        continueOnFail: true,
        checks: { "": check, lint: check }
      }).pipe(Effect.flip)

      expect(unnamed).toBeInstanceOf(PatternError)
      expect(unnamed.code).toBe("invalid_decorator")
      expect(unnamed.message).toBe("CheckSuite check ids must not be empty")
      expect(ran).toBe(0)
    }))

  it.effect("never runs more checks at once than the concurrency bound", () =>
    Effect.gen(function*() {
      // The test holds every started check on `held`, so the suite cannot make
      // progress on its own: what runs concurrently is what the bound admits,
      // not what the scheduler happened to interleave.
      const held = yield* Latch.make()
      const saturated = yield* Latch.make()
      const entered: Array<string> = []
      let inFlight = 0
      let peak = 0
      const check = (id: string) => () =>
        Effect.gen(function*() {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          entered.push(id)
          if (entered.length === 2) yield* Latch.open(saturated)
          yield* Latch.await(held)
          inFlight -= 1
          return { ok: true }
        })

      const running = yield* CheckSuite.run<string, { readonly ok: boolean }, never, never>("head", {
        strategy: "all-pass",
        concurrency: 2,
        continueOnFail: false,
        checks: {
          lint: check("lint"),
          typecheck: check("typecheck"),
          test: check("test"),
          audit: check("audit")
        }
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(saturated)

      // Both slots are taken and neither can finish, so no third check started.
      expect(entered).toEqual(["lint", "typecheck"])
      expect(inFlight).toBe(2)

      yield* Latch.open(held)
      const verdict = yield* Fiber.join(running)

      expect(verdict.verdict).toBe(true)
      expect(entered).toEqual(["lint", "typecheck", "test", "audit"])
      expect(peak).toBe(2)
    }))

  it("gives a tolerant suite and a fail-fast suite different topology and different identity", () => {
    const material = (continueOnFail: boolean) =>
      Graph.nodes(
        Graph.build(CheckSuite.make({ checks, strategy: "all-pass", concurrency: 3, continueOnFail }), head)
      )

    const tolerant = material(true)
    const failFast = material(false)

    // The tolerant join carries the recovery arms; the fail-fast join is the
    // plain All that interrupts the siblings of a failing check.
    expect(tolerant.filter((node) => node.kind === "Catch")).toHaveLength(3)
    expect(failFast.filter((node) => node.kind === "Catch")).toHaveLength(0)
    expect(tolerant.map((node) => node.draft.material.body)).not.toEqual(
      failFast.map((node) => node.draft.material.body)
    )
  })
})
