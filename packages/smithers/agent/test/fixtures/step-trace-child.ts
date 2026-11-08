/** A full EngineStore process stopped while its second provider call is pending. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Journal } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import { RunStore } from "@smthrs/run-store"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { answer, cell, facts, incarnation, Single, stores } from "./step-trace-stack.ts"

const filename = process.argv[2]
const executionId = process.argv[3]
if (filename === undefined || executionId === undefined) throw new Error("expected database and run id")
process.stdout.write(JSON.stringify({ status: "booted" }) + "\n")
const recover = process.argv[4] === "recover"
let calls = 0
const program = Effect.scoped(Effect.gen(function*() {
  if (recover) {
    const row = yield* (yield* RunStore.RunStore).get(executionId)
    yield* TestClock.setTime((row.heartbeatAtMs ?? 0) + 120_000)
  }
  const journal = yield* Journal.Journal
  const model = Model.make({
    stream: () =>
      Stream.unwrap(Effect.gen(function*() {
        calls++
        if (recover) return answer()
        if (calls === 1) return cell("console.log(\"first frame\")")
        const saved = yield* facts(executionId).pipe(Effect.provideService(Journal.Journal, journal), Effect.orDie)
        process.stdout.write(
          JSON.stringify({ status: "provider-pending", facts: saved.length, pid: process.pid }) + "\n"
        )
        return yield* Effect.never
      }))
  })
  const wiring = yield* incarnation(model)
  process.stdout.write(JSON.stringify({ status: "engine-created" }) + "\n")
  const result = yield* Single.execute({ input: "two frames" }, { executionId }).pipe(Effect.provide(wiring))
  if (recover) process.stdout.write(JSON.stringify({ status: "recovered", result, calls }) + "\n")
  return result
})).pipe(Effect.provide(stores(filename)), Effect.provide(NodeCrypto.layer))
await Effect.runPromise(recover ? program.pipe(Effect.provide(TestClock.layer())) : program)
