import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as ControlTables from "../src/migrations/0001_control_tables.vibe"

// The CommonJS build converts every source module with esbuild's Node interop,
// where a default import of a sibling resolves to that module's whole exports
// object rather than the Effect it exported. Consumers therefore reach each
// migration through a named binding, and this suite pins both halves of that
// contract at the source so the published `require` entry keeps loading.
describe("migration module exports", () => {
  it("exposes every migration in the set as an Effect", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, migration] of entries) {
      expect(typeof migration.pipe, key).toBe("function")
    }
  })

  it("publishes the initial schema as a named binding with no default export", () => {
    expect("default" in ControlTables).toBe(false)
    expect(typeof ControlTables.initial.pipe).toBe("function")
    expect(Migrations.set.migrations["0001_control_tables"]).toBe(ControlTables.initial)
  })
})
