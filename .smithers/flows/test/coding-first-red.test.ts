import { Action } from "@smthrs/flow"
import { NodeRuntime } from "@smthrs/platform-node"
import { Cause, Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import {
  advanceFirstRed,
  beginFirstRed,
  finishFirstRed,
  FirstRed,
  type FirstRedCursor,
  firstRedDone,
  firstRedLayers,
  probeIndex
} from "../coding/first-red.ts"
import { type Check, checkInputDigest, CodingError, type Implementation, type Receipt } from "../coding/schema.ts"
import { RunCheck } from "../coding/workflow.vibe"

const check = (id: string): Check => ({
  id,
  target: `//:${id}`,
  flow: `checks/${id}`,
  flowDigest: "0".repeat(64),
  tier: "slow",
  required: true
})
const revision = (commit: string, parent: string | undefined, change: string) => ({
  changeId: `jj-${change}`,
  commitId: commit,
  treeId: `tree-${commit}`,
  operationId: "op",
  parentCommitIds: parent === undefined ? [] : [parent]
})
/** A linear range of Changes by different authors over the given commits, oldest (the last green) first. */
const rangeOf = (commits: ReadonlyArray<string>, root = "root"): Array<Implementation> =>
  commits.map((commit, index) => {
    const parent = index === 0 ? root : commits[index - 1]!
    const change = `c${index}`
    return {
      change,
      parent: revision(parent, undefined, `parent-${change}`),
      atoms: [revision(commit, parent, change)],
      head: revision(commit, parent, change),
      reads: [],
      writes: [`author-${index % 3}/file.ts`]
    }
  })
const receiptFor = (
  implementation: Implementation,
  probe: Check,
  status: "passed" | "failed",
  fault?: "infra" | "factory"
): Receipt => ({
  checkId: probe.id,
  target: probe.target,
  tier: probe.tier,
  change: implementation.change,
  commitId: implementation.head.commitId,
  treeId: implementation.head.treeId,
  inputDigest: checkInputDigest(implementation, probe),
  status,
  ...(fault === undefined ? {} : { fault }),
  evidence: "",
  findings: status === "passed" || fault === "infra" ?
    [] :
    [{ owner: implementation.change, message: `${probe.id} failed`, sourceCommitId: implementation.head.commitId }]
})

type Script = (checkId: string, index: number, run: number) => "passed" | "failed" | "infra"
/** Drives the pure search to its end, recording every probe as `checkId@index`. */
const drive = (cursor: FirstRedCursor, script: Script) => {
  const probes: string[] = []
  const runs = new Map<string, number>()
  while (!firstRedDone(cursor)) {
    const receipts: Record<string, Receipt> = {}
    for (const search of cursor.searches) {
      if (["tip", "reproduce", "good", "bisect"].includes(search.state)) {
        const index = probeIndex(cursor, search)
        const key = `${search.checkId}@${index}`
        const run = (runs.get(key) ?? 0) + 1
        runs.set(key, run)
        probes.push(key)
        const probe = cursor.checks.find((candidate) => candidate.id === search.checkId)!
        const outcome = script(search.checkId, index, run)
        receipts[search.checkId] = outcome === "infra" ?
          receiptFor(cursor.range[index]!, probe, "failed", "infra") :
          // Real failures carry the fault checks.ts records; the engine test below uses the older fault-less form.
          receiptFor(cursor.range[index]!, probe, outcome, outcome === "failed" ? "factory" : undefined)
      }
    }
    cursor = advanceFirstRed(cursor, receipts)
  }
  return { result: finishFirstRed(cursor), probes }
}
const commits = (count: number) => Array.from({ length: count }, (_, index) => `commit-${index}`)

test("bisects each broken check to its first failing Change and reports the earliest", () => {
  const range = rangeOf(commits(17))
  const { result, probes } = drive(
    beginFirstRed({ range, checks: [check("unit"), check("e2e"), check("lint")] }),
    (id, index) =>
      id === "unit" ? (index >= 11 ? "failed" : "passed") : id === "e2e" ? (index >= 4 ? "failed" : "passed") : "passed"
  )
  assert.equal(result.status, "red")
  assert.deepEqual(result.checks.map((c) => [c.checkId, c.verdict, c.change]), [
    ["unit", "broken", "c11"],
    ["e2e", "broken", "c4"],
    ["lint", "passed", null]
  ])
  assert.deepEqual(result.firstRed, {
    change: "c4",
    commitId: "commit-4",
    checks: ["e2e"],
    findings: [{ owner: "c4", message: "e2e failed", sourceCommitId: "commit-4" }]
  })
  // The receipt below the culprit passed; the culprit's failed.
  const unit = result.checks[0]!
  assert.equal(unit.passing?.commitId, "commit-10")
  assert.equal(unit.failing?.commitId, "commit-11")
  // A passing check runs once; each broken check runs tries (2) at the tip, once at the last green, log2(16) bisecting.
  assert.deepEqual(probes.filter((p) => p.startsWith("lint@")), ["lint@16"])
  assert.equal(unit.runs, 2 + 1 + 4)
  assert.equal(result.checks[1]!.runs, 2 + 1 + 4)
})

test("separates a flake, a break at the last green and an unmeasurable tip from a real break", () => {
  const range = rangeOf(commits(6))
  const { result } = drive(
    beginFirstRed({ range, checks: [check("flaky"), check("old"), check("down"), check("real")], tries: 3 }),
    (id, index, run) => {
      if (id === "flaky") return run === 2 ? "passed" : "failed"
      if (id === "old") return "failed"
      if (id === "down") return "infra"
      return index === 5 ? "failed" : "passed"
    }
  )
  assert.deepEqual(result.checks.map((c) => [c.checkId, c.verdict, c.change, c.runs]), [
    ["flaky", "flaky", null, 2],
    ["old", "broken-at-good", null, 4],
    ["down", "untestable", null, 1],
    ["real", "broken", "c5", 3 + 1 + 3]
  ])
  assert.equal(result.status, "red")
  assert.equal(result.firstRed?.change, "c5")
})

test("only flakes and passes are green, with no first red", () => {
  const { result } = drive(
    beginFirstRed({ range: rangeOf(commits(3)), checks: [check("a"), check("b")] }),
    (id, _index, run) => id === "a" && run === 1 ? "failed" : "passed"
  )
  assert.equal(result.status, "green")
  assert.equal(result.firstRed, null)
})

test("an unmeasurable Change is skipped and widens the answer, as git bisect skip", () => {
  // Breaks at c6; c5 cannot run the check. Probes: tip twice, c0, c4 (pass), c6 (fail), c5 (skipped).
  const { result, probes } = drive(
    beginFirstRed({ range: rangeOf(commits(9)), checks: [check("unit")] }),
    (_id, index) => index === 5 ? "infra" : index >= 6 ? "failed" : "passed"
  )
  const unit = result.checks[0]!
  assert.equal(unit.verdict, "broken")
  assert.equal(unit.change, "c6")
  assert.deepEqual(unit.candidates, ["c5"])
  assert.equal(unit.passing?.commitId, "commit-4")
  assert.deepEqual(probes, ["unit@8", "unit@8", "unit@0", "unit@4", "unit@6", "unit@5"])

  // When the skipped Change sits in the middle, the next nearest untested Change is probed instead.
  const around = drive(
    beginFirstRed({ range: rangeOf(commits(9)), checks: [check("unit")] }),
    (_id, index) => index === 4 ? "infra" : index >= 2 ? "failed" : "passed"
  )
  assert.deepEqual(around.probes, ["unit@8", "unit@8", "unit@0", "unit@4", "unit@3", "unit@1", "unit@2"])
  assert.deepEqual([around.result.checks[0]!.change, around.result.checks[0]!.candidates], ["c2", []])
})

test("a last green the check cannot measure blames no Change", () => {
  // Broken before the range: without a measured last green, bisecting would blame an innocent c1.
  const { result, probes } = drive(
    beginFirstRed({ range: rangeOf(commits(8)), checks: [check("unit")] }),
    (_id, index) => index === 0 ? "infra" : "failed"
  )
  assert.deepEqual(probes, ["unit@7", "unit@7", "unit@0"])
  assert.deepEqual([result.checks[0]!.verdict, result.checks[0]!.change, result.checks[0]!.passing], [
    "untestable",
    null,
    null
  ])
  assert.equal(result.status, "red")
  assert.equal(result.firstRed, null)
})

test("a rerun at the tip the host cannot measure spends no try, and the tip runs at most five times", () => {
  // Fails, then the runner is down once, then fails again: a real break at c4.
  const once = drive(
    beginFirstRed({ range: rangeOf(commits(6)), checks: [check("unit")] }),
    (_id, index, run) => index === 5 && run === 2 ? "infra" : index >= 4 ? "failed" : "passed"
  )
  assert.deepEqual(once.probes.slice(0, 3), ["unit@5", "unit@5", "unit@5"])
  assert.deepEqual([once.result.checks[0]!.verdict, once.result.checks[0]!.change], ["broken", "c4"])
  // One failure, then the runner stays down: the recorded failure stands after five tip runs.
  const down = drive(
    beginFirstRed({ range: rangeOf(commits(6)), checks: [check("unit")], tries: 3 }),
    (_id, index, run) => index === 5 ? (run === 1 ? "failed" : "infra") : index >= 2 ? "failed" : "passed"
  )
  assert.deepEqual(down.probes.filter((probe) => probe === "unit@5").length, 5)
  assert.deepEqual([down.result.checks[0]!.verdict, down.result.checks[0]!.change], ["broken", "c2"])
  assert.equal(down.result.checks[0]!.failing?.commitId, "commit-2")
})

test("a bisect whose every Change is unmeasurable names the tip and every skipped Change", () => {
  const { result, probes } = drive(
    beginFirstRed({ range: rangeOf(commits(6)), checks: [check("unit")] }),
    (_id, index) => index === 0 ? "passed" : index === 5 ? "failed" : "infra"
  )
  assert.deepEqual(probes, ["unit@5", "unit@5", "unit@0", "unit@2", "unit@3", "unit@1", "unit@4"])
  const unit = result.checks[0]!
  assert.deepEqual([unit.verdict, unit.change, unit.candidates], ["broken", "c5", ["c1", "c2", "c3", "c4"]])
  assert.equal(unit.passing?.commitId, "commit-0")
})

test("refuses a range that is not one parent chain, a repeated Change or check, and a foreign receipt", () => {
  const range = rangeOf(commits(3))
  const code = (expected: string) => (error: unknown) => error instanceof CodingError && error.code === expected
  assert.throws(
    () => beginFirstRed({ range: [range[0]!, range[2]!], checks: [check("a")] }),
    code("invalid_request")
  )
  assert.throws(() => beginFirstRed({ range: [range[0]!, range[0]!], checks: [check("a")] }), code("invalid_request"))
  assert.throws(() => beginFirstRed({ range, checks: [check("a"), check("a")] }), code("invalid_request"))
  const cursor = beginFirstRed({ range, checks: [check("a")] })
  // A receipt for another revision than the probed tip.
  assert.throws(
    () => advanceFirstRed(cursor, { a: receiptFor(range[1]!, check("a"), "failed") }),
    code("invalid_receipt")
  )
  assert.throws(() => advanceFirstRed(cursor, {}), code("invalid_receipt"))
  assert.throws(
    () => advanceFirstRed(cursor, { a: { ...receiptFor(range[2]!, check("a"), "passed"), status: "superseded" } }),
    code("invalid_receipt")
  )
  // Finishing an open search is a bug in the caller, never a typed refusal.
  assert.throws(() => finishFirstRed(cursor), (error) => !(error instanceof CodingError))
})

/** A real JJ stack: each Change by another author edits a file; `bug` appears in `state.txt` at one Change. */
const stack = async (t: TestContext, length: number, breakAt: number, lintBreakAt: number) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-first-red-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const jj = (...args: string[]) =>
    execFileSync("jj", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, JJ_CONFIG: "/dev/null" }
    }).trim()
  jj("git", "init", "--config", "user.name=First red", "--config", "user.email=first-red@example.invalid")
  const ids: Array<{ change: string; commit: string }> = []
  for (let index = 0; index < length; index++) {
    await writeFile(join(root, ".gitignore"), ".flows/\n")
    await writeFile(join(root, "state.txt"), index >= breakAt ? "bug\n" : "ok\n")
    await writeFile(join(root, "style.txt"), index >= lintBreakAt ? "tabs\n" : "spaces\n")
    await writeFile(join(root, `author-${index % 4}.txt`), `change ${index}\n`)
    jj(
      "--config",
      `user.name=Author ${index % 4}`,
      "--config",
      `user.email=author-${index % 4}@example.invalid`,
      "commit",
      "-m",
      `change ${index}`
    )
    const [change, commit] = jj("log", "-r", "@-", "--no-graph", "-T", "change_id ++ \" \" ++ commit_id").split(" ")
    ids.push({ change: change!, commit: commit! })
  }
  const range: Array<Implementation> = ids.map(({ change, commit }, index) => {
    const parent = index === 0 ? jj("log", "-r", `${commit}-`, "--no-graph", "-T", "commit_id") : ids[index - 1]!.commit
    const head = {
      changeId: change,
      commitId: commit,
      treeId: `tree-${commit}`,
      operationId: "op",
      parentCommitIds: [parent]
    }
    return {
      change: `T${index}`,
      parent: {
        ...head,
        changeId: `parent-${change}`,
        commitId: parent,
        treeId: `tree-${parent}`,
        parentCommitIds: []
      },
      atoms: [head],
      head,
      reads: [],
      writes: [`author-${index % 4}.txt`]
    }
  })
  return { root, jj, range, filename: join(root, ".flows", "engine.db") }
}

