import { afterAll, describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flows"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { durableEngine, requirements, stubJj } from "../src/TestNodeRuntime.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-test-node-runtime-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The declared step the body names; its implementation runs the sealed count. */
const Measure = Action.make("test/TestNodeRuntime/Measure", { payload: {}, success: Schema.Number })

const Count = Action.make({
  name: "test/TestNodeRuntime/Count",
  success: Schema.Number,
  tier: "sealed",
  idempotencyKey: "test/TestNodeRuntime/Count/v1",
  execute: Effect.sync(() => {
    executions += 1
    return executions
  })
})

let executions = 0

const Counted = Flow.make("test/TestNodeRuntime/Counted", {
  payload: {},
  success: Schema.Number,
  body: () => Measure.call({})
})

const drive = (filename: string, hostId: string) =>
  Counted.execute({}, { executionId: "counted-1" }).pipe(
    Effect.provide(
      Layer.mergeAll(Measure.toLayer(() => Count), Interpreter.layer(Counted)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(filename, hostId))
      )
    ),
    Effect.scoped
  )

describe("TestNodeRuntime", () => {
  it.effect("records nothing through the stub Jujutsu service", () =>
    Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* jj.snapshot()).toEqual({ changeId: "test-snapshot", commitId: "test-snapshot" })
      expect(yield* jj.restore("test-snapshot" as never)).toBeUndefined()
      expect(yield* jj.diff("a" as never, "b" as never)).toBe("")
      expect(yield* jj.workspaceAdd("child", join(directory, "child"))).toBeUndefined()
      expect(yield* jj.workspaceForget("child")).toBeUndefined()
      expect(yield* jj.status()).toBe("")
    }).pipe(Effect.provide(stubJj)))

  it.effect("replays a sealed result from the SQLite file in a later engine", () =>
    Effect.gen(function*() {
      executions = 0
      const filename = join(directory, "replay.sqlite")
      expect(yield* drive(filename, "test-first")).toBe(1)
      expect(yield* drive(filename, "test-second")).toBe(1)
      expect(executions).toBe(1)
    }))

  it.effect("opens the same stores without an engine", () =>
    Effect.gen(function*() {
      const filename = join(directory, "stores.sqlite")
      yield* drive(filename, "test-stores")
      const page = yield* Effect.flatMap(Journal.Journal, (journal) =>
        journal.entries({ runId: "counted-1" as JournalEvent.RunId, limit: 200 })).pipe(
          Effect.provide(requirements(filename))
        )
      expect(page.entries.length).toBeGreaterThan(0)
    }).pipe(Effect.scoped))
})
