import { Effect, Redacted } from "effect"
import * as Database from "../../db/Database.ts"
import * as Policy from "./Policy.ts"

export const sslFor = (connection: Redacted.Redacted<string>) => Policy.sslFor(Redacted.value(connection))
export const diagnostic = (error: unknown, connection: Redacted.Redacted<string>) => Policy.diagnostic(error, Redacted.value(connection))

/** Validate before any deployment lookup or connection; retain the app's one Effect SQL client configuration. */
export const layer = (url: Redacted.Redacted<string>) => Database.layer(Effect.succeed(url), sslFor(url))

/** Both migration callers receive host-only failures; never retain a driver's raw error or nested cause. */
export const migrate = (url: Redacted.Redacted<string>) =>
  Database.migrateAndReport.pipe(
    Effect.provide(layer(url)),
    Effect.catchCause((cause) => Effect.fail(new Error(diagnostic(cause, url)))),
  )

/** Neon's API requests channel binding, unsupported by this driver. Require verified TLS with the Node root store. */
export const neonConnectionUri = (uri: string): Redacted.Redacted<string> => {
  const url = Policy.parse(uri)
  url.searchParams.set("sslmode", "verify-full")
  url.searchParams.delete("channel_binding")
  return Redacted.make(url.toString())
}
