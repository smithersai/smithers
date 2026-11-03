// pnpm db:migrate: one host-only diagnostic; both CLI and deploy use the verified ops migration boundary.
import { Effect, Redacted } from "effect"
import * as Database from "./Database.ts"
import * as Connection from "../ops/database/Connection.ts"

let connection: Redacted.Redacted<string> | undefined
try {
  connection = await Effect.runPromise(Database.url)
  await Effect.runPromise(Effect.scoped(Connection.migrate(connection)))
} catch (error) {
  console.error(`db:migrate: ${Connection.diagnostic(error, connection ?? Redacted.make(""))}`)
  process.exitCode = 1
}
