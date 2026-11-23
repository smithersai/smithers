import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ImportAnalysis from "../src/ImportAnalysis.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/repo-targets ImportAnalysis .vibe vs .ts Differential Parity Fuzz", () => {
  it("analyze(file.vibe) matches analyze(file.ts) across imports, re-exports, member reads, destructuring, dynamic imports, require, and calls", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        includeReferences: Schema.Boolean,
        importKind: Schema.Literals(["named", "defaultAndNamed", "namespace", "typeOnly", "reexport", "exportStar"]),
        accessKind: Schema.Literals(["dot", "computedIdent", "computedSpecial", "destructure", "destructureRest", "chainedCall", "unwrap"]),
        dynamicKind: Schema.Literals(["none", "dynImport", "requireCall", "createRequire"]),
        classCalls: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const lines: Array<string> = []
            if (c.importKind === "named") {
              lines.push(`import { alpha, type Beta } from "pkg-a"`)
              lines.push(`export const v1 = alpha()`)
            } else if (c.importKind === "defaultAndNamed") {
              lines.push(`import defA, { alpha as a1 } from "pkg-a"`)
              lines.push(`export const v1 = [defA, a1()]`)
            } else if (c.importKind === "namespace") {
              lines.push(`import * as ns from "pkg-ns"`)
              if (c.accessKind === "dot") lines.push(`export const v1 = ns.run(1)`)
              else if (c.accessKind === "computedIdent") lines.push(`export const v1 = ns["run"](1)`)
              else if (c.accessKind === "computedSpecial") lines.push(`export const v1 = ns["weird-key"]()`)
              else if (c.accessKind === "destructure") lines.push(`const { run, "k-1": k1 } = ns; export const v1 = [run, k1]`)
              else if (c.accessKind === "destructureRest") lines.push(`const { run, ...rest } = ns; export const v1 = [run, rest]`)
              else if (c.accessKind === "chainedCall") lines.push(`export const v1 = ns.builder().finish()`)
              else lines.push(`export const v1 = (ns as any)!.run?.()`)
            } else if (c.importKind === "typeOnly") {
              lines.push(`import type { Foo } from "pkg-types"`)
              lines.push(`export type Bar = Foo`)
            } else if (c.importKind === "reexport") {
              lines.push(`export { x, type Y } from "pkg-re"`)
            } else {
              lines.push(`export * from "pkg-star"`)
            }

            if (c.dynamicKind === "dynImport") {
              lines.push(`export const loadDyn = async () => (await import("pkg-dyn")).go()`)
            } else if (c.dynamicKind === "requireCall") {
              lines.push(`declare const require: any; const { fn } = require("pkg-cjs"); export const r1 = fn()`)
            } else if (c.dynamicKind === "createRequire") {
              lines.push(`import { createRequire } from "node:module"; const req = createRequire(import.meta.url); export const r2 = req("pkg-cr")`)
            }

            if (c.classCalls) {
              lines.push(`class Base { m() { return 1 } }`)
              lines.push(`export class Sub extends Base { #p() { return 2 } run() { return this.#p() + super.m() + this.m() } }`)
            }

            const src = lines.join("\n") + "\n"
            const tsRes = ImportAnalysis.analyze("src/sample.ts", src, c.includeReferences)
            const vibeRes = ImportAnalysis.analyze("src/sample.vibe", src, c.includeReferences)

            // Core differential invariant: identical specifiers, forms, lines, and typeOnly flags!
            if (tsRes.references.length !== vibeRes.references.length) return false
            for (let i = 0; i < tsRes.references.length; i++) {
              const a = tsRes.references[i]!
              const b = vibeRes.references[i]!
              if (a.specifier !== b.specifier || a.form !== b.form || a.typeOnly !== b.typeOnly || a.line !== b.line) {
                return false
              }
            }
            if (tsRes.calls.length !== vibeRes.calls.length) return false
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })
})
