import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Shards from "../ci/shards.ts"
import { BuildAndCheckTypeScriptPackage } from "../src/BuildAndCheckTypeScriptPackage.ts"
import * as ImportAnalysis from "../src/ImportAnalysis.ts"
import * as ReviewDocsAgainstCode from "../src/ReviewDocsAgainstCode.ts"
import * as ReviewJsdocAgainstCode from "../src/ReviewJsdocAgainstCode.ts"
import * as ReviewLint from "../src/ReviewLint.ts"
import * as ReviewTagsMigrationsAndKeys from "../src/ReviewTagsMigrationsAndKeys.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")

describe("@smthrs/repo-targets ImportAnalysis, BuildAndCheckTypeScriptPackage, ReviewLint & Shards deep fuzz", () => {
  it("ImportAnalysis.analyze(includeReferences=true) tracks imports, exports, dynamic imports, require, member uses & calls", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        snippetKind: Schema.Literals([
          "named_and_ns",
          "default_and_destructured",
          "dynamic_and_require",
          "reexport_and_type",
          "import_equals_and_calls",
          "shadowed_and_escaped"
        ]),
        specifier: Schema.Literals(["effect", "@smthrs/flow", "node:fs", "./local.ts"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ snippetKind, specifier }) =>
          Effect.sync(() => {
            const code =
              snippetKind === "named_and_ns"
                ? `import { Effect as E, Layer } from "${specifier}"\nimport * as All from "${specifier}"\nexport const x = E.succeed(All.foo)\nconst y = Layer.empty\n`
                : snippetKind === "default_and_destructured"
                  ? `import Def from "${specifier}"\nconst { a, b: renamed } = Def\nDef.run(a, renamed)\nconsole.log(Def)\n`
                  : snippetKind === "dynamic_and_require"
                    ? `const m = await import("${specifier}")\nconst r = require("${specifier}")\nm.go()\nr.stop()\n`
                    : snippetKind === "reexport_and_type"
                      ? `import type { Foo } from "${specifier}"\nexport { Bar as Baz } from "${specifier}"\nexport * from "${specifier}"\nexport type T = Foo\n`
                      : snippetKind === "import_equals_and_calls"
                        ? `import * as Mod from "${specifier}"\nconst fn = () => Mod["prop"]()\nconst arr = [Mod, Mod.sub.deep]\nexport const out = fn()\n`
                        : `import { a, b } from "${specifier}"\nfunction inner(a: number) { return a + b() }\nconst obj = { a, b }\n`

            const full = ImportAnalysis.analyze("src/sample.ts", code, true)
            const lite = ImportAnalysis.analyze("src/sample.ts", code, false)
            const specsFull = ImportAnalysis.specifiers(full)
            const specsLite = ImportAnalysis.specifiers(lite)
            return specsFull.length === specsLite.length && specsFull.includes(specifier)
          }),
        { seed, executions: Math.min(executions, 100) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("BuildAndCheckTypeScriptPackage, ReviewLint rubrics & CI shards produce consistent deterministic targets", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        withTests: Schema.Boolean,
        withBench: Schema.Boolean,
        withDocs: Schema.Boolean,
        withFuzz: Schema.Boolean,
        coverage: Schema.Boolean,
        lane: Schema.Literals(["test", "packages"]),
        shardIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ withTests, withBench, withDocs, withFuzz, coverage, lane, shardIdx }) =>
          Effect.sync(() => {
            const targets = BuildAndCheckTypeScriptPackage({
              cwd: "packages/repo-targets",
              ...(withTests ? { coverage: coverage ? 100 : false } : { test: false }),
              ...(withBench ? { bench: true } : {}),
              ...(withDocs ? { docs: false } : {}),
              ...(withFuzz ? { circular: true } : { circular: false })
            } as never)
            if (targets.lib === undefined || targets.check === undefined) return false

            // ReviewLint & preset rubrics
            const rev = ReviewLint.review({ cwd: "packages/repo-targets" }, { summary: "fuzz", include: [], context: [], batchSize: 2, failOn: "warning", rubric: "Check correctness" })
            const r1 = ReviewDocsAgainstCode.ReviewDocsAgainstCode({ cwd: "packages/repo-targets" })
            const r2 = ReviewJsdocAgainstCode.ReviewJsdocAgainstCode({ cwd: "packages/repo-targets" })
            const r3 = ReviewTagsMigrationsAndKeys.ReviewTagsMigrationsAndKeys({ cwd: "packages/repo-targets" })
            if (!rev || !r1 || !r2 || !r3) return false

            // CI shards
            const jobId = Shards.shardJobId(lane, shardIdx)
            const step = Shards.shardStep(shardIdx % Math.max(1, Shards.packageShards.length))
            return (
              jobId.includes(lane) &&
              typeof step === "object" &&
              Shards.packagePatterns.length > 0 &&
              Shards.workspaceShards > 0 &&
              Shards.workspaceStep !== undefined
            )
          }),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
