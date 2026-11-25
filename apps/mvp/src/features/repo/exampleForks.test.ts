import { describe, expect, test } from "vitest"
import { exampleForkOf } from "./exampleForks.ts"

describe("exampleForkOf", () => {
  test("identifies all known smithersai example forks case-insensitively", () => {
    expect(exampleForkOf("smithersai", "effect")).toEqual({
      forkOrg: "smithersai",
      upstreamRepo: "Effect-TS/effect",
      upstreamHref: "https://github.com/Effect-TS/effect",
    })
    expect(exampleForkOf("SmithersAI", "Eliza")).toEqual({
      forkOrg: "smithersai",
      upstreamRepo: "elizaOS/eliza",
      upstreamHref: "https://github.com/elizaOS/eliza",
    })
    expect(exampleForkOf("smithersai", "t3code")?.upstreamRepo).toBe("pingdotgg/t3code")
  })

  test("returns undefined for first-party repos, unknown repos, and prototype keys", () => {
    expect(exampleForkOf("smithersai", "smithers")).toBeUndefined()
    expect(exampleForkOf("smithersai", "vibelang")).toBeUndefined()
    expect(exampleForkOf("evmts", "voltaire")).toBeUndefined()
    expect(exampleForkOf("smithersai", "constructor")).toBeUndefined()
    expect(exampleForkOf("smithersai", "toString")).toBeUndefined()
  })
})
