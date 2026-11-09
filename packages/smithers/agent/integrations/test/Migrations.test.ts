import * as Effect from "effect/Effect"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Core from "../src/core.ts"
import * as IntegrationCursors from "../src/core/IntegrationCursorMigration.vibe"
import * as Migrations from "../src/core/Migrations.vibe"

// `scripts/build.mjs` converts every module to CommonJS with esbuild under
// `"type": "module"`, and esbuild reads a default import of a sibling as the
// whole interop wrapper `{ __esModule, default }` rather than the value.
// `core/Migrations.vibe` used to build its record from a default import,
// so `Migrations.set` in `dist/cjs` held a wrapper with no `pipe` and the
// migrator failed for every `require` consumer. Consumers reach the migration
// through the named binding, and the second test pins that the module offers
// no default export to regress onto.
describe("migration module exports", () => {
  it("blocks direct imports of the schema installation while retaining Core.Migrations", () => {
    const require = createRequire(import.meta.url)
    for (
      const path of [
        "@smthrs/integrations/core/migrations/0001_integration_cursors",
        "@smthrs/integrations/core/migrations/index",
        "@smthrs/integrations/core/IntegrationCursorMigration",
        "@smthrs/integrations/internal/IntegrationCursorMigration"
      ]
    ) {
      expect(() => require.resolve(path)).toThrow(/not defined by "exports"/)
    }
    expect(Core.Migrations.set.migrations["0001_integration_cursors"]).toBe(IntegrationCursors.integrationCursors)
  })

  // The module is a file beside the rest of `core`, not a folder holding one
  // `index.ts`: `core.ts` is this package's only namespace barrel, and an
  // `index.ts` carrying `set`, `run`, and `layer` hid an implementation module
  // behind a barrel path no other module in the package uses.
  it("keeps the migration set in core/Migrations.vibe with no single-file folder", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url))
    expect(existsSync(`${src}core/Migrations.vibe`)).toBe(true)
    expect(existsSync(`${src}core/IntegrationCursorMigration.vibe`)).toBe(true)
    expect(existsSync(`${src}core/migrations`)).toBe(false)
    expect(existsSync(`${src}internal`)).toBe(false)
  })

  it("exposes every migration in the set as an Effect", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, migration] of entries) {
      expect(Effect.isEffect(migration), key).toBe(true)
      expect(typeof migration.pipe, key).toBe("function")
    }
    expect(Core.Migrations.set).toBe(Migrations.set)
  })

  it("keeps the private cursor table migration as a named binding with no default export", () => {
    expect("default" in IntegrationCursors).toBe(false)
    expect(Object.keys(IntegrationCursors)).toEqual(["integrationCursors"])
    expect(typeof IntegrationCursors.integrationCursors.pipe).toBe("function")
    expect(Migrations.set.migrations["0001_integration_cursors"]).toBe(IntegrationCursors.integrationCursors)
  })
})
