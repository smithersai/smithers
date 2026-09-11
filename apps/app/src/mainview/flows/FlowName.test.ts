import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { FLOW_NAMES } from "./FlowName"

/*
 * The FlowName union is the card seam's vocabulary, so it has to stay the
 * registry's vocabulary. Both directions are checked here: a name in the union
 * that no module declares would let a dead button compile, and a declared flow
 * missing from the union cannot be raised from a card at all.
 *
 * The registry is read as TEXT (the same technique parity.test.ts uses), so a
 * flow declared in any entries module counts without building the registry.
 */
const declaredNames = (): ReadonlyArray<string> => {
  const entries = fileURLToPath(new URL("./entries/", import.meta.url))
  const names: Array<string> = []
  for (const file of readdirSync(entries).sort()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const source = readFileSync(`${entries}${file}`, "utf8")
    for (const match of source.matchAll(/^\s*name: "([^"]+)",$/gm)) names.push(match[1]!)
  }
  return names
}

describe("FlowName — the union is the registry's own vocabulary", () => {
  test("every declared flow is in the union", () => {
    const union = new Set<string>(FLOW_NAMES)
    const missing = declaredNames().filter((name) => !union.has(name))
    expect(missing).toEqual([])
  })

  test("every name in the union is a declared flow", () => {
    const declared = new Set(declaredNames())
    expect(FLOW_NAMES.filter((name) => !declared.has(name))).toEqual([])
  })

  test("the union names no flow twice", () => {
    expect(new Set<string>(FLOW_NAMES).size).toBe(FLOW_NAMES.length)
  })
})
