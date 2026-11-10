import * as Output from "alchemy/Output"
import { Cause, Effect, Exit, Redacted } from "effect"
import { inspect } from "node:util"
import { expect, test } from "vitest"
import { directUrl, migrationUrl } from "../../infra/Postgres.ts"
import { migrate, sslFor } from "./Connection.ts"
import { sourceText } from "../../../../packages/repo-targets/test-utils/source-readers.mjs"

test("Alchemy's real Neon migration URI adapter uses verify-full; Electric retains its existing adapter", () => {
  const uri = "postgresql://private-user:private-pass@database.invalid/private-db?sslmode=require&channel_binding=require&connect_timeout=3"
  const input = new Output.LiteralExpr(uri)
  const migrated = migrationUrl({ connectionUri: input })
  const electric = directUrl({ connectionUri: input })
  expect(Output.isApplyExpr(migrated)).toBe(true)
  expect(Output.isApplyExpr(electric)).toBe(true)
  if (!Output.isApplyExpr<string, Redacted.Redacted<string>>(migrated) || !Output.isApplyExpr<string, Redacted.Redacted<string>>(electric)) throw new Error("expected Alchemy URI adapters")
  expect(migrated.expr).toBe(input)
  const connection = migrated.f(uri)
  expect(Redacted.value(connection)).toBe("postgresql://private-user:private-pass@database.invalid/private-db?sslmode=verify-full&connect_timeout=3")
  expect(sslFor(connection)).toMatchObject({ rejectUnauthorized: true })
  expect(Redacted.value(electric.f(uri))).toContain("sslmode=require")
})

test("deploy wiring passes the Neon migration adapter to the same verified migration boundary as the CLI", () => {
  const deploy = sourceText(new URL("../../infra/ChatDatabase.ts", import.meta.url))
  const cli = sourceText(new URL("../../db/migrate.ts", import.meta.url))
  expect(deploy).toContain("database: migrationUrl(postgres)")
  expect(deploy).toContain("Connection.migrate(input.database)")
  expect(cli).toContain("Connection.migrate(connection)")
  expect(deploy).not.toContain("Database.layer(Effect.succeed(input.database))")
})

test("deployment migration driver failures expose only the host, including nested causes", async () => {
  const nested = "postgresql://nested-user:nested-pass@nested.invalid/nested-db"
  const uri = `postgresql://private-user:private-pass@database.invalid/private-db?sslmode=require&channel_binding=require&connect_timeout=${encodeURIComponent(nested)}`
  const adapted = migrationUrl({ connectionUri: new Output.LiteralExpr(uri) })
  if (!Output.isApplyExpr<string, Redacted.Redacted<string>>(adapted)) throw new Error("expected Alchemy URI adapter")

  // The real driver's numeric option parser fails before opening a socket.
  const exit = await Effect.runPromiseExit(Effect.scoped(migrate(adapted.f(uri))))
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected migration failure")
  const rendered = [Cause.pretty(exit.cause), JSON.stringify(exit), inspect(exit, { depth: null, showHidden: true })].join("\n")
  expect(rendered).not.toMatch(/postgres(?:ql)?:\/\/|private-user|private-pass|private-db|nested-user|nested-pass|nested\.invalid|nested-db/)
  expect(Cause.pretty(exit.cause)).toContain("database operation failed for database.invalid")
})
