import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"
import { Canonical } from "../src/index.vibe"

const guide = readFileSync(new URL("../docs/guides/use-the-schema.md", import.meta.url), "utf8")

const fences = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!)

/** The first guide example containing `needle`. */
const exampleWith = (needle: string): string => {
  const fence = fences.find((code) => code.includes(needle))
  if (fence === undefined) throw new Error(`Missing documentation example: ${needle}`)
  return fence
}

// Run the named examples as one program, so a reader who copies them in order
// gets the result the guide promises. The final expression is the value.
const runExamples = (...needles: ReadonlyArray<string>): unknown => {
  const { outputText } = ts.transpileModule(
    needles.map(exampleWith).join("\n").replace(/^import .*$/gm, ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  )
  return new Function("Canonical", "Effect", "Schema", `return eval(${JSON.stringify(outputText)})`)(
    Canonical,
    Effect,
    Schema
  )
}

describe("documented round trip", () => {
  it("encodes the decoded document, not the Effect that produced it", () => {
    expect(runExamples("const document", "Schema.encodeUnknownSync(Canonical)(document)")).toEqual({
      a: 1,
      b: 2
    })
  })
})
