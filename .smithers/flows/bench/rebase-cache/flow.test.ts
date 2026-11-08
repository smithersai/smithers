/**
 * `bench/rebase-cache` through the flow API: the real graph, the real layer and
 * a real child process running `rebase-cache.mjs`. A passing measurement
 * exports, installs and plans every revision of a stack, minutes of work per
 * revision, so this suite proves the refusal path and the argument mapping.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import RebaseCache, { argv, layer, type Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    RebaseCache.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(RebaseCache, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

test("the payload maps to the benchmark's options, lists comma-joined", () => {
  assert.deepEqual(argv({ out: "/tmp/r" }), ["--out", "/tmp/r"])
  assert.deepEqual(
    argv({
      out: "/tmp/r",
      insert: "packages/smithers/notifications",
      execute: ["//.smithers/flows:codingPolicy", "//.smithers/flows:codingRuntime"],
      allowFailed: ["//.smithers/flows:codingRuntime"]
    }),
    [
      "--out",
      "/tmp/r",
      "--insert",
      "packages/smithers/notifications",
      "--execute",
      "//.smithers/flows:codingPolicy,//.smithers/flows:codingRuntime",
      "--allow-failed",
      "//.smithers/flows:codingRuntime"
    ]
  )
  assert.deepEqual(
    argv({ out: "o", repo: "r", base: "b", stack: ["a", "c"], verb: "ci", pattern: "//...", install: "true" }),
    [
      "--out",
      "o",
      "--repo",
      "r",
      "--base",
      "b",
      "--stack",
      "a,c",
      "--verb",
      "ci",
      "--pattern",
      "//...",
      "--install",
      "true"
    ]
  )
})

test("a nonempty result directory is refused before any clone, as a typed failure", async () => {
  const out = mkdtempSync(join(tmpdir(), "bench-rebase-cache-flow-"))
  try {
    writeFileSync(join(out, "result.json"), "earlier result")
    const exit = await run({ out }, "bench-rebase-cache-stale")
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /bench\/rebase-cache\/rebase-cache\.mjs/)
    assert.deepEqual(readdirSync(out), ["result.json"])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
