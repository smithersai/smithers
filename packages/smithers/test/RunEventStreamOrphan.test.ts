/** A read-only follower must not wait forever for a writer that really died. */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Control, ControlExecutor, ControlLive, ControlRuntime, SqlControlRuntime } from "@smthrs/control"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { RunStore } from "@smthrs/run-store"
import { Context, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import * as RunEventStream from "../src/cli/RunEventStream.ts"
import * as ControlDatabase from "../src/internal/ControlDatabase.ts"
import { childEnvironment } from "./support/node-child.ts"

interface CommittedRun {
  readonly runId: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly parked: boolean
}

it(
  "drains without writes after a real owner dies between engine and control terminal commits",
  { timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "run-log-orphan-"))
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--import",
      "vibelang/register",
      fileURLToPath(new URL("./fixtures/run-event-orphan-writer.ts", import.meta.url)),
      directory
    ], {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    })
    const exited = once(child, "exit")
    let output = ""
    let diagnostics = ""
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-8_000)
    })
    try {
      const committed = await new Promise<Array<CommittedRun>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("writer did not commit its fixture")), 60_000)
        const fail = (code: number | null, signal: string | null) => {
          clearTimeout(timer)
          reject(new Error(`writer exited before readiness (${code ?? signal}): ${diagnostics}`))
        }
        child.once("exit", fail)
        child.stdout.on("data", (chunk) => {
          output += String(chunk)
          const ready = output.split("\n").slice(0, -1).find((line) => line.startsWith("ORPHAN_READY "))
          if (ready === undefined) return
          clearTimeout(timer)
          child.removeListener("exit", fail)
          resolve(JSON.parse(ready.slice("ORPHAN_READY ".length)))
        })
        child.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      expect(committed).toHaveLength(6)
      await Effect.runPromise(
        Effect.gen(function*() {
          const engine = Context.get(
            yield* Layer.build(Layer.fresh(RunStore.layer.pipe(
              Layer.provide(
                ControlDatabase.observe(join(directory, "engine.sqlite")).pipe(Layer.provide(NodeServices.layer))
              )
            ))),
            RunStore.RunStore
          )
          const database = ControlDatabase.observe(join(directory, "control.sqlite")).pipe(
            Layer.provide(NodeServices.layer)
          )
          const stores = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
            Layer.provideMerge(database),
            Layer.orDie
          )
          const executor = ControlExecutor.makeReadOnly({
            readExecution: (id) =>
              engine.get(id).pipe(
                Effect.orDie,
                Effect.map((row) => {
                  if (row.status !== "completed" && row.status !== "failed" && row.status !== "cancelled") {
                    throw new Error("engine is not terminal")
                  }
                  return { _tag: "Observed" as const, status: row.status }
                })
              )
          })
          const stack = ControlLive.layer.pipe(Layer.provideMerge(Layer.mergeAll(
            SqlControlRuntime.layer().pipe(Layer.provideMerge(stores), Layer.provide(NodeCrypto.layer), Layer.orDie),
            NotificationQueue.layer.pipe(Layer.provide(stores)),
            ControlExecutor.layer(executor),
            Registry.layerNoop()
          )))
          yield* Effect.gen(function*() {
            const real = yield* Control.Control
            const runtime = yield* ControlRuntime.ControlRuntime
            const journal = yield* Journal.Journal
            const followers = []
            for (const run of committed) {
              expect((yield* runtime.getRun(run.runId)).status).toBe(run.parked ? "parked" : "accepted")
              for (const after of [undefined, { sequence: 1_000_000 }]) {
                const secondRead = yield* Deferred.make<void>()
                let reads = 0
                const observed = Control.Control.of({
                  ...real,
                  list: (request) =>
                    real.list(request).pipe(Effect.tap(() => {
                      reads++
                      return reads === 2 ? Deferred.succeed(secondRead, undefined) : Effect.void
                    }))
                })
                const followed = yield* RunEventStream.events(run.runId, true, after).pipe(
                  Stream.runCollect,
                  Effect.provideService(Control.Control, observed),
                  Effect.forkChild({ startImmediately: true })
                )
                // A live writer still owes the terminal event; never exit early.
                yield* Deferred.await(secondRead).pipe(Effect.timeout("5 seconds"))
                followers.push({ run, after, followed })
              }
            }
            expect(child.signalCode).toBeNull()
            expect(child.exitCode).toBeNull()
            child.kill("SIGKILL")
            yield* Effect.promise(() => exited)
            expect(child.signalCode).toBe("SIGKILL")
            for (const { run, after, followed } of followers) {
              const settled = yield* Fiber.join(followed).pipe(Effect.timeoutOption("2 seconds"))
              expect(Option.isSome(settled), "orphaned-follower-still-waiting").toBe(true)
              if (Option.isNone(settled)) return yield* Effect.die("orphaned-follower-still-waiting")
              const entries = Array.from(settled.value)
              expect(entries.map((entry) => entry.kind)).toEqual(after === undefined ? [`fixture.${run.status}`] : [])
              expect((yield* runtime.getRun(run.runId)).status).toBe(run.parked ? "parked" : "accepted")
              const durable = yield* journal.entries({ runId: JournalEvent.RunId.make(run.runId), limit: 100 })
              expect(durable.entries.map((entry) => entry.eventType)).toEqual([`fixture.${run.status}`])
            }
          }).pipe(Effect.provide(stack))
        }).pipe(Effect.scoped)
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
