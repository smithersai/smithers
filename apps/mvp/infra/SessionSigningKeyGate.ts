import * as Alchemy from "alchemy"
import { Effect, Redacted } from "effect"
import * as Database from "../db/Database.ts"
import * as SessionKeys from "../worker/SessionKeys.ts"
import * as SigningKeys from "../worker/SessionSigningKeys.ts"

/** Every publication depends on a fresh database-time check, including keys already labelled retired. */
export const SessionSigningKeyGate = Alchemy.Action("SessionSigningKeyGate", (input: {
  readonly database: Redacted.Redacted<string>
  readonly secrets: Redacted.Redacted<string>
  readonly sealSecret: Redacted.Redacted<string>
  readonly publication: string
}) => Effect.gen(function* () {
  const keys = SessionKeys.decodeSecrets(input.secrets)
  if (keys._tag === "None") return yield* Effect.die(new Error("Invalid session signing key configuration"))
  yield* SigningKeys.gate(keys.value, input.sealSecret).pipe(Effect.provide(Database.layer(Effect.succeed(input.database))))
  return true
}))
