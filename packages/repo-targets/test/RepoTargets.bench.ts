import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, test } from "vitest"
import { BuildAndCheckTypeScriptPackage, WorkspaceSources } from "../src/index.ts"
import * as ImportAnalysis from "../src/ImportAnalysis.ts"
import * as ImportRulesCheck from "../src/ImportRulesCheck.ts"

const opts = { time: 120, warmupTime: 30 }

const sampleSourcePath = NodePath.join(import.meta.dirname, "../src/BuildAndCheckTypeScriptPackage.ts")
const sampleSourceText = Fs.readFileSync(sampleSourcePath, "utf8")

const rules: ReadonlyArray<ImportRulesCheck.ImportRule> = [
  {
    kind: "forbid",
    files: ["src/**/*.ts"],
    modules: ["openai", "@anthropic-ai/**", "axios", "hono"],
    because: "Use Smithers SDK and Effect services."
  },
  {
    kind: "rootImportsOnly",
    files: ["src/**/*.ts"],
    packages: ["@smthrs/*"],
    because: "Import Smithers packages from root entries."
  },
  {
    kind: "forbidCalls",
    files: ["src/**/*.ts"],
    callees: ["Effect.runPromise", "Effect.runSync", "setTimeout", "setInterval"],
    because: "No boundary runs or manual timers in library code."
  }
]

const sampleSources: ReadonlyArray<ImportRulesCheck.Source> = Array.from({ length: 8 }, (_, index) => ({
  path: `src/Module${index}.ts`,
  text: sampleSourceText
}))

describe("@smthrs/repo-targets", () => {
  test("WorkspaceSources reach resolution (cached manifest)", async ({ bench }) => {
    // Prime manifest cache once before measuring steady-state graph walk.
    WorkspaceSources({ cwd: "packages/smithers/build/targets" })
    await bench("WorkspaceSources (targets)", () => {
      WorkspaceSources({ cwd: "packages/smithers/build/targets" })
    }).run(opts)
  })

  test("BuildAndCheckTypeScriptPackage macro expansion", async ({ bench }) => {
    await bench("BuildAndCheckTypeScriptPackage", () => {
      BuildAndCheckTypeScriptPackage({ cwd: "packages/smithers/build/targets" })
    }).run(opts)
  })

  test("ImportAnalysis.analyze on BuildAndCheckTypeScriptPackage.ts", async ({ bench }) => {
    await bench("ImportAnalysis.analyze (~23 KB)", () => {
      ImportAnalysis.analyze("src/BuildAndCheckTypeScriptPackage.ts", sampleSourceText, true)
    }).run(opts)
  })

  test("ImportRulesCheck.check across 8 source modules", async ({ bench }) => {
    await bench("ImportRulesCheck.check (8 files)", () => {
      ImportRulesCheck.check(rules, sampleSources)
    }).run(opts)
  })
})
