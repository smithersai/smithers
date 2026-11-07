/**
 * A cancelled run has to say so in its own journal.
 *
 * `smithers run` keeps its process alive after the receipt is printed, because
 * a local CLI owns the executor and a driver interrupted at the prompt is a
 * run abandoned mid-flight. `Command.ts` `settled` is the whole exit
 * condition: the process waits for `control.run.completed`, `failed`,
 * `cancelled`, `waiting-approval`, or `pending` on the run's journal, and
 * returns on the first one.
 *
 * `control.run.cancelled` had no writer. `Control.cancel` journals
 * `control.run.cancel-requested`, the attribution record, and then transitions
 * the row through `ControlRuntime.interrupt`, which writes no journal event;
 * `AgentSession.settle` deliberately writes none either, because the control
 * operation owns a cancellation's terminal write. So a detached `smithers up`
 * whose run was cancelled by a second process waited for an event nothing
 * emits: the release validation's pid 10105, alive at 0.1 % CPU four and a half
 * minutes after its only run reached `Terminal cancelled`, killed by hand.
 */
import { Effect, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import * as DurableStack from "./DurableStack.ts"

/** The exit condition `packages/smithers/src/Command.ts` waits on, verbatim. */
const settled = (kind: string): boolean =>
  kind === "control.run.waiting-approval" ||
  kind === "control.run.pending" ||
  kind === "control.run.completed" ||
  kind === "control.run.failed" ||
  kind === "control.run.cancelled"

describe("the journal of a cancelled run", () => {
  it("carries the terminal status the launching process is waiting for", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cancel-settlement-"))
    try {
      const kinds = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const card = yield* control.plan({ flowId: "system/test", input: { settle: true } })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:cancel-settlement"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const runId = receipt.runId
          yield* control.cancel({ runId, idempotencyKey: `cli:cancel:${runId}` })
          // The whole history, so the assertion is about what a follower would
          // have been given rather than about the timing of one read.
          const events = yield* Stream.runCollect(control.watch({ runId, follow: false }))
          return events.map((event) => event.kind)
        }).pipe(
          Effect.provide(DurableStack.durable({ database: DurableStack.fileBundle(join(root, "control.db")) })),
          Effect.scoped,
          Effect.orDie
        )
      )

      expect(kinds).toContain("control.run.cancel-requested")
      // The one this file is about. `control.run.pending` is also in this
      // fixture's history — the noop executor declined the launch — so the
      // filter is a readable failure message rather than the assertion.
      expect(kinds.filter(settled)).toContain("control.run.cancelled")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
