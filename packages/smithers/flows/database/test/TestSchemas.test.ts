import { expect, test } from "vitest"
import { TestSchemas } from "../src/index.ts"
import * as Selection from "../src/internal/PostgresSelection.ts"

import { afterEach, vi } from "vitest"
afterEach(() => vi.unstubAllEnvs())

test("timestamped fixture prefixes preserve age and identity across separately named stores", () => {
  const prefix = TestSchemas.schemaName("fixture")
  const engine = TestSchemas.forStore(prefix, "engine_db")
  const control = TestSchemas.forStore(prefix, "control_db")
  expect(engine).toMatch(new RegExp(TestSchemas.NAME_PATTERN))
  expect(control).toMatch(new RegExp(TestSchemas.NAME_PATTERN))
  expect(engine).not.toBe(control)
  expect(engine.slice(-44)).toBe(prefix.slice(-44))
  expect(TestSchemas.forStore("legacy", "engine_db")).toBe("legacy_engine_db")
  expect(() => TestSchemas.forStore(prefix, "X".repeat(30))).toThrow("Invalid test store")
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgresql://localhost/test")
  vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  expect(Selection.location("/project/engine.db")?.schema).toBe(engine)
})

test("hyphenated caller prefixes normalize into bounded reaper identities", () => {
  for (
    const prefix of ["who-may-ask", "creation-flow", "agent-views", "views-steps", "long-hyphenated-prefix".repeat(10)]
  ) {
    const name = TestSchemas.schemaName(prefix)
    expect(name).toMatch(new RegExp(TestSchemas.NAME_PATTERN))
    expect(name.startsWith(`${prefix.replaceAll("-", "_").slice(0, 19)}_`)).toBe(true)
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63)
  }
})

test("fixture identities reject malformed prefixes and invalid timestamps at the public boundary", () => {
  for (const prefix of ["", "0first", "Upper", "with space", "quote'", "line\n", "_first"]) {
    expect(() => TestSchemas.schemaName(prefix, 1_000_000_000)).toThrow("Invalid test schema identity")
  }
  for (const createdAt of [-1, 0, 999_999_999, 10_000_000_000, 1_000_000_000.5, NaN, Infinity]) {
    expect(() => TestSchemas.schemaName("fixture", createdAt)).toThrow("Invalid test schema identity")
  }
  for (const createdAt of [1_000_000_000, 9_999_999_999]) {
    const name = TestSchemas.schemaName("long_prefix".repeat(3), createdAt)
    expect(name).toMatch(new RegExp(TestSchemas.NAME_PATTERN))
    expect(new TextEncoder().encode(name).length).toBe(63)
    expect(name.slice(20, 30)).toBe(String(createdAt))
  }
})
