import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Bank from "../src/Bank.ts"
import * as Namespace from "../src/Namespace.ts"

const leaf = (): Namespace.TagGroup => ({ tags: ["scope:project"] })

const nested = (depth: number): Namespace.TagGroup => {
  let group = leaf()
  for (let level = 1; level < depth; level++) group = { not: group }
  return group
}

const wide = (nodes: number): Namespace.TagGroup => ({
  or: Array.from({ length: nodes - 1 }, leaf)
})

describe("Namespace", () => {
  it("parses banks through the validating public counterpart", async () => {
    await expect(Effect.runPromise(Bank.parse("agent-worker"))).resolves.toEqual({ kind: "agent", id: "worker" })
    const failure = await Effect.runPromise(Effect.flip(Bank.parse("")))
    expect(failure.code).toBe("invalid_namespace")
  })

  it("decodes the four structured namespace kinds", () => {
    const decode = Schema.decodeUnknownSync(Namespace.Namespace)
    for (const kind of ["flow", "agent", "user", "global"] as const) {
      expect(decode({ kind, id: "bank-1" })).toEqual({ kind, id: "bank-1" })
    }
    expect(() => decode({ kind: "run", id: "bank-1" })).toThrow()
    expect(() => decode({ kind: "flow", id: "" })).toThrow()
  })

  it("enforces the tag vocabulary and 16-tag cap", () => {
    const decode = Schema.decodeUnknownSync(Namespace.Tags)
    expect(decode(["branch:main", "stream:checkout", "source:run", "scope:project"])).toEqual([
      "branch:main",
      "stream:checkout",
      "source:run",
      "scope:project"
    ])
    expect(() => decode(["custom:value"])).toThrow()
    expect(() => decode(["scope:"])).toThrow()
    expect(() => decode(Array.from({ length: 17 }, (_, index) => `scope:${index}`))).toThrow()
  })

  it("evaluates leaf match modes with Smithers wildcard semantics", () => {
    const tags = ["branch:main", "scope:project"]
    expect(Namespace.matches({ tags: ["branch:main"] }, tags)).toBe(true)
    expect(Namespace.matches({ tags: ["branch:other"] }, [])).toBe(true)
    expect(Namespace.matches({ tags: ["branch:main", "scope:other"], match: "all" }, tags)).toBe(false)
    expect(Namespace.matches({ tags: ["branch:main"], match: "all" }, [])).toBe(true)
    expect(Namespace.matches({ tags: ["branch:main"], match: "any_strict" }, [])).toBe(false)
    expect(Namespace.matches({ tags: ["branch:main", "scope:project"], match: "all_strict" }, tags)).toBe(true)
    expect(Namespace.matches({ tags: ["branch:main"], match: "exact" }, tags)).toBe(false)
    expect(
      Namespace.matches({ tags: ["scope:project", "branch:main"], match: "exact" }, tags)
    ).toBe(true)
  })

  it("combines tag groups with and, or, and not", () => {
    const group: Namespace.TagGroup = {
      and: [
        {
          or: [
            { tags: ["branch:main"], match: "all_strict" },
            { tags: ["branch:release"], match: "all_strict" }
          ]
        },
        { not: { tags: ["scope:secret"], match: "any_strict" } }
      ]
    }
    expect(Namespace.matches(group, ["branch:main", "scope:project"])).toBe(true)
    expect(Namespace.matches(group, ["branch:main", "scope:secret"])).toBe(false)
    expect(Namespace.matches(group, ["branch:feature", "scope:project"])).toBe(false)
    expect(Schema.decodeUnknownSync(Namespace.TagGroup)(group)).toEqual(group)
  })

  it("accepts the exact tag-group depth limit and rejects the next level without overflowing", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    expect(decode(nested(Namespace.MAX_TAG_GROUP_DEPTH))).toEqual(nested(Namespace.MAX_TAG_GROUP_DEPTH))

    let failure: unknown
    try {
      decode(nested(Namespace.MAX_TAG_GROUP_DEPTH + 1))
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeDefined()
    expect(failure).not.toBeInstanceOf(RangeError)
    expect(String(failure)).toContain("invalid_tag")
  })

  it("accepts the exact tag-group node limit and rejects one additional wide node", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    expect(decode(wide(Namespace.MAX_TAG_GROUP_NODES))).toEqual(wide(Namespace.MAX_TAG_GROUP_NODES))
    expect(() => decode(wide(Namespace.MAX_TAG_GROUP_NODES + 1))).toThrow(/invalid_tag/u)
  })

  it("rejects an over-wide and-group and a budget overrun that no lookahead catches", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    const wideAnd = (nodes: number): unknown => ({ and: Array.from({ length: nodes - 1 }, leaf) })
    expect(decode(wideAnd(Namespace.MAX_TAG_GROUP_NODES))).toEqual(wideAnd(Namespace.MAX_TAG_GROUP_NODES))
    expect(() => decode(wideAnd(Namespace.MAX_TAG_GROUP_NODES + 1))).toThrow(/invalid_tag/u)

    // `not` carries no child-count lookahead, so this is the shape whose budget
    // overrun is only discovered when the last node is actually visited.
    const lateOverrun = {
      or: [...Array.from({ length: Namespace.MAX_TAG_GROUP_NODES - 2 }, leaf), { not: leaf() }]
    }
    expect(() => decode(lateOverrun)).toThrow(/node count exceeds/u)
  })

  it("refuses a tag group whose shape is not a tag group at all", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    for (
      const malformed of [
        null,
        "scope:project",
        { tags: ["not-a-vocabulary-tag"] },
        { tags: ["scope:project"], match: "sideways" },
        { and: "not-an-array" },
        { or: "not-an-array" },
        { unknown: true }
      ]
    ) {
      expect(() => decode(malformed)).toThrow()
    }
  })

  // A decoded group is schema-valid by construction, so `matches` must never
  // answer false for it on budget grounds. The reference evaluator is a plain
  // recursion over the same tree, so the two can only disagree on bookkeeping.
  it("evaluates decoded groups at the node budget exactly as a reference evaluator does", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    const reference = (group: Namespace.TagGroup, record: ReadonlyArray<string>): boolean =>
      "tags" in group
        ? record.length > 0 && group.tags.every((tag) => record.includes(tag))
        : "and" in group
        ? group.and.every((child) => reference(child, record))
        : "or" in group
        ? group.or.some((child) => reference(child, record))
        : !reference(group.not, record)
    const miss = (): Namespace.TagGroup => ({ tags: ["scope:secret"], match: "all_strict" })
    const flatOr = (nodes: number): unknown => ({ or: [...Array.from({ length: nodes - 2 }, miss), leaf()] })
    const nestedAndOr = (nodes: number): unknown => ({
      and: [{ or: [...Array.from({ length: nodes - 5 }, miss), leaf()] }, { not: miss() }]
    })
    for (const nodes of [Namespace.MAX_TAG_GROUP_NODES - 1, Namespace.MAX_TAG_GROUP_NODES]) {
      for (const shape of [flatOr(nodes), nestedAndOr(nodes)]) {
        const group = decode(shape)
        for (const record of [["scope:project"], ["branch:main"]]) {
          expect(Namespace.matches(group, record)).toBe(reference(group, record))
        }
        expect(Namespace.matches(group, ["scope:project"])).toBe(true)
      }
    }
    expect(() => decode(flatOr(Namespace.MAX_TAG_GROUP_NODES + 1))).toThrow(/node count exceeds/u)
    expect(() => decode(nestedAndOr(Namespace.MAX_TAG_GROUP_NODES + 1))).toThrow(/node count exceeds/u)
  })

  // The schema and `matches` share one walk, so their budget boundaries must be
  // the same boundary. This pins the depth ceiling the way the case above pins
  // the node ceiling: a group the decoder accepts at exactly
  // MAX_TAG_GROUP_DEPTH has to evaluate, never be refused on budget grounds.
  it("evaluates decoded groups at the depth budget exactly as a reference evaluator does", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    for (const depth of [1, 2, Namespace.MAX_TAG_GROUP_DEPTH - 1, Namespace.MAX_TAG_GROUP_DEPTH]) {
      const group = decode(nested(depth))
      // `nested` adds one `not` per level, so an odd depth keeps the leaf's
      // answer and an even depth inverts it.
      expect(Namespace.matches(group, ["scope:project"])).toBe(depth % 2 === 1)
      expect(Namespace.matches(group, ["branch:main"])).toBe(depth % 2 === 0)
    }
  })

  it("evaluates an undecoded over-budget group as false without recursive stack growth", () => {
    expect(Namespace.matches(nested(500), ["scope:project"])).toBe(false)
  })

  // `matches` takes a decoded `TagGroup` by type, but store consumers can hand
  // it a value that never passed the schema. It answers false rather than
  // throwing, so a malformed group cannot kill the fiber reading memory.
  it("answers false for a malformed group instead of throwing", () => {
    const tags = ["scope:project"]
    expect(Namespace.matches({ tags: ["not-a-vocabulary-tag"] } as unknown as Namespace.TagGroup, tags)).toBe(false)
    expect(Namespace.matches({ tags: tags, match: "sideways" } as unknown as Namespace.TagGroup, tags)).toBe(false)
    expect(Namespace.matches({ unknown: true } as unknown as Namespace.TagGroup, tags)).toBe(false)
    expect(Namespace.matches({ and: "not-an-array" } as unknown as Namespace.TagGroup, tags)).toBe(false)
    expect(Namespace.matches(wide(Namespace.MAX_TAG_GROUP_NODES + 2), tags)).toBe(false)
  })
})
