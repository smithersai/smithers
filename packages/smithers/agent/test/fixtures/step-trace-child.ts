/** A full EngineStore process stopped while its second provider call is pending. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Journal } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import { Effect, Stream } from "effect"
import { cell, facts, incarnation, Single, stores } from "./step-trace-stack.ts"

const filename = process.argv[2]
const executionId = process.argv[3]
if (filename === undefined || executionId === undefined) throw new Error("expected database and run id")
process.stdout.write(JSON.stringify({ status: "booted" }) + "\n")
let calls = 0
await Effect.runPromise(
  Effect.scoped(Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const model = Model.make({
      stream: () =>
        Stream.unwrap(Effect.gen(function*() {
          calls++
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
    return yield* Single.execute({ input: "two frames" }, { executionId }).pipe(Effect.provide(wiring))
  })).pipe(Effect.provide(stores(filename)), Effect.provide(NodeCrypto.layer))
)
