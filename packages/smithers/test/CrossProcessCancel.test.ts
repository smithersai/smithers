/**
 * Cancelling a run from a second CLI process.
 *
 * Cancellation is fiber interruption, and fibers are process-local, so the
 * durable half is the engine row's `cancel_requested_at_ms`. Until it was
 * written, `Control.cancel` from a second `smithers` process, the UI, or a
 * gateway answered `ClaimLost` and the run kept going (triage B-10).
 *
 * The composition-level proof is `packages/smithers/control/test/CancelConvergence.test.ts`,
 * where one database carries both halves. This is the shipped shape instead:
 * `.flows/control.db` and `.flows/engine.db` are two files with two
 * `flows_runs` tables (the release policy), and the two rows for one run converge
 * only because the cancel is recorded durably on the engine's row and the
 * owning driver acts on it at its next tick.
 */
import { Control } from "@smthrs/control"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

interface RunRow {
  readonly status: string
  readonly cancel_requested_at_ms: number | null
}

const readRun = (file: string, runId: string): RunRow | undefined => {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    return database.prepare(
      "SELECT status, cancel_requested_at_ms FROM flows_runs WHERE run_id = ?"
    ).get(runId) as unknown as RunRow | undefined
  } finally {
    database.close()
  }
}

/** The engine-side row of a run parked mid-execution, owned by nobody. */
const seedParkedExecution = (file: string, runId: string): void => {
  const database = new DatabaseSync(file)
  try {
    database.prepare(
      `INSERT INTO flows_runs (
        run_id, status, created_at_ms, started_at_ms, waiting_reason, state_json
      ) VALUES (?, 'suspended', ?, ?, 'event', ?)`
    ).run(
      runId,
      Date.now(),
      Date.now(),
      JSON.stringify({ version: 1, flowName: "agent/run", payload: { runId, planId: "plan-1" } })
    )
  } finally {
    database.close()
  }
}

describe("cancelling a run from a second process", () => {
  it("records the cancel on the engine row and converges both databases", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-cancel-"))
    try {
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, { environment: {} })
      const composition = Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>
      const open = <A, E>(use: Effect.Effect<A, E, Control.Control>) =>
        Effect.runPromise(use.pipe(Effect.provide(composition), Effect.scoped, Effect.orDie))

      // One process's worth of lifetime: plan, approve, launch, exit.
      const runId = await open(Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId: "system/test", input: { cli: true } })
        yield* control.approve({ ...card.approval })
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:cancel"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected a started run")
        }
        return receipt.runId
      }))

      const controlFile = NodeControl.databasePath(root)
      const engineFile = NodeControl.executionDatabasePath(root)
      // Two files, and the engine's half of this run is the row a driver owns.
      expect(controlFile).not.toBe(engineFile)
      expect(readRun(engineFile, runId)).toBeUndefined()
      seedParkedExecution(engineFile, runId)

      // A second process opens the same directory and cancels.
      const observed = await open(Effect.gen(function*() {
        const control = yield* Control.Control
        const receipt = yield* control.cancel({ runId, idempotencyKey: `cli:cancel:${runId}` })
        const requested = readRun(engineFile, runId)
        let engineRow = requested
        for (let attempt = 0; attempt < 40 && engineRow?.status !== "cancelled"; attempt++) {
          yield* Effect.sleep("250 millis")
          engineRow = readRun(engineFile, runId)
        }
        return { receipt, requested, engineRow, controlRow: readRun(controlFile, runId) }
      }))

      expect(observed.receipt).toMatchObject({ _tag: "Terminal", status: "cancelled" })
      // The durable half, written before the engine acted: this is what a
      // process that owns no fiber can still do.
      expect(observed.requested?.cancel_requested_at_ms).not.toBeNull()
      expect(observed.controlRow?.status).toBe("cancelled")
      // And the owning driver settles its own row from the request.
      expect(observed.engineRow?.status).toBe("cancelled")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
