/** Independent comparison with the compiler's former exhaustive owner walk. */
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import * as FileSet from "../src/FileSet.ts"
import * as Candidates from "../src/internal/EffectCandidates.ts"
import * as Plan from "../src/Plan.ts"
import { compile, draft } from "../src/test/PlanFixtures.ts"
import { withCrypto } from "./Crypto.ts"

const tree = (path: string): FileSet.Entry => ({ _tag: "TreeArtifact", path })
const glob = (include: string, exclude?: Array<string>): FileSet.Glob => ({
  _tag: "Glob",
  include: [include],
  ...(exclude === undefined ? {} : { exclude })
})
const outcome = (program: ReturnType<typeof Plan.compile>) =>
  Effect.runPromise(withCrypto(program.pipe(Effect.match({
    onFailure: (error) => ({
      outcome: "failure",
      tag: error._tag,
      code: "code" in error ? error.code : undefined,
      message: error.message
    }),
    onSuccess: (plan) => ({ outcome: "success", plan: JSON.parse(JSON.stringify(plan)) as Plan.Plan })
  }))))
const compare = async (program: () => ReturnType<typeof Plan.compile>) => {
  const actual = await outcome(program())
  const exhaustive = vi.spyOn(Candidates, "make").mockImplementation((produced) => () =>
    produced.map((_, index) => index)
  )
  try {
    expect(actual).toEqual(await outcome(program()))
  } finally {
    exhaustive.mockRestore()
  }
  return actual
}

it("never omits an exhaustive overlap across unusual valid path and declaration pairs", () => {
  const paths = [
    "a",
    "a/b",
    "a/b/c",
    "a-other",
    "a.b",
    "literal*",
    "constructor",
    "__proto__",
    "caf\u00e9/x",
    "cafe\u0301\\x",
    "\u00c5/x",
    "A\u030a/x",
    "\u0085/file",
    "\u2028/file",
    "\ud800/x",
    "emoji-\u{1f680}/x"
  ]
  expect(paths.every(FileSet.workspaceRelative)).toBe(true)
  const entries = [
    ...paths,
    ...paths.map(tree),
    glob("**"),
    glob("a/**", ["**"]),
    glob("cafe\u0301/**", ["**/x"]),
    glob("literal*"),
    glob("**/x", ["a/**"])
  ]
  const produced = entries.map((entry) => [entry])
  const select = Candidates.make(produced)
  for (const query of entries) {
    const candidates = select([query])
    expect([...new Set(candidates)]).toEqual(candidates)
    expect([...candidates].sort((a, b) => a - b)).toEqual(candidates)
    expect(candidates.filter((index) => FileSet.overlaps(query, entries[index]!))).toEqual(
      entries.flatMap((entry, index) => FileSet.overlaps(query, entry) ? [index] : [])
    )
  }
})

it("preserves full plans, frozen prefixes, future writer edges, imported verification and keys", async () => {
  const program = () =>
    Effect.gen(function*() {
      const base = yield* compile([
        { ...draft("frozen-tree"), effects: { reads: [], writes: [tree("caf\u00e9")], boundaryMode: "hard" } },
        draft("frozen-reader", { reads: ["future-only"] })
      ], "independent-append")
      const prefix = JSON.stringify(base.nodes)
      const grown = yield* Plan.append(base, [
        draft("reader", { reads: ["cafe\u0301\\file", "later/output", "stale"] }),
        draft("future-writer", { writes: ["later/output", "future-only"] }),
        draft("remover", { removes: ["stale"] }),
        draft("new-conflict", { writes: ["caf\u00e9/file"] })
      ])
      expect(JSON.stringify(grown.nodes.slice(0, 2))).toBe(prefix)
      expect(grown.nodes[2]!.dependsOn).toEqual(["frozen-tree", "future-writer", "remover", "new-conflict"])
      expect(grown.nodes[1]!.dependsOn).toEqual([])
      expect(grown.nodes[5]!.dependsOn).toEqual(["frozen-tree"])
      expect(grown.nodes.slice(0, 2).map((node) => node.key)).toEqual(base.nodes.map((node) => node.key))
      return yield* Plan.verify(JSON.parse(JSON.stringify(grown)))
    })
  expect((await compare(program)).outcome).toBe("success")
})

it("preserves the first overlap refusal and inferred future-writer cycle diagnostic", async () => {
  const forbidden = await compare(() =>
    compile([
      draft("earliest", { writes: ["z", "a"], conflictStrategy: "fail" }),
      draft("second", { writes: ["a", "z"], conflictStrategy: "fail" }),
      draft("third", { writes: ["a"] })
    ])
  )
  expect(forbidden).toMatchObject({
    outcome: "failure",
    code: "overlap_forbidden",
    message: "Nodes earliest and second both write z, a"
  })
  const cycle = await compare(() =>
    compile([
      draft("reader", { reads: ["out"], writes: ["shared"] }),
      draft("writer", { writes: ["out", "shared"] })
    ])
  )
  expect(cycle).toMatchObject({ outcome: "failure", code: "cycle" })
  expect("message" in cycle ? cycle.message : undefined).toContain("through writer -> reader")
})

it("matches complete compiled results and errors for deterministic generated graphs", async () => {
  let state = 0x5eeda11
  const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0
  const paths = ["a", "a/child", "b", "caf\u00e9/x", "cafe\u0301\\x", "constructor"]
  const outputs: Array<FileSet.Entry> = [
    ...paths,
    tree("a"),
    tree("caf\u00e9"),
    glob("**/x"),
    glob("a/**", ["a/child"])
  ]
  const reads: Array<FileSet.ReadEntry> = [...paths, glob("**/x"), glob("a/**", ["a/child"])]
  let successes = 0
  let failures = 0
  for (let iteration = 0; iteration < 120; iteration++) {
    const count = 2 + next() % 7
    const nodes = Array.from({ length: count }, (_, index): Plan.NodeDraft => {
      const read = next() % 3 === 0 ? [reads[next() % reads.length]!] : []
      const write = next() % 3 === 0 ? [] : [outputs[next() % outputs.length]!]
      const remove = next() % 5 === 0 ? [paths[next() % paths.length]!] : []
      const material = index > 0 && next() % 4 === 0 ? [{ _tag: "Pending" as const, from: `n${next() % index}` }] : []
      return {
        ...draft(`n${index}`, {
          inputs: material,
          conflictStrategy: (["serialize", "lane", "fail"] as const)[next() % 3]
        }),
        effects: {
          reads: read,
          writes: [{ _tag: "Filegroup", name: "generated", entries: write }],
          removes: remove,
          boundaryMode: "hard"
        }
      }
    })
    const result = await compare(() => compile(nodes, `generated-${iteration}`))
    if (result.outcome === "success") successes++
    else failures++
  }
  expect(successes).toBeGreaterThan(20)
  expect(failures).toBeGreaterThan(20)
})
