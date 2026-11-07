/**
 * A cancel receipt is an answer about a run, not a receipt for having asked.
 *
 * `Control.cancel` keys its mutation on `cli:cancel:<runId>`, the key the CLI
 * passes, and `mutate` replays a recorded receipt for it forever. That is
 * right for a cancel that finished the run and wrong for one that did not: a
 * cancel against a run a live peer owns answers `Accepted` and leaves the run
 * running, and every later `smithers cancel` and `smithers down` then replayed
 * that `Accepted` as `AlreadyApplied` instead of asking again. The release validation
 * smoke left two runs permanently non-terminal that way — `gc` skips them, and
 * no CLI command could reach them.
 *
 * The shape here is the shipped one: two compositions over one control
 * database under two process identities, which is what a gateway and a CLI
 * are.
 */
import { Ownership } from "@smthrs/run-store"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as DurableStack from "./DurableStack.ts"

const launcher: Ownership.OwnerId = { hostId: "cancel-replay-launcher", pid: 11, nonce: "launcher" }
const operator: Ownership.OwnerId = { hostId: "cancel-replay-operator", pid: 12, nonce: "operator" }

describe("a cancel that did not finish the run", () => {
  it("asks again instead of replaying its own receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cancel-replay-"))
    try {
      const file = join(root, "control.db")
      const open = <A, E>(owner: Ownership.OwnerId, use: Effect.Effect<A, E, Control | ControlRuntime>) =>
        Effect.runPromise(
          use.pipe(
            Effect.provide(DurableStack.durable({ owner, database: DurableStack.fileBundle(file) })),
            Effect.scoped,
            Effect.orDie
          )
        )

      // One process launches the run and exits still owning the row.
      const runId = await open(
        launcher,
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const card = yield* control.plan({ flowId: "system/test", input: { cancel: "replay" } })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:cancel-replay"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          yield* runtime.resume(receipt.runId)
          return receipt.runId
        })
      )

      const key = `cli:cancel:${runId}`
      // A second identity cancels. It owns no fiber and the row is not its
      // own, so the cancel is a durable request the launcher never acts on.
      const first = await open(
        operator,
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const receipt = yield* control.cancel({ runId, idempotencyKey: key })
          return { receipt, status: (yield* runtime.getRun(runId)).status }
        })
      )

      expect(first.receipt._tag).toBe("Accepted")
      expect(first.status).not.toBe("cancelled")

      // The operator asks again. The run is still not terminal, so the
      // question is still open and the answer may not be a replay.
      const second = await open(
        operator,
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const receipt = yield* control.cancel({ runId, idempotencyKey: key })
          return { receipt, status: (yield* runtime.getRun(runId)).status }
        })
      )

      expect(second.receipt._tag).not.toBe("AlreadyApplied")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it("replays the receipt of a cancel that DID finish the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cancel-replay-terminal-"))
    try {
      const file = join(root, "control.db")
      const open = <A, E>(use: Effect.Effect<A, E, Control | ControlRuntime>) =>
        Effect.runPromise(
          use.pipe(
            Effect.provide(DurableStack.durable({ owner: launcher, database: DurableStack.fileBundle(file) })),
            Effect.scoped,
            Effect.orDie
          )
        )

      const observed = await open(Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { cancel: "terminal" } })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:cancel-terminal"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        const runId = receipt.runId
        const key = `cli:cancel:${runId}`
        const first = yield* control.cancel({ runId, idempotencyKey: key })
        const again = yield* control.cancel({ runId, idempotencyKey: key })
        return { first, again }
      }))

      // The run is terminal, so the recorded answer is still the true one and
      // the idempotency guarantee stands.
      expect(observed.first).toMatchObject({ _tag: "Terminal", status: "cancelled" })
      expect(observed.again).toMatchObject({ _tag: "Terminal", status: "cancelled" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
