/** One embedded engine keeps atomic writes across independently assembled consumers. */
import { ScriptedJudge } from "@smthrs/agent"
import { Control, ControlRuntime } from "@smthrs/control"
import { Journal } from "@smthrs/journal"
import { Cause, Context, Deferred, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as NativeControl from "../src/internal/NativeControl.ts"
import { platform } from "../src/internal/NodeControlHost.ts"

const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "control-materialization-"))
  const directory = join(root, ".smithers", "flows", "review")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "flow.mdx"), "---\ndescription: Review\nmodel: anthropic:test-model\n---\nReview\n")
  return root
}

it.each(["control-first", "runtime-first"] as const)(
  "rolls back an embedded plan with its external journal (%s)",
  async (order) => {
    const root = await project()
    try {
      const clients = new Map<string, Set<SqlClient>>()
      const host = NativeControl.make({
        ...platform,
        database: (filename) =>
          platform.database(filename).pipe(Layer.tap((services) =>
            Effect.sync(() => {
              const connections = clients.get(filename) ?? new Set<SqlClient>()
              connections.add(Context.get(services, SqlClient))
              clients.set(filename, connections)
            })
          ))
      })
      const registry = host.layerRegistry(root)
      const original = host.engineDurable(root, registry)
      const ready = Deferred.makeUnsafe<void>()
      const runtime = original.runtime.pipe(Layer.tap(() => Deferred.succeed(ready, undefined)))
      const engine = { ...original, runtime }
      const control = host.layerControl(
        { root, evaluator: ScriptedJudge.layer, startsRuns: false },
        registry,
        engine
      )
      const external = Layer.merge(runtime, engine.journal)
      const afterReady = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
        Layer.unwrap(Deferred.await(ready).pipe(Effect.as(layer)))
      const composition = order === "control-first"
        ? Layer.merge(control, afterReady(external))
        : Layer.merge(afterReady(control), external)
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const journal = yield* Journal.Journal
          const runtime = yield* ControlRuntime.ControlRuntime
          const result = yield* Effect.exit(
            journal.transact(Effect.gen(function*() {
              yield* control.plan({ flowId: "review", input: {} })
              return yield* Effect.fail("rollback-materialized-plan")
            })).pipe(Effect.timeout("3 seconds"))
          )
          expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe("rollback-materialized-plan")
          expect((yield* runtime.queryPlans({ limit: 10 })).plans).toEqual([])
          expect(clients.size).toBeGreaterThan(0)
          for (const [filename, connections] of clients) expect(connections.size, filename).toBe(1)
        }).pipe(Effect.provide(composition), Effect.scoped)
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

it("materializes an engine outside an existing layer graph", async () => {
  const root = await project()
  try {
    const host = NativeControl.make(platform)
    const registry = host.layerRegistry(root)
    const engine = host.engineDurable(root, registry)
    await Effect.runPromise(
      Effect.gen(function*() {
        const materialized = yield* host.materializeEngine(engine)
        yield* Effect.gen(function*() {
          const runtime = yield* ControlRuntime.ControlRuntime
          const { card } = yield* runtime.plan({ flowId: "review", input: {} })
          expect(card.flowId).toBe("review")
          expect((yield* runtime.queryPlans({ limit: 10 })).plans).toHaveLength(1)
        }).pipe(Effect.provide(materialized.runtime))
      }).pipe(Effect.scoped)
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
