/**
 * `land/lane-gates` through the flow API: the real graph, the real layer and a
 * real bash process running `lane-gates.sh`, in its integration mode over a
 * scratch Git history and in its refused baseline mode.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import LaneGates, { argv, layer, Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    LaneGates.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(LaneGates, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

// main adds a line after `base`; the lane either keeps it or drops it.
const inLane = async <A>(keep: boolean, body: (base: string) => Promise<A>) => {
  const root = mkdtempSync(join(tmpdir(), "lane-gates-flow-"))
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  const previous = process.cwd()
  try {
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Lane test")
    git("config", "user.email", "lane@example.invalid")
    writeFileSync(join(root, "file.txt"), "base\n")
    git("add", ".")
    git("commit", "-qm", "base")
    const base = git("rev-parse", "HEAD")
    writeFileSync(join(root, "file.txt"), "base\nmain added\n")
    git("commit", "-qam", "main")
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    git("checkout", "-q", "--detach", base)
    writeFileSync(join(root, "file.txt"), keep ? "base\nmain added\nlane\n" : "base\nlane\n")
    git("commit", "-qam", "lane")
    process.chdir(root)
    return await body(base)
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
}

test("the payload maps to the script's argument array", () => {
  assert.deepEqual(argv({ mode: "gate" }), [])
  assert.deepEqual(argv({ mode: "baseline" }), ["--baseline"])
  assert.deepEqual(argv({ mode: "integration", base: "abc", allowDeleted: ["*.txt", "docs/**"] }), [
    "--integration",
    "abc",
    "--allow-deleted",
    "*.txt",
    "--allow-deleted",
    "docs/**"
  ])
  // The script, not the wrapper, refuses an integration run without a base.
  assert.deepEqual(argv({ mode: "integration" }), ["--integration"])
})

test("integration passes when the lane keeps every line main added", async () => {
  await inLane(true, async (base) => {
    const exit = await run({ mode: "integration", base }, "lane-gates-keep")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
  })
})

test("integration fails, as a typed failure, when the lane drops a line main added", async () => {
  await inLane(false, async (base) => {
    const exit = await run({ mode: "integration", base }, "lane-gates-drop")
    assert.ok(Exit.isFailure(exit))
    const failure = JSON.stringify(exit.cause)
    assert.match(failure, /automation\/ModuleFailed/)
    assert.match(failure, /flows\/land\/lane-gates\.sh/)
    assert.match(failure, /"exitCode":1/)
  })
})

test("baseline is refused outside the baseline runner", async () => {
  const lane = process.env.LANE
  delete process.env.LANE
  try {
    const exit = await run({ mode: "baseline" }, "lane-gates-baseline")
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /"exitCode":2/)
  } finally {
    if (lane !== undefined) process.env.LANE = lane
  }
})
