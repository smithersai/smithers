/**
 * A flow whose payload and success are number-keyed records builds, runs and
 * returns its result, with keys as JSON carries them (strings).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { expect } from "vitest"
import * as Action from "../src/Action/index.ts"
import * as Flow from "../src/Flow/index.ts"
import * as Interpreter from "../src/Interpreter.ts"

const Versions = Schema.Record(Schema.Number, Schema.Number)

const Read = Action.make("NumberKeyedRecord/read", { payload: { base: Versions }, success: Versions })

const ReadAll = Flow.make("NumberKeyedRecord/readAll", {
  payload: { base: Versions },
  success: Versions,
  body: Node.capture(
    { action: Read.name },
    (payload: { readonly base: Readonly<Record<number, number>> }) => Read.call(payload)
  )
})

it.effect("runs a flow whose payload and success are number-keyed records", () =>
  Effect.gen(function*() {
    const seen: Array<unknown> = []
    const layer = Interpreter.layerWithImplementations(
      ReadAll,
      Read.toLayer(({ base }) =>
        Effect.sync(() => {
          seen.push(base)
          return { ...base, 13: 1 }
        })
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer))
    const result = yield* ReadAll.execute({ base: { 7: 2 } }, { executionId: "number-keyed-record-1" }).pipe(
      Effect.provide(layer)
    )
    expect(result).toStrictEqual({ "7": 2, "13": 1 })
    expect(seen).toStrictEqual([{ "7": 2 }])
  }))
