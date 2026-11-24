import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Load from "../src/Load.ts"
import { host, minimal, owned } from "./support/hostFacts.ts"

const load = (candidates: ReadonlyArray<Load.Candidate>, facts: Load.HostFacts = host()) =>
  Effect.runPromise(Load.load(facts, candidates))

const at = (tier: Load.Candidate["tier"]) => (manifest: unknown, flows?: ReadonlyArray<Load.OwnedFlow>) =>
  flows === undefined ? { tier, manifest } : { tier, manifest, flows }
const builtIn = at("built-in")
const repository = at("repository")
const personal = at("personal")

const requires = (...ids: ReadonlyArray<string>) => ({
  requires: { api: "^1.0.0", plugins: Object.fromEntries(ids.map((id) => [id, "*"])) }
})

const summary = (loaded: Load.Loaded) => loaded.refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.path])

describe("a refused candidate keeps its id", () => {
  it("refuses a repository plugin named like a built-in that failed requires.api", async () => {
    const loaded = await load([
      builtIn(minimal("queue", { requires: { api: "^9.0.0" } })),
      repository(minimal("queue"))
    ])
    expect(loaded.contributions.plugins).toEqual([])
    expect(summary(loaded)).toEqual([
      ["queue", "incompatible", "requires.api"],
      ["queue", "conflict", "id"]
    ])
    expect(loaded.refused[1]!.detail).toBe("repository plugin queue shares its id with a refused built-in plugin")
  })

  it("refuses a plugin named like an undecodable manifest of its own or a higher tier", async () => {
    const broken = { ...minimal("queue"), extra: 1 }
    expect(summary(await load([repository(broken), personal(minimal("queue"))]))).toEqual([
      ["queue", "invalid", "extra"],
      ["queue", "conflict", "id"]
    ])
    expect(summary(await load([personal(broken), personal(minimal("queue"))]))).toEqual([
      ["queue", "invalid", "extra"],
      ["queue", "conflict", "id"]
    ])
  })

  it("lets a higher tier load past a refused lower-tier holder of its id", async () => {
    const loaded = await load([personal({ ...minimal("queue"), extra: 1 }), builtIn(minimal("queue"))])
    expect(loaded.contributions.plugins.map((plugin) => [plugin.id, plugin.tier])).toEqual([["queue", "built-in"]])
    expect(summary(loaded)).toEqual([["queue", "invalid", "extra"]])
  })

  it("names the highest refused holder, whatever the input order", async () => {
    const broken = { ...minimal("queue"), extra: 1 }
    for (const refused of [[repository(broken), builtIn(broken)], [builtIn(broken), repository(broken)]]) {
      const loaded = await load([...refused, personal(minimal("queue"))])
      expect(loaded.refused.at(-1)!.detail).toBe("personal plugin queue shares its id with a refused built-in plugin")
    }
  })

  it("does not hold the id of a plugin refused only for a flow tag outside its namespace", async () => {
    const loaded = await load(
      [repository(minimal("aa"), [owned("zz/flow")]), personal(minimal("aa"))],
      host({ points: ["flows"] })
    )
    expect(loaded.contributions.plugins.map((plugin) => [plugin.id, plugin.tier])).toEqual([["aa", "personal"]])
    expect(summary(loaded)).toEqual([["aa", "invalid", "flows"]])
  })
})

