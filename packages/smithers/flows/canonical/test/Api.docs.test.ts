import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"
import { BoundedJson, sortCollections } from "../src/index.ts"
import { firstPath } from "../src/IssuePath.ts"
import { make } from "../src/ReadonlyMap.ts"

const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")
const fences = [...api.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!)

const runExample = (needle: string, result: string): unknown => {
  const code = fences.find((fence) => fence.includes(needle))
  if (code === undefined) throw new Error(`Missing API example: ${needle}`)
  const { outputText } = ts.transpileModule(code.replace(/^import .*$/gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  })
  return new Function(
    "BoundedJson",
    "Schema",
    "make",
    "firstPath",
    "sortCollections",
    `${outputText}\nreturn ${result}`
  )(BoundedJson, Schema, make, firstPath, sortCollections)
}

describe("API documentation examples", () => {
  it("admits the promised strict tree and visits frozen children before their parent", () => {
    const { admitted, containers } = runExample("const containers", "({ admitted, containers })") as {
      admitted: { ok: boolean; value: { tags: ReadonlyArray<string> } }
      containers: ReadonlyArray<unknown>
    }
    expect(admitted.ok).toBe(true)
    expect(admitted.value).toEqual({ tags: ["release"] })
    expect(Object.getPrototypeOf(admitted.value)).toBe(Object.prototype)
    expect(containers).toHaveLength(2)
    expect(containers[0]).toBe(admitted.value.tags)
    expect(containers[1]).toBe(admitted.value)
    expect(containers.every(Object.isFrozen)).toBe(true)
  })

  it("constructs an iterable read-only registry", () => {
    expect(runExample("const registry", "({ enabled: registry.get('build')?.enabled, keys: [...registry.keys()] })"))
      .toEqual({ enabled: true, keys: ["build"] })
  })

  it("sorts a set and leaves an array in its order", () => {
    expect(runExample("const order", "({ tags, steps: order.steps })")).toEqual({ tags: ["a", "b"], steps: ["b", "a"] })
  })

  it("reports a schema field path without the rejected value", () => {
    expect(runExample("let rejectedPath", "rejectedPath")).toBe("$.count")
  })
})
