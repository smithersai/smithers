import { Effect } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it, vi } from "vitest"
import * as FileSet from "../src/FileSet.ts"
import * as EffectCandidates from "../src/internal/EffectCandidates.ts"
import { withCrypto } from "./Crypto.ts"
import { params } from "./FastCheckParams.ts"
import { compile, draft } from "./PlanFixtures.ts"

const tree = (path: string): FileSet.Entry => ({ _tag: "TreeArtifact", path })
const glob = (...include: Array<string>): FileSet.Entry => ({
  _tag: "Glob",
  include: include as [string, ...Array<string>]
})

describe("compiler file-effect candidates", () => {
  it("preserves exact, ancestor, descendant and Unicode/separator overlap without sibling prefixes", () => {
    const produced = [
      ["src/a.ts"],
      [tree("src/nested")],
      ["src/nested/deeper/b.ts"],
      ["src-other/a.ts"],
      ["caf\u00e9/x.ts"],
      [glob("**/*.ts")],
      [],
      [tree("src")],
      [tree("src/nested/deeper")]
    ]
    const candidates = EffectCandidates.make(produced)
    expect(candidates(["src\\a.ts"])).toEqual([0, 5, 7])
    expect(candidates(["src/nested/missing.ts"])).toEqual([1, 5, 7])
    expect(candidates([tree("src/nested")])).toEqual([1, 2, 5, 7, 8])
    expect(candidates([tree("src")])).toEqual([0, 1, 2, 5, 7, 8])
    expect(candidates(["cafe\u0301/x.ts"])).toEqual([4, 5])
    expect(candidates([tree("missing")])).toEqual([5])
    expect(candidates([glob("nothing/*")])).toEqual([0, 1, 2, 3, 4, 5, 7, 8])
    expect(candidates([])).toEqual([])
  })

  it("deduplicates owners and returns declaration order independently of path insertion order", () => {
    const candidates = EffectCandidates.make([
      ["z", "a", tree("nested")],
      ["a", "a", "z"],
      [tree("nested/deeper"), "nested/deeper/leaf"]
    ])
    expect(candidates(["z", "a", "z", tree("nested")])).toEqual([0, 1, 2])
    expect(candidates(["absent"])).toEqual([])
    expect(EffectCandidates.make([])([tree("src")])).toEqual([])
  })

  it("matches the existing exhaustive overlap oracle across generated declaration sets", () => {
    const segment = FastCheck.constantFrom(
      "src",
      "dist",
      "a",
      "b",
      "caf\u00e9",
      "cafe\u0301",
      "a.ts",
      "b.ts",
      "literal*"
    )
    const path = FastCheck.tuple(
      FastCheck.array(segment, { minLength: 1, maxLength: 4 }),
      FastCheck.constantFrom("/", "\\")
    ).map(([segments, separator]) => segments.join(separator))
    const declaration = FastCheck.oneof(
      path,
      path.map(tree),
      FastCheck.tuple(path, FastCheck.constantFrom("/*", "/**", "/**/*.ts")).map(([prefix, suffix]) => ({
        _tag: "Glob" as const,
        include: [prefix + suffix] as [string],
        exclude: ["**/b.ts"]
      }))
    )
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(FastCheck.array(declaration, { maxLength: 4 }), { maxLength: 40 }),
        FastCheck.array(declaration, { maxLength: 4 }),
        (produced, query) => {
          const overlaps = (entries: ReadonlyArray<FileSet.Entry>) =>
            query.some((left) => entries.some((right) => FileSet.overlaps(left, right)))
          const expected = produced.flatMap((entries, owner) => overlaps(entries) ? [owner] : [])
          const selected = EffectCandidates.make(produced)(query)
          expect(selected.filter((owner) => overlaps(produced[owner]!))).toEqual(expected)
        }
      ),
      params(1_000, 20260904)
    )
  })

  it("walks deep trees without recursive traversal", () => {
    const path = Array.from({ length: 10_000 }, () => "a").join("/")
    const candidates = EffectCandidates.make([[path], [tree(path)]])
    expect(candidates([tree("a")])).toEqual([0, 1])
    expect(candidates([path])).toEqual([0, 1])
  })

  it("keeps glob exclusions authoritative when conservative candidates reach the compiler", async () => {
    const patternWriter = {
      ...draft("pattern"),
      effects: {
        reads: [],
        writes: [{ _tag: "Glob" as const, include: ["src/**/*.ts"] as [string], exclude: ["src/excluded.ts"] }],
        boundaryMode: "hard" as const
      }
    }
    const plan = await Effect.runPromise(withCrypto(compile([
      patternWriter,
      draft("other", { writes: ["other.txt"] }),
      draft("excluded", { writes: ["src/excluded.ts"] }),
      draft("reader", { reads: ["other.txt", "src/excluded.ts", "unwritten.txt"] })
    ])))
    expect(plan.nodes.map((node) => ({ id: node.id, edges: node.dependsOn, conflicts: node.conflicts }))).toEqual([
      { id: "pattern", edges: [], conflicts: [] },
      { id: "other", edges: [], conflicts: [] },
      { id: "excluded", edges: [], conflicts: [] },
      { id: "reader", edges: ["other", "excluded"], conflicts: [] }
    ])
  })

  it("compiles 1,000 independent producer/reader pairs with linear exact overlap checks", async () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => [
      draft(`producer-${index}`, { writes: [`out/${index}.json`] }),
      draft(`reader-${index}`, { reads: [`out/${index}.json`] })
    ]).flat()
    const overlap = vi.spyOn(FileSet, "overlaps")
    try {
      const plan = await Effect.runPromise(withCrypto(compile(nodes, "partitioned-2000")))
      expect(plan.nodes.map((node) => ({ id: node.id, edges: node.dependsOn, conflicts: node.conflicts }))).toEqual(
        Array.from({ length: 1_000 }, (_, index) => [
          { id: `producer-${index}`, edges: [], conflicts: [] },
          { id: `reader-${index}`, edges: [`producer-${index}`], conflicts: [] }
        ]).flat()
      )
      expect(plan.nodes.every((node) => node.key.startsWith("key1_"))).toBe(true)
      // Exhaustive passes perform 499,500 writer comparisons and 1,000,000
      // reader comparisons here. Only the 1,000 real read edges need a check.
      expect(overlap).toHaveBeenCalledTimes(1_000)
    } finally {
      overlap.mockRestore()
    }
  })
})
