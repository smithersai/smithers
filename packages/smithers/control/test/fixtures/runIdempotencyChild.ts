/** A separate process racing Control.run against the same SQLite database. */
import { Effect } from "effect"
import { appendFileSync } from "node:fs"
import { Control } from "../../src/Control.vibe"
import * as ControlExecutor from "../../src/ControlExecutor.vibe"
import type { PlanCard } from "../../src/ControlSchema.ts"
import { durable, fileBundle } from "../DurableStack.ts"

const filename = process.argv[2]!
const card = JSON.parse(process.argv[3]!) as PlanCard
const stack = durable({
  database: fileBundle(filename),
  executor: ControlExecutor.makeNoop({
    launch: () =>
      Effect.sync(() => {
        appendFileSync(`${filename}.launches`, `${process.pid}\n`)
        return "pending" as const
      })
  })
})

try {
  const receipt = await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control
      yield* Effect.promise(() =>
        new Promise<void>((resolve) => {
          process.once("message", () => resolve())
          process.send!({ ready: true })
        })
      )
      return yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "run:process-race"
      })
    }).pipe(Effect.provide(stack), Effect.scoped)
  )
  process.send!({ receipt })
} catch (error) {
  process.send!({ error: String(error) })
  process.exitCode = 1
} finally {
  process.disconnect!()
}
