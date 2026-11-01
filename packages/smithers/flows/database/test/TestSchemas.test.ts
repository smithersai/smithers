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
  expect(Selection.location("/project/engine.db")?.schema).toBe(engine)
})
