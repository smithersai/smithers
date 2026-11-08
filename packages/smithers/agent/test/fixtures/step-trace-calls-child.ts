import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Journal } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import { RunStore } from "@smthrs/run-store"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { host, queuedCell } from "./step-trace-calls-host.ts"
import { answer, cell, facts, incarnation, Single, stores } from "./step-trace-stack.ts"

const filename = process.argv[2]!
const executionId = process.argv[3]!
const recover = process.argv[5] === "recover"
const partial = process.argv[4] === "partial"
const program = Effect.scoped(Effect.gen(function*() {
  if (recover) {
    const row = yield* (yield* RunStore.RunStore).get(executionId)
    yield* TestClock.setTime((row.heartbeatAtMs ?? 0) + 120_000)
  }
  const journal = yield* Journal.Journal
  const read = () => facts(executionId).pipe(Effect.provideService(Journal.Journal, journal), Effect.orDie)
  const performed: string[] = []
  let providerCalls = 0
  const model = Model.make({
    stream: () =>
      Stream.unwrap(Effect.gen(function*() {
        providerCalls++
        if (recover) return answer()
        if (providerCalls === 1) return cell(queuedCell)
        const saved = yield* read()
        process.stdout.write(JSON.stringify({ status: "provider-pending", facts: saved, performed }) + "\n")
        return yield* Effect.never
      }))
  })
  const wiring = yield* incarnation(model, {
    host: host((text) =>
      Effect.gen(function*() {
        performed.push(text)
        if (recover) return
        if (text !== "right") return
        for (let i = 0; i < 1000; i++) {
          const saved = yield* read()
          const settled = saved.filter((row) => row.payload.eventType === "control.agent.cell-call-settled")
          if (settled.length > 0) {
            process.stdout.write(
              JSON.stringify({
                status: "right-pending",
                facts: saved,
                performed,
                settled: settled.map((row) => row.payload.payload)
              }) + "\n"
            )
            if (partial) return yield* Effect.never
            return
          }
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die(new Error("left call fact did not become live while right waited"))
      }), partial ? "same" : undefined)
  })
  const result = yield* Single.execute({ input: "Read both values" }, { executionId }).pipe(Effect.provide(wiring))
  if (recover) process.stdout.write(JSON.stringify({ status: "recovered", result, providerCalls, performed }) + "\n")
})).pipe(Effect.provide(stores(filename)), Effect.provide(NodeCrypto.layer))
await Effect.runPromise(recover ? program.pipe(Effect.provide(TestClock.layer())) : program)
