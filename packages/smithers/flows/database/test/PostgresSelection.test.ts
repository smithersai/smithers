import { Effect, type Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as Selection from "../src/internal/PostgresSelection.ts"
import { isUnsupportedDatabase } from "../src/internal/UnsupportedDatabase.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"

/** The tagged refusal a selection throws, as its code and message; never its credentials. */
const refusal = (select: () => unknown) => {
  try {
    select()
  } catch (error) {
    expect(isUnsupportedDatabase(error)).toBe(true)
    const { code, message } = error as { readonly code: string; readonly message: string }
    expect(message).not.toContain("secret")
    return { code, message }
  }
  return expect.unreachable("the selection was accepted")
}

/** The injected settings every case selects from; cases mutate it in place. */
let env: Record<string, string | undefined> = {}
const clear = () => {
  env = {}
}
const set = (key: string, value: string) => {
  env[key] = value
}
it("keeps SQLite default and validates explicit PostgreSQL configuration without exposing credentials", () => {
  clear()
  expect(Selection.layer("local.db", false, env)).toBeUndefined()
  set("SMITHERS_BACKEND", "postgres")
  expect(refusal(() => Selection.layer("local.db", false, env))).toEqual({
    code: "postgres_url_missing",
    message: "PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL"
  })
  set("DATABASE_URL", "mysql://secret@host/database")
  expect(refusal(() => Selection.layer("local.db", false, env))).toEqual({
    code: "postgres_url_invalid",
    message: "PostgreSQL configuration requires a postgres:// or postgresql:// URL"
  })
  set("DATABASE_URL", "postgres://[")
  expect(refusal(() => Selection.layer("local.db", false, env))).toEqual({
    code: "postgres_url_invalid",
    message: "Invalid PostgreSQL connection URL"
  })
  set("DATABASE_URL", "postgres://host/database")
  expect(Selection.layer("local.db", false, env)).toBeDefined()
  set("SMITHERS_POSTGRES_SCHEMA", "workspace")
  expect(Selection.layer("local.db", false, env)).toBeDefined()
  set("SMITHERS_BACKEND", "sqlite")
  expect(Selection.layer("local.db", false, env)).toBeUndefined()
  expect(Selection.layer("postgresql://host/database?schema=explicit", false, env)).toBeDefined()
  expect(Selection.layer("postgres://host/database", false, env)).toBeDefined()
})

it("ignores an ambient DATABASE_URL and keeps SQLite-owned opens local (#2175)", () => {
  clear()
  set("DATABASE_URL", "file:./dev.db")
  expect(Selection.layer("local.db", false, env)).toBeUndefined()
  set("DATABASE_URL", "postgres://user:secret@host/app")
  expect(Selection.layer("local.db", false, env)).toBeUndefined()
  set("SMITHERS_POSTGRES_URL", "postgres://host/database")
  expect(Selection.layer(":memory:", false, env)).toBeUndefined()
  expect(Selection.layer("", false, env)).toBeUndefined()
  expect(Selection.layer("file:memdb?mode=memory", false, env)).toBeUndefined()
  expect(Selection.layer("local.db", false, env)).toBeDefined()
  set("SMITHERS_POSTGRES_URL", "")
  set("SMITHERS_BACKEND", "postgres")
  expect(Selection.layer(":memory:", false, env)).toBeUndefined()
  expect(Selection.layer("local.db", false, env)).toBeDefined()
  set("DATABASE_URL", "mysql://secret@host/database")
  set("SMITHERS_POSTGRES_URL", "postgres://host/database")
  expect(Selection.layer("local.db", false, env)).toBeDefined()
})

it("locates a store's schema the way the layer opens it", () => {
  clear()
  expect(Selection.location("local.db", env)).toBeUndefined()
  expect(Selection.location("postgres://user@host/database?schema=explicit&sslmode=require", env)).toEqual({
    url: "postgres://user@host/database?sslmode=require",
    schema: "explicit"
  })
  expect(Selection.location("postgresql://host/database", env)).toEqual({
    url: "postgresql://host/database",
    schema: "smithers_flows"
  })
  set("SMITHERS_POSTGRES_URL", "postgres://host/database")
  const hashed = Selection.location("/project/.flows/engine.db", env)
  expect(hashed?.url).toBe("postgres://host/database")
  expect(hashed?.schema).toMatch(/^smithers_[0-9a-f]{32}$/)
  // Unprefixed, the whole path names the schema, so another directory is another schema.
  expect(Selection.location("/copy/.flows/engine.db", env)?.schema).not.toBe(hashed?.schema)
  set("SMITHERS_POSTGRES_SCHEMA", "workspace")
  // Prefixed, only the basename does: a copy needs a name of its own.
  // Sanitized aliases keep this mapping but the layer refuses a different recorded basename.
  expect(Selection.location("/project/.flows/engine.db", env)?.schema).toBe("workspace_engine_db")
  expect(Selection.location("engine-db", env)?.schema).toBe("workspace_engine_db")
  expect(Selection.location("/copy/.flows/engine.db", env)?.schema).toBe("workspace_engine_db")
  expect(Selection.location("/copy/.flows/verify_ab_engine.db", env)?.schema).toBe("workspace_verify_ab_engine_db")
})

afterEach(() => vi.unstubAllEnvs())

it("selects from injected settings and never consults the ambient environment (R2-Astra-D1-012)", () => {
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://ambient/database")
  expect(Selection.location("local.db", {})).toBeUndefined()
  expect(Selection.layer("local.db", false, {})).toBeUndefined()
  expect(Selection.location("local.db", { SMITHERS_POSTGRES_URL: "postgres://injected/database" })?.url).toBe(
    "postgres://injected/database"
  )
  // The selector declares no default source: omitting the settings is a type error, not an ambient read.
  // @ts-expect-error settings are required
  expect(() => Selection.location("local.db")).toThrow(TypeError)
})

/** The driver a layer opens, or the refusal code its selection raised. */
const opened = (layer: Layer.Layer<SqlClient>) =>
  Effect.runPromise(
    Effect.provide(Effect.map(SqlClient, (sql) => sql.driver), layer).pipe(
      Effect.catchDefect((defect) => Effect.succeed(isUnsupportedDatabase(defect) ? defect.code : "unknown"))
    )
  )

it("two NodeDatabase layers with conflicting injected settings select independently in one process (R2-Fable-D1-011)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-selection-"))
  try {
    const filename = join(directory, "store.db")
    vi.stubEnv("SMITHERS_BACKEND", "postgres")
    vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://ambient/database")
    const before = { ...process.env }
    const sqlite = NodeDatabase.layer({ filename, settings: {} })
    const postgres = NodeDatabase.layer({ filename, settings: { SMITHERS_BACKEND: "postgres" } })
    // Injected settings win over the host environment in both directions.
    expect(await opened(sqlite)).toBe("sqlite-node")
    expect(await opened(postgres)).toBe("postgres_url_missing")
    expect(NodeDatabase.postgresLocation(filename, {})).toBeUndefined()
    expect(NodeDatabase.postgresLocation(filename, { SMITHERS_POSTGRES_URL: "postgres://injected/database" })?.url)
      .toBe("postgres://injected/database")
    expect(process.env).toEqual(before)
    // With no injected settings the host layer passes its own environment, read when built.
    expect(NodeDatabase.postgresLocation(filename)?.url).toBe("postgres://ambient/database")
    const hosted = NodeDatabase.layer({ filename })
    vi.stubEnv("SMITHERS_BACKEND", "sqlite")
    expect(await opened(hosted)).toBe("sqlite-node")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
