import type { Outbox } from "@smthrs/effect-tanstack-db"
import { Effect, Option } from "effect"

/** A sending row restored from storage is durable; a live optimistic row must await its actual receipt. */
export const sendingAdmitted = (outbox: Outbox.Service, name: string, id: string) => Effect.gen(function* () {
  const write = yield* outbox.admission(name, id)
  if (Option.isNone(write)) return true
  return yield* write.value.admitted.pipe(Effect.as(true), Effect.catch((refused) =>
    Effect.logWarning("outbox.admission.refused").pipe(
      Effect.annotateLogs({ name, reason: refused.reason, errorCode: "not_admitted" }),
      Effect.andThen(Effect.ignore(write.value.settled)),
      Effect.as(false),
    )))
})