/** A check that reads the probed commit's files through JJ, never the working copy. */
const jjCheck = (repo: Awaited<ReturnType<typeof stack>>, calls: string[]) =>
  RunCheck.toLayer(({ implementation, check: probe }) =>
    Effect.sync(() => {
      const index = repo.range.findIndex((candidate) => candidate.change === implementation.change)
      calls.push(`${probe.id}@${index}`)
      const file = probe.id === "unit" ? "state.txt" : probe.id === "lint" ? "style.txt" : "author-0.txt"
      const text = repo.jj("file", "show", "-r", implementation.head.commitId, file)
      const failed = probe.id === "unit" ? text === "bug" : probe.id === "lint" ? text === "tabs" : false
      return receiptFor(implementation, probe, failed ? "failed" : "passed")
    })
  )
const host = <R>(
  repo: Awaited<ReturnType<typeof stack>>,
  checks: Layer.Layer<Action.Requirement<typeof RunCheck.name>, never, R>
) =>
  NodeRuntime.layerHost(
    { filename: repo.filename, workspaceRoot: repo.root, owner: { hostId: "first-red-test" }, signals: [] },
    Layer.mergeAll(firstRedLayers, checks).pipe(Layer.provideMerge(Action.layerImplementations))
  )

test(
  "finds the first red Change on a real JJ stack and replays it after a restart",
  { timeout: 120_000 },
  async (t) => {
    // 33 Changes from four authors: lint breaks at T9, unit at T21; docs stays green.
    const repo = await stack(t, 33, 21, 9)
    const input = { range: repo.range, checks: [check("unit"), check("lint"), check("docs")] }
    const calls: string[] = []
    const result = await Effect.runPromise(
      Effect.scoped(
        FirstRed.execute(input, { executionId: "first-red-stack" }).pipe(
          Effect.provide(host(repo, jjCheck(repo, calls)))
        )
      )
    )
    assert.equal(result.status, "red")
    assert.deepEqual(result.checks.map((c) => [c.checkId, c.verdict, c.change]), [
      ["unit", "broken", "T21"],
      ["lint", "broken", "T9"],
      ["docs", "passed", null]
    ])
    assert.equal(result.firstRed?.change, "T9")
    assert.equal(result.firstRed?.commitId, repo.range[9]!.head.commitId)
    assert.deepEqual(result.firstRed?.checks, ["lint"])
    // Only the failing checks run again: docs once at the tip; each broken check twice there, once at T0, log2(32) bisecting.
    assert.deepEqual(calls.filter((call) => call.startsWith("docs@")), ["docs@32"])
    assert.equal(calls.filter((call) => call.startsWith("unit@")).length, 2 + 1 + 5)
    assert.equal(calls.filter((call) => call.startsWith("lint@")).length, 2 + 1 + 5)

    // A new host on the same engine database replays the recorded run; no check runs again.
    const replayed: string[] = []
    const again = await Effect.runPromise(
      Effect.scoped(
        FirstRed.execute(input, { executionId: "first-red-stack" }).pipe(
          Effect.provide(host(repo, jjCheck(repo, replayed)))
        )
      )
    )
    assert.deepEqual(again, result)
    assert.deepEqual(replayed, [])
  }
)

test("a check that cannot execute fails the search with its typed error", { timeout: 60_000 }, async (t) => {
  const repo = await stack(t, 3, 1, 9)
  const failing = RunCheck.toLayer(() => Effect.fail(new CodingError({ code: "execution", message: "no runner" })))
  const exit = await Effect.runPromise(
    Effect.scoped(
      FirstRed.execute({ range: repo.range, checks: [check("unit")] }, { executionId: "first-red-down" }).pipe(
        Effect.provide(host(repo, failing)),
        Effect.exit
      )
    )
  )
  assert.ok(Exit.isFailure(exit))
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  assert.ok(reason?.error instanceof CodingError, Cause.pretty(exit.cause))
  assert.equal(reason.error.code, "execution")
})
