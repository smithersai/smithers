import { Effect, Option, Stream } from "effect"
import { AuthStore } from "../auth/store"

/** A route waits for sign-in's first answer before starting a member-only flow. */
export const identityReady = Effect.flatMap(Effect.serviceOption(AuthStore), Option.match({
  onNone: () => Effect.void,
  onSome: (auth) => auth.sessionState.rows.pipe(
    Stream.filter((rows) => rows.some((row) => row.status !== "loading")),
    Stream.runHead,
    Effect.asVoid,
  ),
}))
