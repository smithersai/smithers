import { existsSync, readdirSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import {
  openCodeBehaviorInventory,
  requiredOpenCodeBehaviors,
  requiredOpenCodeSources,
  rows
} from "./support/ParityManifest.ts"

// Manifest rows keep their former superproject-relative `flows/` or `agent/`
// prefix, but the files they name now live in this repository, so they resolve
// against the repo root. That stays correct in the canonical checkout, in
// isolated worktrees, and on CI.
//
// The OpenCode corpus is an unpinned external clone, so reading it is opt-in:
// point `FLOWS_OPENCODE_CORPUS` at the directory holding the `opencode/` clone
// to run the drift checks that compare the vendored inventory in
// `test/support/ParityManifest.ts` against the live sources. Probing the
// filesystem for it instead made one commit produce two different suites: a
// checkout whose `reference/` held some other corpus crashed on ENOENT, and
// CI, which has no `reference/` at all, skipped both checks without saying so.
// The inventory those checks guard is vendored, so every checkout runs the
// same suite over the same data whether or not a clone is present.
const repositoryRoot = new URL("../../../", import.meta.url)
const corpusSources = "opencode/packages/smithers/flows/core/test/"
const namedCorpus = process.env["FLOWS_OPENCODE_CORPUS"]
const corpusRoot = namedCorpus === undefined || namedCorpus.trim() === ""
  ? undefined
  : new URL(namedCorpus.endsWith("/") ? namedCorpus : `${namedCorpus}/`, pathToFileURL(`${process.cwd()}/`))

// A directory is a corpus when it holds the sources the scrape reads, not when
// it merely exists.
const hasCorpusSources = (root: URL): boolean => existsSync(new URL(corpusSources, root))

// A corpus that was named and is not there is a red, never a skip: this run was
// asked for the drift check and could not perform it.
const requireCorpus = (root: URL): URL => {
  expect(hasCorpusSources(root), `FLOWS_OPENCODE_CORPUS=${namedCorpus} has no ${corpusSources}`).toBe(true)
  return new URL(corpusSources, root)
}
const testFile = /\.test\.ts$/

describe("ParityManifest", () => {
  it("maps every test-file entry to a file in the repository", () => {
    for (const row of rows) {
      if (!testFile.test(row.flowsEquivalent)) continue
      expect(
        existsSync(new URL(row.flowsEquivalent.replace(/^(?:agent|flows)\//, ""), repositoryRoot)),
        row.flowsEquivalent
      ).toBe(true)
    }
  })

  it("explains every incomplete parity claim", () => {
    for (const row of rows) {
      if (row.status === "pinned") continue
      expect(row.reason?.trim(), `${row.source}: ${row.behavior}`).toBeTruthy()
    }
  })

  it("does not duplicate external behavior claims", () => {
    const claims = rows.map((row) => `${row.source}\u0000${row.behavior}`)
    expect(new Set(claims).size).toBe(claims.length)
  })

  it("accounts for every ranked Smithers conformance row", () => {
    const ranks = new Set(
      rows.flatMap((row) => {
        const match = /^smithers #(\d+)\b/.exec(row.source)
        return match === null ? [] : [Number(match[1])]
      })
    )
    expect([...ranks].filter((rank) => rank >= 1 && rank <= 14).sort((left, right) => left - right)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14
    ])
  })

  // A directory that happens to be called `reference/`, or a repository root
  // with any sibling at all, used to be accepted as the corpus; the scrape then
  // read a path inside it that does not exist and the target went red on
  // ENOENT. The probe names the directory the scrape actually reads.
  it("accepts a corpus root only when it holds the sources the scrape reads", () => {
    expect(hasCorpusSources(new URL("packages/testing/", repositoryRoot))).toBe(false)
    expect(hasCorpusSources(repositoryRoot)).toBe(false)
  })

  // The vendored inventory is what every checkout reads, so its shape is
  // asserted here rather than only where a clone happens to exist.
  it("vendors a behavior inventory for every targeted OpenCode source", () => {
    expect(requiredOpenCodeSources.length).toBeGreaterThan(0)
    for (const source of requiredOpenCodeSources) {
      const behaviors = openCodeBehaviorInventory[source as keyof typeof openCodeBehaviorInventory]
      expect(behaviors.length, source).toBeGreaterThan(0)
      expect(new Set(behaviors).size, source).toBe(behaviors.length)
    }
  })

  it.skipIf(corpusRoot === undefined)("accounts for every targeted OpenCode session source", () => {
    if (corpusRoot === undefined) return
    const sourceDirectory = requireCorpus(corpusRoot)
    const discovered = readdirSync(sourceDirectory)
      .filter((name) =>
        /^session-(?:runner.*|tool-progress|create|prompt|projector|compaction|todo|run-coordinator|history)\.test\.ts$/
          .test(
            name
          )
      )
      .map((name) => `packages/smithers/flows/core/test/${name}`)
      .sort()
    expect([...requiredOpenCodeSources].sort()).toEqual(discovered)
  })

  it.skipIf(corpusRoot === undefined)("inventories every static behavior in each targeted OpenCode source", () => {
    if (corpusRoot === undefined) return
    requireCorpus(corpusRoot)
    for (const source of requiredOpenCodeSources) {
      const text = readFileSync(new URL(`opencode/${source}`, corpusRoot), "utf8")
      const discovered = [
        ...new Set(
          [...text.matchAll(/\b(?:test|it)(?:\.effect)?\(\s*(["'`])((?:(?!\1)[\s\S])*?)\1/g)].map(
            (match) => (match[2] ?? "").replace(/\s+/g, " ").trim()
          )
        )
      ].sort()
      expect(
        [...openCodeBehaviorInventory[source as keyof typeof openCodeBehaviorInventory]].sort(),
        source
      ).toEqual(discovered)
    }
  })

  it("maps every targeted OpenCode behavior", () => {
    for (const { source, behavior } of requiredOpenCodeBehaviors) {
      expect(
        rows.some((row) => row.source === source && row.behavior === behavior),
        `missing OpenCode parity row for ${source}: ${behavior}`
      ).toBe(true)
    }
  })

  it("classifies heartbeat fencing and exact harness descendants without overclaiming durability", () => {
    const heartbeat = rows.find((row) => row.source.startsWith("smithers #5 "))
    expect(heartbeat).toMatchObject({
      flowsEquivalent: "flows/packages/smithers/flows/engine-store/test/Ownership.test.ts",
      status: "partial"
    })

    // The three overflow-recovery rows are `skipped` because that recovery was
    // a contract of the deleted provider-tool-call loop, not because coverage
    // regressed: the cell loop compacts on a declared token budget instead.
    const expected = [
      // The cell loop recovers from a failed call inside the cell; the durable
      // half of the settlement stays engine-owned, so the row is `partial`.
      ["durably settles local tool failures before continuing", "partial"],
      ["forces one compaction and retries after provider context overflow", "partial"],
      ["persists a second context overflow after one recovery", "skipped"],
      ["recovers once from a raw context overflow failure", "skipped"],
      ["does not recover context overflow after durable assistant output", "skipped"],
      ["forces a text response on an agent's configured final step", "pinned"],
      ["projects raw provider stream failures as terminal assistant step failures", "partial"],
      ["keeps interleaved assistant text blocks separate", "pinned"],
      ["broadcasts provider ${kind} deltas without storing projection rewrites", "partial"],
      ["durably closes partial ${kind} when the provider stream fails", "partial"],
      ["durably closes partial ${kind} when the provider stream is interrupted", "partial"]
    ] as const
    for (const [behavior, status] of expected) {
      expect(
        rows.find((row) =>
          row.source === "packages/smithers/flows/core/test/session-runner.test.ts" &&
          row.behavior === behavior
        ),
        behavior
      ).toMatchObject({ status })
    }
  })
})