describe("dependency order at scale", () => {
  it("orders ready plugins by tier, then id, as dependencies release them", async () => {
    const ids = ["mm", "cc", "xx", "aa", "tt", "ee", "kk", "bb", "zz", "gg", "pp", "dd"]
    const loaded = await load([
      ...ids.map((id) => personal(minimal(id, requires("root")))),
      repository(minimal("late", requires("mm"))),
      repository(minimal("early")),
      repository(minimal("both", requires("root", "early"))),
      builtIn(minimal("root"))
    ])
    expect(loaded.refused).toEqual([])
    expect(loaded.contributions.plugins.map((plugin) => plugin.id)).toEqual([
      "root",
      "early",
      "both",
      "aa",
      "bb",
      "cc",
      "dd",
      "ee",
      "gg",
      "kk",
      "mm",
      "late",
      "pp",
      "tt",
      "xx",
      "zz"
    ])
  })

  it("tells a cycle's members from the plugins that only wait on one", async () => {
    const loaded = await load([
      builtIn(minimal("behind", requires("one"))),
      builtIn(minimal("one", requires("two"))),
      builtIn(minimal("two", requires("one", "bridge"))),
      builtIn(minimal("bridge", requires("self", "three"))),
      builtIn(minimal("self", requires("self"))),
      builtIn(minimal("three", requires("four"))),
      builtIn(minimal("four", requires("three"))),
      builtIn(minimal("after", requires("one", "four"))),
      builtIn(minimal("free"))
    ])
    expect(loaded.contributions.plugins.map((plugin) => plugin.id)).toEqual(["free"])
    expect(summary(loaded)).toEqual([
      ["after", "missing_dependency", "requires.plugins"],
      ["behind", "missing_dependency", "requires.plugins"],
      ["bridge", "missing_dependency", "requires.plugins"],
      ["four", "cycle", "requires.plugins"],
      ["one", "cycle", "requires.plugins"],
      ["self", "cycle", "requires.plugins"],
      ["three", "cycle", "requires.plugins"],
      ["two", "cycle", "requires.plugins"]
    ])
  })

  it("refuses a chain of the maximum length that ends in a cycle, without recursion", async () => {
    const last = Load.maximumCandidates - 1
    const loaded = await load(
      Array.from(
        { length: Load.maximumCandidates },
        (_, index) => builtIn(minimal(`p${index}`, requires(`p${index === last ? last - 1 : index + 1}`)))
      )
    )
    expect(loaded.contributions.plugins).toEqual([])
    expect(loaded.refused).toHaveLength(Load.maximumCandidates)
    expect(loaded.refused.filter((refusal) => refusal.reason === "cycle").map((refusal) => refusal.plugin)).toEqual([
      `p${last - 1}`,
      `p${last}`
    ])
    expect(loaded.refused.filter((refusal) => refusal.reason === "missing_dependency")).toHaveLength(last - 1)
  })

  it("returns refusals for 20,000 chained manifests ending in a cycle", async () => {
    const count = 20_000
    const loaded = await load(
      Array.from(
        { length: count },
        (_, index) => builtIn(minimal(`p${index}`, requires(`p${index === count - 1 ? count - 2 : index + 1}`)))
      )
    )
    expect(loaded.contributions.plugins).toEqual([])
    expect(loaded.refused).toHaveLength(count)
    const over = loaded.refused.filter((refusal) => refusal.detail.startsWith("one load considers at most"))
    expect(over).toHaveLength(count - Load.maximumCandidates)
    expect(over[0]).toMatchObject({ reason: "invalid", detail: "one load considers at most 1024 plugins" })
    expect(over[0]!.path).toBeUndefined()
    expect(new Set(loaded.refused.map((refusal) => refusal.reason))).toEqual(new Set(["invalid", "missing_dependency"]))
  })

  it("keeps candidates by tier, then input order, past the maximum, and holds the ids it drops", async () => {
    const loaded = await load([
      personal(5),
      ...Array.from({ length: Load.maximumCandidates - 3 }, (_, index) => personal(minimal(`p${index}`))),
      personal(minimal("kept")),
      personal(minimal("dropped")),
      personal(null),
      builtIn(minimal("base"))
    ])
    const active = loaded.contributions.plugins.map((plugin) => plugin.id)
    expect(active).toHaveLength(Load.maximumCandidates - 1)
    expect(active[0]).toBe("base")
    expect(active).toContain("kept")
    expect(loaded.refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.detail])).toEqual([
      [undefined, "invalid", expect.not.stringContaining("at most")],
      [undefined, "invalid", "one load considers at most 1024 plugins"],
      ["dropped", "invalid", "one load considers at most 1024 plugins"]
    ])

    const shadowed = await load([
      ...Array.from({ length: Load.maximumCandidates - 1 }, (_, index) => personal(minimal(`p${index}`))),
      personal(minimal("twin")),
      personal(minimal("twin"))
    ])
    expect(shadowed.refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.path])).toEqual([
      ["twin", "invalid", undefined],
      ["twin", "conflict", "id"]
    ])
  })
})
