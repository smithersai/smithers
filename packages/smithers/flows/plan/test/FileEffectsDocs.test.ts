import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import * as ts from "typescript"
import * as Plan from "../src/Plan.ts"
import { compile, draft } from "../src/test/PlanFixtures.ts"
import { withCrypto } from "./Crypto.ts"

const guide = readFileSync(new URL("../docs/guides/declare-file-effects.md", import.meta.url), "utf8")
const concept = readFileSync(new URL("../docs/concepts/effects-and-conflicts.md", import.meta.url), "utf8")

describe("file-effects documentation", () => {
  for (const [name, text] of [["guide", guide], ["concept", concept]] as const) {
    it.effect(`${name} lead example orders matching source reads after their producer`, () =>
      Effect.gen(function*() {
        const source = text.match(/```ts\n([\s\S]*?)```/)![1]!
        const { outputText } = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        })
        const effects = runInNewContext(`${outputText}\neffects`, { exports: {} }) as Plan.NodeEffects
        const plan = yield* withCrypto(compile([
          draft("producer", { writes: ["src/generated.ts"] }),
          { ...draft("consumer"), effects }
        ]))
        expect(plan.nodes.find((node) => node.id === "consumer")!.dependsOn).toEqual(["producer"])
      }))
  }

  it("describes bare Pattern entries as literal paths", () => {
    const row = guide.split("\n").find((line) => /^\| `Pattern`/.test(line))!
    expect(row).toMatch(/literal path/)
    expect(guide).toMatch(/literal paths at both overlap analysis and execution/)
  })

  it("distinguishes explicit earlier-byte selection from inferred cycles", () => {
    const section = concept.split("## When an edge would close a cycle")[1]!.split("\n## ")[0]!
    expect(section).toMatch(/`Ref`.*`Pending`/s)
    expect(section).toMatch(/accepted/)
    expect(section).toMatch(/earlier bytes/)
    expect(section).toMatch(/inferred producer or `serialize` edges/)
    expect(section).not.toContain("through a declared dependency or a serialize edge")
  })
})

describe("plan node order documentation", () => {
  for (
    const path of [
      "guides/compile-a-plan.md",
      "concepts/plan-value.md",
      "api.md"
    ]
  ) {
    it(`${path} qualifies array order and requires scheduling from dependencies`, () => {
      const text = readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8")
      expect(text).toMatch(/topological order of material dependencies/)
      expect(text).toMatch(/Schedule[^.]*`dependsOn`/)
    })
  }
})
