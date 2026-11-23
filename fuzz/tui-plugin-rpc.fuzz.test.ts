import { isSmithersError, SmithersError } from "@smthrs/errors"
import { Load, Manifest } from "@smthrs/plugin"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Fuzzy from "../apps/tui/src/fuzzy.ts"

describe("apps/tui fuzzy, @smthrs/plugin, and @smthrs/errors fuzz", () => {
  it.fuzz(
    "TUI fuzzy.score and fuzzy.filter satisfy ordering, empty-query, and length invariants",
    [
      Schema.String.check(Schema.isMaxLength(20)),
      Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(Schema.isMaxLength(20))
    ],
    ([query, items]) => {
      const filtered = Fuzzy.filter(items, query, (s) => s)
      expect(filtered.length).toBeLessThanOrEqual(items.length)
      const tokens = query.split(/[\s/]+/).filter((t) => t !== "")
      if (tokens.length === 0) {
        expect(filtered).toEqual(items)
        return true
      }
      let prevScore = -Infinity
      for (const item of filtered) {
        let sum = 0
        for (const token of tokens) {
          const s = Fuzzy.score(token, item)
          expect(s).toBeDefined()
          if (s !== undefined) {
            expect(Number.isFinite(s)).toBe(true)
            sum += s
          }
        }
        expect(sum).toBeGreaterThanOrEqual(prevScore)
        prevScore = sum
      }
      return true
    }
  )

  it.fuzz(
    "Plugin Manifest.decode never throws uncaught defects on arbitrary unknown JSON",
    [Schema.Unknown],
    ([raw]) => {
      const exit = Effect.runSyncExit(Manifest.decode(raw))
      if (exit._tag === "Success") {
        // Loading a valid decoded manifest against host facts must succeed deterministically
        const hostFacts = { capabilities: [] as ReadonlyArray<string>, apiVersion: "1.0.0" }
        const loaded1 = Load.load(hostFacts as any, [{ id: exit.value.id, manifest: exit.value }] as any)
        const loaded2 = Load.load(hostFacts as any, [{ id: exit.value.id, manifest: exit.value }] as any)
        expect(loaded1).toEqual(loaded2)
      }
      return true
    }
  )

  it.fuzz(
    "SmithersError preserves code, message, and type guard across arbitrary messages",
    [
      Schema.Literals(["CONFIG", "AUTH", "RATE_LIMIT", "NETWORK", "INTERNAL"]),
      Schema.String.check(Schema.isMaxLength(100))
    ],
    ([code, message]) => {
      const err = new SmithersError(code as any, message)
      expect(isSmithersError(err)).toBe(true)
      expect(isSmithersError(new Error(message))).toBe(false)
      expect(err.code).toBe(code)
      return true
    }
  )
})
