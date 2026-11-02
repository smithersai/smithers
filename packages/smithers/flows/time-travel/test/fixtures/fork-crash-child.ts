import * as Effect from "effect/Effect"
import * as EffectHandlerRegistry from "../../src/internal/EffectHandlerRegistry.ts"
import * as Fork from "../../src/internal/Fork.ts"
import { runReal } from "../RealTimeTravelHarness.ts"

const filename = process.argv[2]
const runId = process.argv[3]
if (filename === undefined || runId === undefined) {
  throw new Error("usage: fork-crash-child.ts <database> <run-id>")
}

// Reached after `jj workspace add` and before `createFork`: the parent
// SIGKILLs here, which is the crash window the reservation exists for.
const checkpoint = Effect.sync(() => {
  process.stdout.write(`${JSON.stringify({ stage: "provisioned" })}\n`)
})

// A process entrypoint: running the Effect here is the intended boundary.
await Effect.runPromise(runReal(
  filename,
  Fork.fork({
    parentRunId: runId,
    frame: { lineageId: `${runId}/root`, seq: 0 },
    workspaceRoot: ".flows/forks",
    hooks: {
      beforeStep: (step) => step === "commit-fork" ? checkpoint.pipe(Effect.andThen(Effect.never)) : Effect.void
    }
  }).pipe(Effect.provide(EffectHandlerRegistry.layerNoop))
))

// The parent always SIGKILLs at the checkpoint. Reaching here is a fixture defect.
process.exitCode = 2
