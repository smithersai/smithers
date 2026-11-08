// What ChatApi needs for sign-in that the stack makes (docs/features/sign-in.md#configuration): SESSION_SECRET. The
// GitHub App's client id and secret come from the deploying environment, which ChatApi's Config reads.
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import { Config, Context, Effect, Option, Redacted } from "effect"

/**
 * Sign-in's compatibility secret: generated once by Alchemy (32 random bytes, hexadecimal) and kept, encrypted with
 * `ALCHEMY_PASSWORD`, in the stack's state. It supplies the legacy signing and sealing fallbacks. When used for either,
 * its durable fingerprint prevents replacement during publication.
 */
export const SessionSecret = Alchemy.Random("SessionSecret")

/** SESSION_SECRET for the Worker being declared. alchemy.run.ts provides it while it declares ChatApi. */
export class Secret extends Context.Service<Secret, { readonly value: Output.Output<Redacted.Redacted<string>> }>()(
  "@smthrs/mvp/infra/SignIn/Secret",
) {}

/** The configured key map or a map over the unchanged generated legacy secret. */
export const configuredSecrets = (legacy: Output.Output<Redacted.Redacted<string>>) => Effect.gen(function* () {
  const configured = yield* Config.option(Config.Redacted("SESSION_SECRETS"))
  return Option.isSome(configured) ? Output.literal(configured.value)
    : Output.map(legacy, value => Redacted.make(JSON.stringify({ legacy: Redacted.value(value) })))
})

/** Resolve sealing once so the publication gate and Worker binding use exactly the same secret. */
export const configuredSealSecret = (legacy: Output.Output<Redacted.Redacted<string>>) => Effect.gen(function* () {
  const configured = yield* Config.option(Config.Redacted("SESSION_SEAL_SECRET"))
  return Option.isSome(configured) ? Output.literal(configured.value) : legacy
})

/** The stack provides the gate-dependent key map before ChatApi can be published. */
export class SigningSecrets extends Context.Service<SigningSecrets, {
  readonly value: Output.Output<Redacted.Redacted<string>>
  readonly seal: Output.Output<Redacted.Redacted<string>>
}>()(
  "@smthrs/mvp/infra/SignIn/SigningSecrets",
) {}

/** Bind legacy compatibility, the gated map and the pinned sealing secret without exposing their values. */
export const bind = Effect.gen(function* () {
  const secret = yield* Effect.serviceOption(Secret)
  const signing = yield* Effect.serviceOption(SigningSecrets)
  if (Option.isNone(secret)) return
  yield* Output.named(secret.value.value, "SESSION_SECRET")
  const map = Option.isSome(signing) ? signing.value.value : yield* configuredSecrets(secret.value.value)
  yield* Output.named(map, "SESSION_SECRETS")
  const seal = Option.isSome(signing) ? signing.value.seal : yield* configuredSealSecret(secret.value.value)
  yield* Output.named(seal, "SESSION_SEAL_SECRET")
})
