import { describe, expect, test } from "vitest"
import { exampleForkOf } from "./exampleForks.ts"

describe("exampleForkOf", () => {
  test.each([
    ["Effect", "Effect-TS/effect"],
    ["Alchemy", "alchemy-run/alchemy"],
    ["Foldkit", "foldkit/foldkit"],
    ["T3Code", "pingdotgg/t3code"],
    ["OpenCode", "anomalyco/opencode"],
    ["Needlefish", "refcell/needlefish"],
    ["Eliza", "elizaOS/eliza"],
  ])("attributes smithersai/%s to %s case-insensitively", (name, upstreamRepo) => {
    expect(exampleForkOf("SmithersAI", name)).toEqual({
      forkOrg: "smithersai",
      upstreamRepo,
      upstreamHref: `https://github.com/${upstreamRepo}`,
    })
  })

  test("returns undefined for first-party repos, unknown repos, and prototype keys", () => {
    expect(exampleForkOf("smithersai", "smithers")).toBeUndefined()
    expect(exampleForkOf("smithersai", "vibelang")).toBeUndefined()
    expect(exampleForkOf("evmts", "voltaire")).toBeUndefined()
    expect(exampleForkOf("smithersai", "constructor")).toBeUndefined()
    expect(exampleForkOf("smithersai", "toString")).toBeUndefined()
  })
})
