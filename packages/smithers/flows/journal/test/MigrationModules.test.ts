/**
 * The migration modules export named bindings and no default export.
 *
 * The CommonJS build converts each source file with esbuild in Node interop
 * mode. There a default import of a sibling module resolves to that module's
 * whole exports object (`{ __esModule, default }`) instead of the Effect, so
 * `set.migrations["0001_initial"].pipe` was undefined under `require` while
 * the ESM build kept working. A named export has one shape in both formats,
 * and the second case here fails as soon as a default export comes back.
 */
import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.vibe"
import * as Initial from "../src/migrations/0001_initial.vibe"
import * as Checkpoints from "../src/migrations/0002_checkpoints.vibe"
import * as StartupIndex from "../src/migrations/0003_startup_index.vibe"
import * as Dedup from "../src/migrations/0004_dedup.vibe"
import * as RunEventType from "../src/migrations/0005_run_event_type.vibe"
import * as Consensus from "../src/migrations/0006_consensus.vibe"

/** A source module: TypeScript, or the same module migrated to VibeLang. */
const sourceExtensions = [".ts", ".vibe"] as const

/**
 * The migration id of each source module in `files`, sorted: one entry per
 * file, so an id held by two files appears twice. A `.vibe` module's
 * declaration sidecar is not a module.
 */
const migrationIds = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.flatMap((file) => {
    const extension = sourceExtensions.find((extension) => file.endsWith(extension))
    return extension === undefined || file.endsWith(".d.vibe.ts") ? [] : [file.slice(0, -extension.length)]
  }).sort()

describe("migration modules", () => {
  it("registers an Effect for every migration in the set", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.map(([id]) => id)).toEqual([
      "0001_initial",
      "0002_checkpoints",
      "0003_startup_index",
      "0004_dedup",
      "0005_run_event_type",
      "0006_consensus"
    ])
    for (const [, migration] of entries) {
      expect(typeof migration.pipe).toBe("function")
    }
  })

  it("exports each migration as a named binding and no default", () => {
    expect("default" in Initial).toBe(false)
    expect("default" in Checkpoints).toBe(false)
    expect("default" in StartupIndex).toBe(false)
    expect("default" in Dedup).toBe(false)
    expect("default" in RunEventType).toBe(false)
    expect("default" in Consensus).toBe(false)
    expect(typeof Consensus.consensus.pipe).toBe("function")
    expect(typeof RunEventType.runEventType.pipe).toBe("function")
    expect(typeof Dedup.dedup.pipe).toBe("function")
    expect(typeof Initial.initial.pipe).toBe("function")
    expect(typeof Checkpoints.checkpoints.pipe).toBe("function")
    expect(typeof StartupIndex.startupIndex.pipe).toBe("function")
  })

  it("keeps one src/migrations file per migration id, with no gaps", () => {
    const files = readdirSync(new URL("../src/migrations/", import.meta.url))
    expect(migrationIds(files)).toEqual(Object.keys(Migrations.set.migrations))
  })

  it.each([
    ["one .ts file per id", ["0001_a.ts", "0002_b.ts"], ["0001_a", "0002_b"]],
    ["a migration migrated to .vibe", ["0001_a.ts", "0002_b.vibe"], ["0001_a", "0002_b"]],
    ["an id in both languages", ["0001_a.ts", "0001_a.vibe"], ["0001_a", "0001_a"]],
    ["a declaration sidecar", ["0001_a.vibe", "0001_a.d.vibe.ts"], ["0001_a"]],
    ["a file in another language", ["0001_a.ts", "0002_b.js"], ["0001_a"]]
  ])("reads the migration ids of %s", (_case, files, expected) => {
    expect(migrationIds(files)).toEqual(expected)
  })
})
