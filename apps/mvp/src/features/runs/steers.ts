import { Clock, Context, Effect, Layer, Option } from "effect"
import { answerAskingTab } from "../../flows/askingTab"
import { ChatStore } from "../chat/store"
import { runsChannel } from "./contract"
import { type QueuedSteer, RunsCall } from "./schema"
import { keep, RUN_STEER, SteerWrites } from "./writes"
import { sendingAdmitted } from "../../outboxAdmission"

// The tab's side of steering (docs/features/runs.md#steering): a `run/steer` step, in the leader tab's engine worker,
// asks the tab that started its run to put the message in the device's outbox, which chat's store leads. Every tab
// listens on the engine's runs channel, and only the tab that started a call's request answers it
// (src/flows/askingTab.ts); every other tab, and every other device, leaves it alone.

/** Steers this tab queues: `queue` puts a message in the device's outbox once. */
export class RunSteers extends Context.Service<
  RunSteers,
  { readonly queue: (steer: QueuedSteer) => Effect.Effect<{ readonly kept: boolean }> }
>()("@smthrs/mvp/runs/RunSteers") {
  /**
   * Over chat's store, which leads the outbox, and the steers' collections. This tab takes the outbox's lead first, as a
   * tab a person presses in does (decision 0002 §1), so the outbox admits it here. A message the outbox holds, or the
   * route answered, is queued already.
   */
  static readonly layer = Layer.effect(
    RunSteers,
    Effect.gen(function* () {
      const chat = yield* ChatStore
      const { sending, sent } = yield* SteerWrites
      return RunSteers.of({
        queue: (steer) =>
          Effect.gen(function* () {
            const held = yield* sent.get(steer.id)
            if (Option.isSome(yield* sending.get(steer.id))) return { kept: yield* sendingAdmitted(chat.outbox, RUN_STEER, steer.id) }
            if (Option.isSome(held) && (held.value.status === "sent" || held.value.reason !== null)) return { kept: true }
            const row = { ...steer, queuedAt: yield* Clock.currentTimeMillis, v: 1 as const }
            const recovery = yield* Effect.result(keep(sent, row, "not_sent", null))
            if (recovery._tag === "Failure") return { kept: false }
            yield* chat.lead
            const admitted = yield* chat.outbox
              .transact(RUN_STEER, { idempotencyKey: steer.id, joinExisting: true }, Effect.asVoid(sending.insert(row)))
              .pipe(Effect.flatMap((taken) => taken.admitted.pipe(Effect.catch((error) => Effect.andThen(Effect.ignore(taken.settled), Effect.fail(error))))), Effect.result)
            const pending = yield* sent.get(steer.id)
            if (admitted._tag === "Success" && Option.isSome(pending) && pending.value.status === "not_sent" && pending.value.reason === null) {
              const removed = yield* sent.delete(steer.id).pipe(Effect.orDie)
              yield* Effect.ignore(removed.persisted)
            }
            return { kept: admitted._tag === "Success" }
          }),
      })
    }),
  )
}

/** Answers the runs channel of engine `name` for this tab's requests until its scope closes. */
export const tabRuns = (host: { readonly name: string }) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const steers = yield* RunSteers
      yield* answerAskingTab({ channel: runsChannel(host.name), input: RunsCall, answer: (call) => steers.queue(call.steer) })
    }),
  )
