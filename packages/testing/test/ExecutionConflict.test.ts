/**
 * Both reference engines used to accept an execution id that already existed
 * and silently run the ORIGINAL flow on the ORIGINAL payload, so a caller that
 * passed a different flow or a different payload got no signal at all on the
 * seam that defines engine conformance. They also disagreed about generated
 * ids: one skipped ids a caller had claimed explicitly and the other did not.
 */
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import type { FlowSpec } from "../src/EngineSubject.vibe"
import * as EngineSubject from "../src/EngineSubject.vibe"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import { describe, expect, it } from "../src/Vitest.vibe"

const echo = (name: string): FlowSpec => ({
  name,
  steps: [{
    key: `${name}/echo`,
    sealed: false,
    kind: "step",
    run: (input) => Effect.succeed(input)
  }]
})

const first = echo("testing/conflict/first")
const second = echo("testing/conflict/second")

const engineSubjectLayer = FlowEngineLike.layerOver(FlowEngine.layerMemory)

/** Runs one body against each reference engine, in that engine's own scope. */
const onEachSubject = (
  name: string,
  body: (engine: EngineSubject.EngineSubject) => Effect.Effect<void>
): void => {
  it.scoped(`MemoryEngine ${name}`, () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      yield* body(yield* MemoryEngine.make(store))
    }))
  it.scoped(`FlowEngineLike ${name}`, () =>
    Effect.flatMap(EngineSubject.EngineSubject, body).pipe(Effect.provide(engineSubjectLayer)))
}

describe("a duplicate execution id is a conflict, not a silent join", () => {
  onEachSubject("refuses a different flow under an existing id", (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/conflict/flow"
      yield* engine.run({ flow: first, payload: { value: 1 }, executionId })
      const error = yield* engine.run({ flow: second, payload: { value: 1 }, executionId }).pipe(Effect.flip)
      expect(error._tag).toBe("ExecutionConflictError")
      expect((error as { readonly field: string }).field).toBe("flow")
    }) as Effect.Effect<void>)

  onEachSubject("refuses a different payload under an existing id", (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/conflict/payload"
      yield* engine.run({ flow: first, payload: { value: 1 }, executionId })
      const error = yield* engine.run({ flow: first, payload: { value: 2 }, executionId }).pipe(Effect.flip)
      expect(error._tag).toBe("ExecutionConflictError")
      expect((error as { readonly field: string }).field).toBe("payload")
    }) as Effect.Effect<void>)

  onEachSubject("bounds conflicting payload renderings", (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/conflict/bounded-payload"
      yield* engine.run({ flow: first, payload: { value: "a".repeat(400) }, executionId })
      const error = yield* engine.run({ flow: first, payload: { value: "b".repeat(400) }, executionId }).pipe(
        Effect.flip
      )
      expect(error._tag).toBe("ExecutionConflictError")
      expect(error.code).toBe("execution_conflict")
      expect((error as { readonly expected: string }).expected).toHaveLength(200)
      expect((error as { readonly actual: string }).actual).toHaveLength(200)
      expect((error as { readonly expected: string }).expected).toMatch(/\.\.\.$/)
      expect((error as { readonly actual: string }).actual).toMatch(/\.\.\.$/)
    }) as Effect.Effect<void>)

  onEachSubject("joins an identical re-submission", (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/conflict/identical"
      const one = yield* engine.run({ flow: first, payload: { value: 1 }, executionId })
      const two = yield* engine.run({ flow: first, payload: { value: 1 }, executionId })
      expect(two).toEqual(one)
    }) as Effect.Effect<void>)

  it.scoped("FlowEngineLike skips an id a caller already claimed, as MemoryEngine does", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      yield* engine.run({ flow: first, payload: { value: 1 }, executionId: "engine-0" })
      const anonymous = yield* engine.run({ flow: second, payload: { value: 2 } })
      expect(anonymous.executionId).not.toBe("engine-0")
    }).pipe(Effect.provide(engineSubjectLayer)))

  it.scoped("MemoryEngine skips an id a caller already claimed", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      yield* engine.run({ flow: first, payload: { value: 1 }, executionId: "memory-0" })
      const anonymous = yield* engine.run({ flow: second, payload: { value: 2 } })
      expect(anonymous.executionId).not.toBe("memory-0")
    }))
})
