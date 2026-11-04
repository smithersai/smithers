import "./files.test.mjs"
import "./farm/farm.test.mjs"
import "./workspace.test.mjs"
import "./lock.test.mjs"
import "./lock-recovery.test.mjs"
import "./process.test.mjs"
import "./projection.test.mjs"
import "./generated.test.mjs"
import "./numbering.test.mjs"
import "./stranded.test.mjs"
/**
 * `land` through the flow API: the real graph, the real layer and a real child
 * process running `commit.mjs`. No case pushes: the success commits in a
 * scratch Git checkout, and the failure is the module's own refusal.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import Land, { argv, layer, Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    Land.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(Land, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

const hygiene = "packages/repo-targets/contracts/check-tracked-hygiene.mjs"

// A Git checkout on main holding the one gate a commit without push runs.
const inCheckout = async <A>(body: (root: string, git: (...args: Array<string>) => string) => Promise<A>) => {
  const root = mkdtempSync(join(tmpdir(), "land-"))
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  const previous = process.cwd()
  try {
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Land test")
    git("config", "user.email", "land@example.invalid")
    mkdirSync(join(root, "packages/repo-targets/contracts"), { recursive: true })
    copyFileSync(fileURLToPath(new URL(`../../../${hygiene}`, import.meta.url)), join(root, hygiene))
    git("add", ".")
    git("commit", "-q", "-m", "initial")
    process.chdir(root)
    return await body(root, git)
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({}), [])
  assert.deepEqual(argv({ message: "fix: x", push: true, tests: ["true", "printf ok"] }), [
    "--message",
    "fix: x",
    "--push",
    "--test",
    "true",
    "--test",
    "printf ok"
  ])
  assert.deepEqual(argv({ push: false, noTest: "docs only" }), ["--no-test", "docs only"])
  assert.deepEqual(argv({ noReviewNeeded: "comment only" }), ["--no-review-needed", "comment only"])
  // The module, not the wrapper, refuses both together and a push with neither.
  assert.deepEqual(argv({ tests: ["true"], noTest: "docs only" }), ["--test", "true", "--no-test", "docs only"])
})

test("a push with neither tests nor a reason is refused by the module, as a typed failure", async () => {
  await inCheckout(async (_root, git) => {
    const before = git("rev-parse", "main")
    writeFileSync("change.txt", "candidate\n")
    const exit = await run({ push: true }, "land-push-untested")
    assert.ok(Exit.isFailure(exit))
    const failure = JSON.stringify(exit.cause)
    assert.match(failure, /automation\/ModuleFailed/)
    assert.match(failure, /flows\/land\/commit\.mjs/)
    assert.match(failure, /"exitCode":1/)
    assert.equal(git("rev-parse", "main"), before)
  })
})

test("a commit without push records every edit and the no-test reason on main", async () => {
  await inCheckout(async (_root, git) => {
    writeFileSync("first.txt", "first contributor\n")
    writeFileSync("second.txt", "second contributor\n")
    const exit = await run({ message: "test: land both", noTest: "flow test" }, "land-commit")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
    assert.equal(git("log", "-1", "--format=%B", "main"), "test: land both\n\nLanding-Tests: none (flow test)")
    assert.equal(git("show", "main:first.txt"), "first contributor")
    assert.equal(git("show", "main:second.txt"), "second contributor")
    assert.equal(git("status", "--porcelain"), "")
  })
})
