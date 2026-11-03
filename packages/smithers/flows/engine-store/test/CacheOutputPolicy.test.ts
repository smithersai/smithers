import { describe, expect, it } from "@effect/vitest"
import { Action } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Journal } from "@smthrs/journal"
import { AttemptStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as OutputPolicy from "../src/internal/CacheOutputPolicy.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, descriptor, evidence, jj, owner } from "./CachePolicyFixtures.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const digest = "a".repeat(64)
const out = (path: string, deleted = false) => ({ path, digest: deleted ? null : digest })
const tree = (path: string) => ({ path, identity: "tree-digest" })
const treeDeclaration = (path: string) => ({ _tag: "TreeArtifact" as const, path })
const mismatch = { _tag: "Refused", reason: "output-boundary-mismatch" }

describe("all-path replay preflight", () => {
  const cases: ReadonlyArray<{
    name: string
    declared: ActionPersistence.BoundaryMetadata | undefined
    recorded: unknown
    expected: OutputPolicy.Decision
  }> = [
    { name: "empty", declared: descriptor, recorded: { outputs: [] }, expected: { _tag: "ReplayOutputs" } },
    {
      name: "exact",
      declared: { ...descriptor, writeSet: ["a"] },
      recorded: { outputs: [out("a")] },
      expected: { _tag: "ReplayOutputs" }
    },
    {
      name: "removal",
      declared: { ...descriptor, removes: ["a"] },
      recorded: { outputs: [out("a", true)] },
      expected: { _tag: "ReplayOutputs" }
    },
    {
      name: "glob",
      declared: { ...descriptor, writeSet: [{ _tag: "Glob", include: ["dist/**"], exclude: ["dist/private/**"] }] },
      recorded: { outputs: [out("dist/a")] },
      expected: { _tag: "ReplayOutputs" }
    },
    {
      name: "tree",
      declared: { ...descriptor, writeSet: [treeDeclaration("dist")] },
      recorded: { outputs: [out("dist/a")], trees: [tree("dist")] },
      expected: { _tag: "ReplayOutputs" }
    },
    {
      name: "no descriptor",
      declared: undefined,
      recorded: { outputs: [] },
      expected: mismatch as OutputPolicy.Decision
    },
    { name: "abstract path list", declared: descriptor, recorded: { paths: [] }, expected: { _tag: "ReplayOutputs" } },
    {
      name: "changed abstract path list",
      declared: descriptor,
      recorded: { paths: ["other"] },
      expected: mismatch as OutputPolicy.Decision
    },
    {
      name: "abstract path list omits removals",
      declared: { ...descriptor, removes: ["a"] },
      recorded: { paths: [] },
      expected: mismatch as OutputPolicy.Decision
    },
    {
      name: "foreign format",
      declared: descriptor,
      recorded: { opaque: true },
      expected: { _tag: "Refused", reason: "unsupported-output-evidence" }
    },
    {
      name: "bad digest",
      declared: { ...descriptor, writeSet: ["a"] },
      recorded: { outputs: [{ path: "a", digest: "bad" }] },
      expected: { _tag: "Refused", reason: "unsupported-output-evidence" }
    },
    {
      name: "malformed production evidence cannot use the abstract fallback",
      declared: descriptor,
      recorded: { outputs: [{ path: "../foreign", digest: "bad" }], paths: [] },
      expected: { _tag: "Refused", reason: "unsupported-output-evidence" }
    },
    ...[
      ["case-sensitive glob include", { writeSet: [{ _tag: "Glob", include: ["dist/**"] }] }, {
        outputs: [out("DIST/a")]
      }],
      ["case-sensitive tree child", { writeSet: [treeDeclaration("dist")] }, {
        outputs: [out("DIST/a")],
        trees: [tree("dist")]
      }],
      ["unexpected later write", { writeSet: ["a"] }, { outputs: [out("a"), out("b")] }],
      ["missing output", { writeSet: ["a"] }, { outputs: [] }],
      ["undeclared deletion", { writeSet: ["a"] }, { outputs: [out("a", true)] }],
      ["surviving removal", { removes: ["a"] }, { outputs: [out("a")] }],
      ["omitted removal", { removes: ["a"] }, { outputs: [] }],
      ["duplicate output", { writeSet: ["a"] }, { outputs: [out("a"), out("a")] }],
      ["duplicate tree", { writeSet: [treeDeclaration("dist")] }, { outputs: [], trees: [tree("dist"), tree("dist")] }],
      ["missing tree manifest", { writeSet: [treeDeclaration("dist")] }, { outputs: [out("dist/a")] }],
      ["file replaces tree root", { writeSet: [treeDeclaration("dist")] }, {
        outputs: [out("dist")],
        trees: [tree("dist")]
      }],
      ["broader pruning root", { writeSet: [treeDeclaration("dist/safe")] }, { outputs: [], trees: [tree("dist")] }],
      ["glob cannot prune tree", { writeSet: [{ _tag: "Glob", include: ["dist/**"] }] }, {
        outputs: [],
        trees: [tree("dist")]
      }],
      ["excluded glob child", { writeSet: [{ _tag: "Glob", include: ["dist/**"], exclude: ["dist/private/**"] }] }, {
        outputs: [out("dist/private/a")]
      }],
      ["foreign tree path", { writeSet: [treeDeclaration("dist")] }, { outputs: [], trees: [tree("../dist")] }],
      ["foreign output path", { writeSet: ["a"] }, { outputs: [out("/a")] }],
      ["noncanonical path", { writeSet: ["dist/a"] }, { outputs: [out("dist\\a")] }]
    ].map(([name, declared, recorded]) => ({
      name: name as string,
      declared: { ...descriptor, ...declared as object },
      recorded,
      expected: mismatch as OutputPolicy.Decision
    }))
  ]
  for (const row of cases) {
    it(row.name, () => {
      expect(OutputPolicy.replay(row.declared, { ...evidence, declaredOutputs: row.recorded })).toEqual(row.expected)
    })
  }

  it("refuses the complete manifest before any write or prune and preserves the reopened durable outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "cache-output-policy-"))
    const db = join(root, "engine.sqlite")
    const preserved = join(root, "preserved.txt")
    writeFileSync(preserved, "untouched")
    const key = "recorded-output-boundary"
    const keyDigest = sha256(key)
    const recorded = {
      ...evidence,
      declaredOutputs: { outputs: [out("safe/a"), out("other/b")], trees: [tree("safe"), tree("other")] }
    }
    const meta = { tier: "sealed", boundary: recorded, readSetVerified: true }
    try {
      await Effect.runPromise(withCrypto(
        Effect.gen(function*() {
          yield* activate("output-policy")
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO flows_attempts (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, outcome_json, meta_json)
          VALUES ('output-policy', ${keyDigest}, 1, 'succeeded', 1, 2, '"durable-result"', ${JSON.stringify(meta)})`
          const cache = yield* CacheStore.CacheStore
          yield* cache.put({
            keyDigest,
            result: "durable-result",
            meta,
            createdAtMs: 2,
            recordedRunId: "output-policy",
            recordedEventSeq: 0
          })
        }).pipe(Effect.provide(TestStores.layerAt(db)), Effect.scoped)
      ))
      let materializations = 0
      let evictions = 0
      await Effect.runPromise(withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          const attempts = yield* AttemptStore.AttemptStore
          const id = { runId: "output-policy", stepKeyDigest: keyDigest, attempt: 1 }
          const before = yield* attempts.get(id)
          const boundary = StepBoundary.make({
            prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: [] }),
            settle: () => Effect.die("must not settle"),
            replayOutputs: () =>
              Effect.sync(() => {
                materializations++
                writeFileSync(preserved, "partially replayed")
              })
          })
          const result = yield* ActionPersistence.make({
            runId: "output-policy",
            owner,
            sourceId: "output-policy",
            execute: () => Effect.die("must not repeat")
          })({
            action: CacheEnvironment.withCache(
              Action.make({
                name: "output-policy",
                tier: "sealed",
                success: Schema.String,
                error: Schema.Never,
                execute: Effect.succeed("unused")
              }),
              { ttlMs: 1 }
            ),
            attempt: 1,
            key,
            tier: "sealed",
            metadata: { ...descriptor, writeSet: [treeDeclaration("safe")] }
          }).pipe(
            Effect.provideService(StepBoundary.StepBoundary, boundary),
            Effect.provideService(CacheStore.CacheStore, {
              ...cache,
              evict: (key, options) =>
                Effect.sync(() => {
                  evictions++
                }).pipe(Effect.andThen(cache.evict(key, options)))
            })
          )
          expect(result).toBe("durable-result")
          expect(yield* attempts.get(id)).toEqual(before)
          expect(Option.getOrThrow(yield* cache.get(keyDigest)).meta).toEqual(meta)
          const journal = yield* Journal.Journal
          const page = yield* journal.entries({ runId: "output-policy" as never, limit: 50 })
          const refusals = page.entries.filter((entry) => entry.eventType === "flows.engine.cache-provenance").map((
            entry
          ) => entry.payload)
          expect(refusals).toHaveLength(2)
          for (const refusal of refusals) {
            expect(refusal).toMatchObject({ action: "replay_failed", reason: "output-boundary-mismatch" })
          }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj)), Effect.scoped)
      ))
      expect(materializations).toBe(0)
      expect(evictions).toBe(0)
      expect(readFileSync(preserved, "utf8")).toBe("untouched")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
