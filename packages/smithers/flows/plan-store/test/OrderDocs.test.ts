/**
 * The stored node order is an ordinal, not a schedule.
 *
 * `get` returns nodes in recorded order, which is a topological order of
 * material dependencies within each generation. Inferred reader-after-writer
 * edges can point at a later ordinal, so a reader who schedules off the array
 * order rather than off `dependsOn` runs a node before its producer. The same
 * case guards the pages `@smthrs/plan` owns; this one guards the page that
 * moved here with the store.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("plan node order documentation", () => {
  for (const path of ["guides/persist-a-plan.md"]) {
    it(`${path} qualifies array order and requires scheduling from dependencies`, () => {
      const text = readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8")
      expect(text).toMatch(/topological order of material dependencies/)
      expect(text).toMatch(/Schedule[^.]*`dependsOn`/)
    })
  }
})
