import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { setupCandidate, SetupHostInputSchema } from "../src/RepositorySetup.ts"

describe("shared Go setup admission fixture", () => {
  it("uses the canonical draft schema and exact candidate digest", () => {
    const fixtures = JSON.parse(
      readFileSync(new URL("../testdata/repository-setup-backend.json", import.meta.url), "utf8")
    )
    expect(fixtures).toHaveLength(2)
    for (const raw of fixtures) {
      const input = SetupHostInputSchema.parse(raw)
      expect(setupCandidate(input)).toBe(input.digest)
    }
  })
})
