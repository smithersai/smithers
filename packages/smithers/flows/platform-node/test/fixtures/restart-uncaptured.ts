import { Action, Flow, Interpreter } from "@smthrs/flows"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import { Effect, Layer, Schema } from "effect"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import * as NodeRuntime from "../../src/NodeRuntime.ts"

const [directory, phase, variant] = process.argv.slice(2)
if (!directory || !phase || !variant) throw new Error("directory, phase and variant required")
const A = Action.make("restart/A", { payload: {}, success: Schema.String })
class Recoverable extends Schema.TaggedError<Recoverable>()("Recoverable", { message: Schema.String }) {}
const B = Action.make("restart/B", { payload: { value: Schema.String }, success: Schema.String, error: Recoverable })
const next = variant === "edited-continuation"
  ? (_value: Planned.Planned<string>) => B.call({ value: "changed" })
  : variant === "commented-continuation"
  ? (value: Planned.Planned<string>) => B.call({ value /* same continuation */ })
  : (value: Planned.Planned<string>) => B.call({ value })
const body = variant === "single"
  ? () => B.call({ value: "single" })
  : variant === "edited-body"
  ? () => A.call({}).pipe(Node.bindPlanned((_value) => B.call({ value: "changed" })))
  : variant === "commented-body"
  ? () => A.call({}).pipe(Node.bindPlanned((value) => B.call({ value /* same body */ })))
  : variant === "captured"
  ? Node.capture({}, () => A.call({}).pipe(Node.bindPlanned(Node.capture({}, (value) => B.call({ value })))))
  : variant === "typed-catch"
  ? () =>
    A.call({}).pipe(
      Node.bindPlanned((value) => B.call({ value })),
      Node.catch({ error: Recoverable, onFailure: () => Node.succeed("recovered") })
    )
  : variant === "continuation" || variant === "edited-continuation" || variant === "commented-continuation"
  ? Node.capture({}, () => A.call({}).pipe(Node.bindPlanned(next)))
  : () => A.call({}).pipe(Node.bindPlanned((value) => B.call({ value })))
const flow = Flow.make("restart/F", { payload: {}, success: Schema.String, error: Recoverable, body })
const flows = Interpreter.layer(flow).pipe(
  Layer.provideMerge(A.toLayer(() =>
    Effect.sync(() => {
      appendFileSync(join(directory, "effects.log"), "A\n")
      return "first"
    })
  )),
  Layer.provideMerge(B.toLayer(({ value }) =>
    Effect.gen(function*() {
      yield* Effect.sync(() => {
        appendFileSync(join(directory, "effects.log"), "B\n")
        console.log("EFFECT=B")
      })
      if (phase === "start") yield* Effect.never
      if (variant === "typed-catch") return yield* Effect.fail(new Recoverable({ message: "recover me" }))
      return value
    })
  )),
  Layer.provideMerge(Action.layerImplementations)
)
const host = NodeRuntime.layerHost({
  filename: join(directory, "engine.db"),
  workspaceRoot: directory,
  owner: { hostId: "restart-test" }
}, flows)
const result = await Effect.runPromise(
  flow.execute({}, { executionId: "restart-1" }).pipe(
    Effect.provide(host),
    Effect.scoped
  )
)
console.log(`RESULT=${JSON.stringify(result)}`)
