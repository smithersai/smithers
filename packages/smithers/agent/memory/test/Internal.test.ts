import * as Digest from "@smthrs/core/Digest"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Bank from "../src/internal/Bank.ts"
import * as Namespace from "../src/Namespace.ts"
import * as Ranking from "../src/internal/Ranking.ts"
import * as Text from "../src/internal/Text.ts"

describe("memory internal helpers", () => {
  it("normalizes text and hashes every JavaScript string with SHA-256", () => {
    expect(Text.compareText("a", "b")).toBe(-1)
    expect(Text.compareText("b", "a")).toBe(1)
    expect(Text.compareText("a", "a")).toBe(0)
    expect(Text.wellFormed("a\uD800b\uDC00c\uD83D\uDE00")).toBe("a\uFFFDb\uFFFDc\uD83D\uDE00")
    expect(Text.digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(Text.digest("\uD800")).toBe(Digest.digest("\uFFFD"))
  })

  it("extracts searchable text and retained string tags", () => {
    expect(Text.searchableText("root")).toBe("root")
    expect(Text.searchableText({ content: "body", tags: ["scope:x"] })).toBe("body")
    expect(Text.searchableText({ other: "value" })).toBe("{\"other\":\"value\"}")
    expect(Text.searchableText(undefined)).toBe("")
    expect(Text.retainedTags({ tags: ["scope:x", 1, "branch:main"] })).toEqual(["scope:x", "branch:main"])
    expect(Text.retainedTags(null)).toEqual([])
  })

  it("encodes vectors explicitly little-endian and truncates on UTF-8 boundaries", () => {
    expect([...Text.vectorBytes([1, -2, 0.5])]).toEqual([
      0,
      0,
      128,
      63,
      0,
      0,
      0,
      192,
      0,
      0,
      0,
      63
    ])
    expect(Text.truncateBytes("a\u00E9\uD83D\uDE00z", 7)).toBe("a\u00E9\uD83D\uDE00")
    expect(Text.truncateBytes("a\u00E9", 2)).toBe("a")
  })

  it("scores cosine similarity and recency decay at their boundaries", () => {
    const withHole = JSON.parse("[null, 1]") as ReadonlyArray<number>
    expect(Ranking.cosine([], [])).toBe(0)
    expect(Ranking.cosine([1, 0], [1])).toBe(0)
    expect(Ranking.cosine([0, 0], [1, 0])).toBe(0)
    expect(Ranking.cosine([1, 0], [0, 0])).toBe(0)
    expect(Ranking.cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(Ranking.cosine([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(Ranking.cosine(withHole, [0, 1])).toBeCloseTo(1)
    expect(Ranking.cosine([0, 1], withHole)).toBeCloseTo(1)
    expect(Ranking.recency(10, 5, 1_000)).toBe(1)
    expect(Ranking.recency(0, 0, 1_000)).toBe(1)
    expect(Ranking.recency(0, 1_000, 1_000)).toBeCloseTo(0.5)
    expect(Ranking.recency(0, 2_000, 1_000)).toBeCloseTo(0.25)
    expect(Ranking.recency(0, 3_000, 1_000)).toBeCloseTo(0.125)
    expect(Ranking.recency(0, 7 * 86_400_000, 7 * 86_400_000)).toBeCloseTo(0.5)
  })

  it("truncates to a byte budget without splitting a code point", () => {
    expect(Text.truncateBytes("h\u00E9llo", 6)).toBe("h\u00E9llo")
    expect(Text.truncateBytes("h\u00E9llo", 7)).toBe("h\u00E9llo")
    expect(Text.truncateBytes("h\u00E9llo", 2)).toBe("h")
    expect(Text.truncateBytes("h\u00E9llo", 0)).toBe("")
    expect(Text.truncateBytes("\uD83D\uDE00\uD83D\uDE00", 4)).toBe("\uD83D\uDE00")
  })

  it("always treats FTS query text as data", () => {
    expect(Text.literalFtsQuery("alpha beta")).toBe("\"alpha\" \"beta\"")
    expect(Text.literalFtsQuery("\"alpha beta\"")).toBe("\"\"\"alpha\" \"beta\"\"\"")
    expect(Text.literalFtsQuery(" alpha\0beta ")).toBe("\"alpha\" \"beta\"")
    expect(Text.literalFtsQuery("\uD800")).toBe("\"\uFFFD\"")
  })

  it("validates structured namespaces and resolves every bank form", async () => {
    const resolved = await Effect.runPromise(Effect.all([
      Bank.resolveNamespace({ kind: "agent", id: "worker" }),
      Bank.resolveNamespace("user-person"),
      Bank.resolveNamespace("flow-"),
      Bank.resolveNamespace("plain")
    ]))
    const empty = await Effect.runPromise(Effect.flip(Bank.resolveNamespace("")))
    const invalid = await Effect.runPromise(Effect.flip(
      Bank.resolveNamespace({ kind: "flow", id: "" })
    ))

    expect(resolved).toEqual([
      { namespace: { kind: "agent", id: "worker" }, bank: "agent-worker" },
      { namespace: { kind: "user", id: "person" }, bank: "user-person" },
      { namespace: { kind: "flow", id: "flow-" }, bank: "flow-" },
      { namespace: { kind: "flow", id: "plain" }, bank: "plain" }
    ])
    expect(empty.code).toBe("invalid_namespace")
    expect(invalid.code).toBe("invalid_namespace")
  })

  it("formats and parses banks with one pair the validating resolver reuses", async () => {
    for (const kind of Namespace.Kind.literals) {
      const namespace = { kind, id: "id" } as const
      const bank = Bank.bankForNamespace(namespace)
      expect(bank).toBe(`${kind}-id`)
      expect(Bank.namespaceForBank(bank)).toEqual(namespace)
      expect(await Effect.runPromise(Bank.resolveNamespace(bank))).toEqual({ namespace, bank })
      expect(await Effect.runPromise(Bank.resolveNamespace(namespace))).toEqual({ namespace, bank })
    }
    expect(Bank.namespaceForBank("plain")).toEqual({ kind: "flow", id: "plain" })
    expect(Bank.namespaceForBank("user-")).toEqual({ kind: "flow", id: "user-" })
  })
})
