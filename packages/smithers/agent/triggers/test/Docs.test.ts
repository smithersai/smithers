import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ")

describe("documentation contracts", () => {
  it("requires durable runner deduplication for at-least-once launch attempts (documentation/1)", () => {
    for (
      const path of [
        "README.md",
        "docs/README.md",
        "docs/concepts/claim-protocol.md",
        "docs/troubleshooting.md",
        "docs/api.md"
      ]
    ) {
      const doc = read(path)
      expect(doc, path).toContain("at-least-once launch attempts")
      expect(doc, path).toContain("durably deduplicate by `idempotencyKey`")
      expect(doc, path).toContain("same run identity on replay")
    }
    expect(read("docs/concepts/claim-protocol.md")).toMatch(/accepted.*before.*`launched` result/)
    expect(read("docs/troubleshooting.md")).not.toContain("which the store's transaction forbids")
    expect(read("docs/quickstart.md")).not.toContain("fire the occurrence once")
    const roster = read("../../../../apps/site/src/content/docs/docs/reference/subpackages.mdx")
    expect(roster).not.toContain("two hosts never fire the same scheduled run twice")
  })

  it("describes catch-up enumeration subject to overlap, not lossless billing (documentation/2, api-design/2)", () => {
    const guide = read("docs/guides/choose-a-policy.md")
    expect(guide).toContain("subject to overlap")
    expect(guide).toContain("launch acknowledgement, not completion")
    expect(guide).toContain("durable queue")
    expect(guide).toContain("interval backlog")
    expect(guide).not.toContain("const hourlyRollup")
    expect(guide).not.toContain("pair `all` with `skip` or `buffer-one`")
  })

  it("distinguishes a first-poll bound breach from subsequent polls (documentation/3)", () => {
    for (
      const path of [
        "docs/concepts/policies.md",
        "docs/api.md",
        "docs/guides/choose-a-policy.md",
        "docs/troubleshooting.md"
      ]
    ) {
      const doc = read(path)
      expect(doc, path).toContain("first poll")
      expect(doc, path).toContain("including the current occurrence")
      expect(doc, path).toContain("subsequent polls")
      expect(doc, path).toContain("subject to overlap")
      expect(doc, path).not.toContain("and still fires the current occurrence")
    }
  })

  it("states what the in-memory store shares with SQL and where it stops (documentation/6)", () => {
    const guide = read("docs/guides/testing.md")
    expect(guide).toContain("Both stores apply one shared claim decision")
    expect(guide).toContain("Registration validates the declaration and serializes its input at the call boundary")
    expect(guide).toContain("`list` and `listEnabled` order by id in both")
    expect(guide).toContain("never reports a `store` failure from a write")
    expect(guide).not.toContain("so a test that passes against this one is testing the protocol")
    const reference = read("docs/api.md")
    expect(reference).toContain("It applies the same claim decision as the SQL store")
    expect(reference).toContain("Registration validates the declaration and serializes its input at the call boundary")
    expect(reference).toContain("never reports a `store` failure from a write")
    expect(read("docs/concepts/claim-protocol.md")).toContain("apply one claim decision, not two implementations")
    expect(read("README.md")).toContain("It keeps no rows and applies no migrations")
  })

  it("documents accepted getters and their two evaluations (documentation/5)", () => {
    for (const path of ["docs/troubleshooting.md", "docs/api.md", "src/Trigger.ts"]) {
      const doc = read(path).replace(/ \* /g, " ")
      expect(doc, path).toContain("Enumerable getters are accepted")
      expect(doc, path).toContain("evaluated during decoding and again during SQL serialization")
    }
  })
})
