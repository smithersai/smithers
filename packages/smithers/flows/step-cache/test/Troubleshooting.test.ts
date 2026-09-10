import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as CacheStore from "../src/CacheStore.ts"

const troubleshooting = readFileSync(new URL("../docs/troubleshooting.md", import.meta.url), "utf8")
const recovery = troubleshooting.split("## decode_failed: a stored row\n")[1]!
  .split("\n## ")[0]!
  .replace(/\s+/g, " ")

describe("stored-row corruption recovery documentation", () => {
  it("does not recommend deleting the database as a disposable cache", () => {
    expect(recovery).not.toMatch(/faster to delete than to repair/i)
    expect(recovery).not.toMatch(/losing it costs recomputation rather than correctness/i)
    expect(recovery).toMatch(/only reusable head rows are disposable/i)
  })

  it("requires backup and preserves durable state with a ledger retention link", () => {
    expect(recovery).toMatch(/back up the shared database/i)
    expect(recovery).toMatch(/evict or repair only the affected.*head rows/i)
    expect(recovery).toContain("flows_step_cache_recorded")
    expect(recovery).toMatch(/preserve or restore/i)
    expect(recovery).toMatch(/journal and run store/i)
    expect(recovery).toContain("(#flows_step_cache_recorded-grows-and-nothing-reclaims-it)")
    expect(troubleshooting).toContain("## flows_step_cache_recorded grows and nothing reclaims it")
  })
})

describe("imported ledger retention documentation", () => {
  it("requires complete local references and quiescent readers before collection", () => {
    const retention = troubleshooting.split("## flows_step_cache_recorded grows and nothing reclaims it")[1]!
      .replace(/\s+/g, " ")
    expect(retention).toContain("canReclaimRecorded")
    expect(retention).toContain("keyDigest, recordedRunId, recordedEventSeq")
    expect(retention).toMatch(/no retained local journal, fork, or run needs that exact provenance/i)
    expect(retention).toMatch(/Pause execution and replay on every process/i)
    expect(retention).toMatch(/Unknown reference state must return `false` or fail/i)
    expect(retention).toMatch(/including imports made before this policy existed/i)
  })
})

describe("admission complaint vocabulary", () => {
  it("names the complaint the shared boundary emits for an oversized container", () => {
    // The adapter forwards `@smthrs/canonical`'s complaint verbatim, and that
    // wording moved when admission became the shared boundary. A stale row
    // sends an operator searching their logs for text nothing emits.
    const failure = Effect.runSync(
      Effect.flip(CacheStore.encodeCanonical(new Array(CacheStore.maximumJsonMembers + 1).fill(0), "result"))
    )
    expect(troubleshooting).toContain(failure.message.replace(/^result /, ""))
    expect(troubleshooting).not.toContain("contains more than 100000 members")
  })
})
