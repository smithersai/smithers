import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { readFileSync } from "node:fs"
import * as CacheStore from "../src/CacheStore.ts"
import * as TestCacheStore from "../src/test/TestCacheStore.ts"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

/** Every page that tells a reader what `Conflict`, or its `409` wire form, means. */
const conflictPages = [
  "README.md",
  "docs/README.md",
  "docs/api.md",
  "docs/quickstart.md",
  "docs/troubleshooting.md",
  "docs/concepts/head-and-ledger.md",
  "docs/concepts/tiers.md",
  "docs/guides/observe-cache-outcomes.md",
  "docs/guides/evict-a-poisoned-entry.md",
  "docs/guides/share-results-across-machines.md",
  "docs/guides/implement-a-shared-tier.md"
].map((path) => [path, read(path)] as const)

describe("documented Conflict vocabulary", () => {
  // The provenance stage conflicts inside a single run when a retry re-records
  // one `(keyDigest, recordedRunId, recordedEventSeq)` with a different `meta`
  // or `createdAtMs`. A page that defines the outcome as two runs computing
  // different results sends an operator after a nondeterministic step that
  // never ran.
  it.each(conflictPages)("%s does not define Conflict as result divergence alone", (_, page) => {
    expect(page).not.toMatch(/means one thing(?: only)?: two runs disagree/)
    expect(page).not.toMatch(/two runs recorded different results under one digest/)
    expect(page).not.toMatch(/two runs (?:have ever )?disagreed? about\s+what a step produced/)
    expect(page).not.toMatch(/it says two\s+runs computed different results/)
  })

  it.effect("diagnoses a head conflict from matching ledger bytes after a second provenance is recorded", () =>
    Effect.gen(function*() {
      const store = yield* CacheStore.CacheStore
      const first = {
        keyDigest: "shared-digest",
        result: { value: 1 },
        meta: { source: "first" },
        createdAtMs: 10,
        recordedRunId: "run-1",
        recordedEventSeq: 1
      }
      const second = {
        ...first,
        result: { value: 2 },
        meta: { source: "second" },
        createdAtMs: 20,
        recordedRunId: "run-2"
      }
      expect(yield* store.put(first)).toEqual({ _tag: "Inserted" })
      expect(yield* store.put(second)).toEqual({ _tag: "Conflict" })
      expect(Option.getOrThrow(yield* store.get(first.keyDigest))).toEqual(first)

      // Remove the head so a fenced lookup cannot fall back to it: the
      // losing publication committed its own ledger row.
      expect(yield* store.evict(first.keyDigest)).toBe(true)
      const recordedBy = { runId: second.recordedRunId, eventSeq: second.recordedEventSeq }
      const recorded = Option.getOrThrow(yield* store.get(second.keyDigest, { recordedBy }))
      expect(recorded).toEqual(second)

      const changed = { ...second, meta: { source: "changed" } }
      expect(yield* store.put(changed)).toEqual({ _tag: "Conflict" })
      expect(Option.getOrThrow(yield* store.get(second.keyDigest, { recordedBy }))).toEqual(second)
      expect(Option.isNone(yield* store.get(second.keyDigest))).toBe(true)

      const page = read("docs/troubleshooting.md")
      expect(page).not.toMatch(/No row there is the head stage/)
      expect(page).toMatch(/If they match, the conflict is at the head stage/)
    }).pipe(Effect.provide(TestCacheStore.layer)))

  it.effect("keeps the pages that define the outcome consistent with a metadata-only conflict", () =>
    Effect.gen(function*() {
      // `put` compares `result_json`, `meta_json`, and `created_at_ms` on the
      // ledger row, so all three belong in any page that enumerates what a
      // retry has to present unchanged.
      for (const path of ["docs/api.md", "docs/quickstart.md", "docs/troubleshooting.md"]) {
        expect(read(path)).toMatch(/`meta`, (?:or |and )?`createdAtMs`/)
      }
      expect(read("docs/concepts/head-and-ledger.md")).toMatch(/Only the\s+head stage needs two runs/)
    }))
})

describe("documented admission guarantees", () => {
  it.effect("scopes the getter-free promise to the trees the boundary copies", () =>
    Effect.gen(function*() {
      let reads = 0
      const selector = Object.defineProperty({ eventSeq: 0 }, "runId", {
        enumerable: true,
        get: () => {
          reads++
          return "run"
        }
      }) as CacheStore.RecordedBy

      expect(yield* CacheStore.validateRecordedBy(selector)).toEqual({ runId: "run", eventSeq: 0 })
      // A selector is schema-decoded rather than copied through descriptors, so
      // a blanket "every argument is detached without invoking a getter" is
      // false for the operation options.
      expect(reads).toBe(1)
      expect(read("README.md")).not.toMatch(/Inputs are detached\s+and frozen without invoking a getter/)
      expect(read("README.md")).toContain("schema-decoded once")
      expect(read("docs/concepts/admission.md")).toContain("## Selectors are decoded, not copied")
    }))

  it.effect("does not promise that a non-plain entry shell is refused", () =>
    Effect.gen(function*() {
      class Shell {
        keyDigest = "digest"
        result: unknown = { ok: true }
        meta: unknown = {}
        createdAtMs = 0
        recordedRunId = "run"
        recordedEventSeq = 0
        toJSON() {
          throw new Error("snapshotEntry must never call a prototype hook")
        }
      }

      // `snapshotEntry` inspects own descriptors only, so a class shell whose
      // six fields are own values is admitted and its prototype is untouched.
      const admitted = yield* CacheStore.snapshotEntry(new Shell())
      expect(admitted.keyDigest).toBe("digest")
      expect(read("docs/api.md")).not.toContain("non-plain shells are refused")
      expect(read("docs/troubleshooting.md")).not.toContain("Do not pass a class instance")

      // The nested trees are a different rule, and stay plain.
      const refused = yield* Effect.flip(
        CacheStore.snapshotEntry({ ...admitted, result: new Shell() })
      )
      expect(refused.message).toBe("result contains a non-plain object")
    }))
})

describe("documented ledger retention", () => {
  it("names the host policy that permits ledger collection in the README guarantee", () => {
    const guarantee = read("README.md").split("The **ledger** row")[1]!.split("## Install")[0]!
    expect(guarantee).toContain("`sweepExpired`")
    expect(guarantee).toContain("`canReclaimRecorded`")
    expect(guarantee).not.toMatch(/no verb in this package deletes one/)
  })
})
