import { afterEach, expect, it, vi } from "vitest"
import * as Selection from "../src/internal/PostgresSelection.ts"
import { isUnsupportedDatabase } from "../src/internal/UnsupportedDatabase.ts"

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

it("selects from injected settings, not the ambient environment (R1-Fable-D1-030)", () => {
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://ambient/database")
  // Two stores in one process select independently of the environment.
  expect(Selection.location("local.db", {})).toBeUndefined()
  expect(Selection.layer("local.db", false, {})).toBeUndefined()
  expect(Selection.location("local.db", { SMITHERS_POSTGRES_URL: "postgres://injected/database" })?.url).toBe(
    "postgres://injected/database"
  )
  // Without injected settings the native layers keep reading the process environment.
  expect(Selection.location("local.db")?.url).toBe("postgres://ambient/database")
  expect(Selection.layer("local.db")).toBeDefined()
})
