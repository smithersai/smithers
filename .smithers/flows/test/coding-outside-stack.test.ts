/**
 * Admitting outside work over a real jj repository: stacks other authors built
 * on the mythical tip append to it as Changes, each gated by its fast checks.
 * Only the checks are scripted; every rebase, restore and bookmark move is jj's.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Crypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { outsideStacksServed } from "../coding/host.ts"
import { NativeCoding } from "../coding/native.ts"
import {
  AppendOutsideStack,
  gate,
  layer as outsideStacksLayer,
  make as makeOutsideStacks,
  type OutsideStack,
  outsideStackLayers,
  StackRefused
} from "../coding/outside-stack.ts"
import { type Check, checkInputDigest, CodingError, type Revision } from "../coding/schema.ts"
import { RunCheck } from "../coding/workflow.ts"

const environment: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? tmpdir(),
  JJ_USER: "Smithers Test",
  JJ_EMAIL: "smithers@example.test",
  // No user configuration reaches the repository under test.
  JJ_CONFIG: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
}
const sh = (cwd: string, file: string, args: ReadonlyArray<string>) =>
  execFileSync(file, args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const jj = (cwd: string, ...args: string[]) => sh(cwd, "jj", ["--no-pager", "--color=never", ...args])
const field = (cwd: string, revset: string, template: string) =>
  jj(cwd, "log", "--no-graph", "-r", revset, "-T", template)
const commitOf = (cwd: string, revset: string) => field(cwd, revset, "commit_id")
const changeOf = (cwd: string, revset: string) => field(cwd, revset, "change_id")
const parentsOf = (cwd: string, revset: string) =>
  field(cwd, revset, "parents.map(|p| p.commit_id()).join(\" \")").split(" ").filter((id) => id !== "")
const revisionOf = (cwd: string, revset: string): Revision => {
  const commitId = commitOf(cwd, revset)
  return {
    changeId: changeOf(cwd, revset),
    commitId,
    treeId: sh(cwd, "git", ["rev-parse", `${commitId}^{tree}`]),
    operationId: jj(cwd, "op", "log", "-n", "1", "--no-graph", "-T", "id"),
    parentCommitIds: parentsOf(cwd, revset)
  }
}
/** The native helper is a packaged binary; its `read` is answered here from jj and the colocated git store. */
const nativeOf = (root: string) =>
  Layer.succeed(NativeCoding, {
    sourcePublication: "local-only",
    read: (changeIds = []) =>
      Effect.sync(() => ({
        status: "read" as const,
        operationId: jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id"),
        head: { ...revisionOf(root, "@"), kind: "resolved" as const },
        revisions: changeIds.map((changeId) => ({
          ...revisionOf(root, `change_id(${changeId})`),
          kind: "resolved" as const
        }))
      })),
    apply: () => Effect.die("admission never applies native operations"),
    publishOriginalSource: () => Effect.die("admission never retains a source with the backend")
  })

const fast: Check = {
  id: "build",
  target: "//:build",
  flow: "checks/build",
  flowDigest: "0".repeat(64),
  tier: "fast",
  required: true
}
const slow: Check = { ...fast, id: "suite", target: "//:suite", tier: "slow" }

type Cleanup = { after: (fn: () => Promise<void>) => void }
/** The tip `vibe` holds a.txt; every author builds a stack on it in this one repository. */
const repository = async (t: Cleanup) => {
  const root = await mkdtemp(join(tmpdir(), "coding-outside-stack-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  jj(root, "git", "init")
  await writeFile(join(root, "a.txt"), "a\n")
  jj(root, "commit", "-m", "tip")
  jj(root, "bookmark", "create", "vibe", "-r", "@-")
  const tip = commitOf(root, "vibe")
  /** One author's stack: one commit per file map, on the tip. */
  const stack = async (id: string, commits: ReadonlyArray<Record<string, string>>): Promise<OutsideStack> => {
    jj(root, "new", tip)
    for (const [index, files] of commits.entries()) {
      for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text)
      jj(root, "commit", "-m", `${id} ${index}`)
    }
    return { id, title: `stack ${id}`, base: tip, head: commitOf(root, "@-") }
  }
  return { root, tip, stack }
}

/** Passes unless the applied stack writes red.txt; `before` runs first, so a test can move the tip mid-admission. */
const scriptedChecks = (root: string, calls: Array<string>, before: () => void = () => {}) =>
  RunCheck.toLayer(({ implementation, check }) =>
    Effect.sync(() => {
      before()
      calls.push(`${check.id}:${implementation.change}`)
      // The check measures the applied head: its tree, on the tip it was rebased onto.
      assert.equal(commitOf(root, implementation.head.commitId), implementation.head.commitId)
      const red = implementation.writes.includes("red.txt")
      return {
        checkId: check.id,
        target: check.target,
        tier: check.tier,
        change: implementation.change,
        commitId: implementation.head.commitId,
        treeId: implementation.head.treeId,
        inputDigest: checkInputDigest(implementation, check),
        status: red ? "failed" as const : "passed" as const,
        evidence: "fixture",
        findings: red
          ? [{
            owner: implementation.change,
            sourceCommitId: implementation.head.commitId,
            message: "red.txt breaks the build"
          }]
          : []
      }
    })
  )
const noChecks = (reason: string) => RunCheck.toLayer(() => Effect.die(reason))
const hostOf = (t: Cleanup, root: string, checks: ReturnType<typeof noChecks>) => {
  const host = ManagedRuntime.make(
    Layer.mergeAll(outsideStackLayers, checks).pipe(
      Layer.provide(outsideStacksLayer({ repositoryPath: root, environment })),
      Layer.provide(Layer.mergeAll(NodeServices.layer, nativeOf(root))),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Crypto.layerFromDigest(NodeCrypto.layerDigest))
    )
  )
  t.after(() => host.dispose())
  return host
}
const serviceOf = (root: string) =>
  Effect.runPromise(
    makeOutsideStacks({ repositoryPath: root, environment }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, nativeOf(root)))
    )
  )
const operationOf = (root: string) => jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id")
const rootChanges = (root: string, tip: string, head: string) =>
  field(root, `${tip}..${head}`, "change_id ++ \"\\n\"").split("\n").reverse()

test("outside stacks append to the tip as Changes; a red or conflicting stack is refused and restored", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a.txt": "from a\n" }, { "a2.txt": "a2\n" }])
  const b = await stack("b", [{ "red.txt": "fails the build\n" }])
  const c = await stack("c", [{ "a.txt": "from c\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  // An author re-enqueues a stack the tip already carries.
  const e: OutsideStack = { ...a, id: "e" }
  jj(root, "new", tip)
  const changes = (head: string) => rootChanges(root, tip, head)
  const original = { a: changes(a.head), b: changes(b.head), c: changes(c.head), d: changes(d.head) }

  const calls: Array<string> = []
  const host = hostOf(t, root, scriptedChecks(root, calls))
  const execute = AppendOutsideStack.execute(
    { target: "vibe", expected: tip, stacks: [a, b, c, d, e], checks: [fast, slow] },
    { executionId: "admit-train" }
  )
  const result = await host.runPromise(execute)

  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.stack, outcome.status, outcome.refusal?.reason ?? null]),
    [["a", "admitted", null], ["b", "refused", "fast_gate"], ["c", "refused", "conflict"], [
      "d",
      "admitted",
      null
    ], ["e", "refused", "already_applied"]]
  )
  // Only fast checks gate admission, and an unapplied stack is never checked.
  assert.deepEqual(calls, ["build:a", "build:b", "build:d"])

  // The tip moved forward to the last admitted head: a, then d on a.
  const [admittedA, , , admittedD] = result.outcomes
  assert.equal(result.tip, commitOf(root, "vibe"))
  assert.equal(result.tip, admittedD!.head.commitId)
  assert.equal(field(root, `${tip}::vibe`, "description.first_line() ++ \"\\n\""), "d 0\na 1\na 0\ntip")
  assert.deepEqual(parentsOf(root, `change_id(${original.a[0]})`), [tip])
  assert.deepEqual(parentsOf(root, `change_id(${original.d[0]})`), [admittedA!.head.commitId])
  // Change ids survive the rewrite; each Change's atoms are the author's own jj changes.
  assert.deepEqual(admittedA!.change!.implementation.atoms.map((atom) => atom.changeId), original.a)
  assert.deepEqual(admittedD!.change!.implementation.atoms.map((atom) => atom.changeId), original.d)
  assert.deepEqual(admittedA!.change!.receipts.map((receipt) => [receipt.checkId, receipt.status]), [[
    "build",
    "passed"
  ]])
  assert.equal(admittedA!.change!.implementation.parent.commitId, tip)
  assert.equal(jj(root, "file", "show", "-r", "vibe", "a.txt"), "from a")

  // Refused stacks are back on their own base, unconflicted, with their findings.
  const [, refusedB, refusedC] = result.outcomes
  assert.deepEqual(parentsOf(root, `change_id(${original.b[0]})`), [tip])
  assert.deepEqual(parentsOf(root, `change_id(${original.c[0]})`), [tip])
  assert.equal(field(root, `conflicts() & (${tip}::)`, "commit_id"), "")
  assert.equal(refusedB!.head.commitId, admittedA!.head.commitId, "a refused stack leaves the tip where it was")
  assert.deepEqual(refusedB!.refusal!.findings.map((finding) => finding.message), ["red.txt breaks the build"])
  assert.match(refusedC!.refusal!.message, /a\.txt/)

  // Replay answers from the journal: nothing is rebased, checked or moved again.
  const operation = jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id")
  assert.deepEqual(await host.runPromise(execute), result)
  assert.equal(calls.length, 3)
  assert.equal(jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id"), operation)
})

test("a tip that moved before admission is evicted and nothing is applied", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  jj(root, "new", tip)
  await writeFile(join(root, "z.txt"), "z\n")
  jj(root, "commit", "-m", "outside landing")
  jj(root, "bookmark", "set", "vibe", "-r", "@-")
  const host = hostOf(t, root, noChecks("no stack is applied, so none is checked"))
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a], checks: [fast] }, { executionId: "moved" })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "evicted")
  assert.match(error.message, /vibe moved/)
  assert.deepEqual(parentsOf(root, a.head), [tip], "the author's stack is untouched")
})

test("only a host that lands locally serves outside-stack admission", () => {
  const local = { planning: { landing: "fast-forward" as const } } as Parameters<typeof outsideStacksServed>[0]
  assert.equal(outsideStacksServed(local), true)
  assert.equal(outsideStacksServed({ ...local, retainedRepositoryJobs: false }), false, "never an installed host")
  assert.equal(
    outsideStacksServed({ ...local, landing: Layer.empty as never }),
    false,
    "never beside the backend adapter"
  )
  assert.equal(outsideStacksServed({ planning: {} } as Parameters<typeof outsideStacksServed>[0]), false)
})

test("a stack its author rewrote after enqueueing is refused as stale, not admitted with new content", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "enqueued\n" }])
  // The author amends the enqueued commit in place: same change id, new content.
  jj(root, "edit", a.head)
  await writeFile(join(root, "a2.txt"), "rewritten after enqueue\n")
  jj(root, "new", tip)
  const rewritten = commitOf(root, `change_id(${changeOf(root, a.head)})`)
  assert.notEqual(rewritten, a.head)
  const host = hostOf(t, root, noChecks("a stale stack is never checked"))
  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a], checks: [fast] }, { executionId: "stale" })
  )
  assert.deepEqual(result.outcomes.map((outcome) => [outcome.status, outcome.refusal?.reason]), [["refused", "stale"]])
  assert.equal(result.tip, tip)
  assert.equal(commitOf(root, `change_id(${changeOf(root, a.head)})`), rewritten, "the author's rewrite is untouched")
})

test("every write reconciles before it repeats: apply, restore and advance answer the same without a second jj operation", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a.txt": "from a\n" }, { "a2.txt": "a2\n" }])
  jj(root, "new", tip)
  const service = await serviceOf(root)
  const parent = await Effect.runPromise(service.tip("vibe", tip))
  assert.equal(parent.commitId, tip)
  // The stack already sits on the tip; move the tip on so apply really rebases.
  jj(root, "new", tip, "--no-edit", "-m", "outside landing")
  const landed = commitOf(root, "description(exact:\"outside landing\\n\")")
  jj(root, "bookmark", "set", "vibe", "-r", landed)
  const onto = await Effect.runPromise(service.tip("vibe"))
  const applied = await Effect.runPromise(service.apply(a, onto))
  assert.deepEqual(parentsOf(root, applied.atoms[0]!.commitId), [landed])
  const afterApply = operationOf(root)
  assert.deepEqual(await Effect.runPromise(service.apply(a, onto)), applied, "a replayed apply finds the stack applied")
  assert.equal(operationOf(root), afterApply)
  await Effect.runPromise(service.restore("vibe", a, applied))
  assert.deepEqual(parentsOf(root, `change_id(${applied.atoms[0]!.changeId})`), [tip])
  const afterRestore = operationOf(root)
  await Effect.runPromise(service.restore("vibe", a, applied))
  assert.equal(operationOf(root), afterRestore, "a replayed restore finds the stack on its base")
  const again = await Effect.runPromise(service.apply(a, onto))
  assert.equal(await Effect.runPromise(service.advance("vibe", landed, [again.head.commitId])), again.head.commitId)
  const afterAdvance = operationOf(root)
  assert.equal(await Effect.runPromise(service.advance("vibe", landed, [again.head.commitId])), again.head.commitId)
  assert.equal(operationOf(root), afterAdvance, "a replayed advance finds the target at the head")
})

test("a tip that moves during admission evicts the run and returns every admitted stack to its own base", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  jj(root, "new", tip)
  const original = { a: rootChanges(root, tip, a.head), d: rootChanges(root, tip, d.head) }
  const calls: Array<string> = []
  let moved = false
  const host = hostOf(
    t,
    root,
    scriptedChecks(root, calls, () => {
      if (moved || calls.length < 1) return
      // Another lander moves the tip while d is being checked.
      moved = true
      jj(root, "new", tip, "--no-edit", "-m", "outside landing")
      jj(root, "bookmark", "set", "vibe", "-r", "description(exact:\"outside landing\\n\")")
    })
  )
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a, d], checks: [fast] }, {
      executionId: "moved-during"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "evicted")
  assert.match(error.message, /vibe moved/)
  assert.deepEqual(calls, ["build:a", "build:d"])
  assert.deepEqual(parentsOf(root, `change_id(${original.a[0]})`), [tip])
  assert.deepEqual(parentsOf(root, `change_id(${original.d[0]})`), [tip], "d leaves a's head for its own base")
})

test("a stack built on a refused stack is refused, not admitted without the work it was built on", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "red.txt": "fails the build\n" }])
  jj(root, "new", a.head)
  await writeFile(join(root, "b.txt"), "b\n")
  jj(root, "commit", "-m", "b 0")
  const b: OutsideStack = { id: "b", title: "stack b", base: a.head, head: commitOf(root, "@-") }
  jj(root, "new", tip)
  const calls: Array<string> = []
  const host = hostOf(t, root, scriptedChecks(root, calls))
  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a, b], checks: [fast] }, {
      executionId: "dependent"
    })
  )
  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.stack, outcome.refusal?.reason]),
    [["a", "fast_gate"], ["b", "base_not_on_tip"]]
  )
  assert.deepEqual(calls, ["build:a"])
  assert.equal(result.tip, tip)
})

test("a stack its author reshaped after enqueueing is refused as stale", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a1.txt": "a1\n" }, { "a2.txt": "a2\n" }])
  const [, second] = rootChanges(root, tip, a.head)
  // The author moves the second commit beside the first: the same diffs, another shape.
  jj(root, "rebase", "-r", `change_id(${second})`, "-d", tip)
  jj(root, "new", tip)
  const host = hostOf(t, root, noChecks("a reshaped stack is never checked"))
  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a], checks: [fast] }, {
      executionId: "reshaped"
    })
  )
  assert.deepEqual(result.outcomes.map((outcome) => outcome.refusal?.reason), ["stale"])
  assert.equal(result.tip, tip)
})

test("two fast checks with one id are refused before any stack moves", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  jj(root, "new", tip)
  const host = hostOf(t, root, noChecks("nothing runs on an invalid check set"))
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({
      target: "vibe",
      expected: tip,
      stacks: [a],
      checks: [fast, { ...fast, target: "//:other" }]
    }, { executionId: "duplicate-checks" })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "invalid_request")
  assert.deepEqual(parentsOf(root, a.head), [tip])
})

test("a receipt that does not bind the applied head fails the run and returns the stack to its base", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  jj(root, "new", tip)
  const [first] = rootChanges(root, tip, a.head)
  // A delegate that measured the enqueued commit, not the applied one.
  const stale = RunCheck.toLayer(({ implementation, check }) =>
    Effect.succeed({
      checkId: check.id,
      target: check.target,
      tier: check.tier,
      change: implementation.change,
      commitId: a.head,
      treeId: implementation.head.treeId,
      inputDigest: checkInputDigest(implementation, check),
      status: "passed" as const,
      evidence: "fixture",
      findings: []
    })
  )
  // Move the tip first so the stack really leaves its base when applied.
  jj(root, "new", tip, "--no-edit", "-m", "outside landing")
  const landed = commitOf(root, "description(exact:\"outside landing\\n\")")
  jj(root, "bookmark", "set", "vibe", "-r", landed)
  const host = hostOf(t, root, stale)
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: landed, stacks: [a], checks: [fast] }, {
      executionId: "bad-receipt"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "invalid_receipt")
  assert.deepEqual(parentsOf(root, `change_id(${first})`), [tip], "an unadmitted stack never stays on the tip")
  assert.equal(commitOf(root, "vibe"), landed)
})

/** Exactly one visible commit carries this change: nothing was made divergent. */
const single = (root: string, change: string) =>
  assert.equal(field(root, `change_id(${change})`, "commit_id ++ \"\\n\"").split("\n").length, 1, `${change} diverged`)
/** The tip moves on with one outside commit, so admission really rebases. */
const moveTip = (root: string, from: string, name: string) => {
  jj(root, "new", from, "--no-edit", "-m", name)
  const moved = commitOf(root, `description(exact:"${name}\\n")`)
  jj(root, "bookmark", "set", "vibe", "-r", moved)
  return moved
}

test("a refused stack built on an admitted one stays on it, and nothing hidden comes back", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  jj(root, "new", a.head)
  await writeFile(join(root, "red.txt"), "fails the build\n")
  jj(root, "commit", "-m", "b 0")
  const b: OutsideStack = { id: "b", title: "stack b", base: a.head, head: commitOf(root, "@-") }
  jj(root, "new", tip)
  const [aChange] = rootChanges(root, tip, a.head)
  const moved = moveTip(root, tip, "outside landing")
  const calls: Array<string> = []
  const host = hostOf(t, root, scriptedChecks(root, calls))
  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: moved, stacks: [a, b], checks: [fast] }, {
      executionId: "dependent-moved"
    })
  )
  assert.deepEqual(result.outcomes.map((outcome) => [outcome.stack, outcome.status]), [["a", "admitted"], [
    "b",
    "refused"
  ]])
  single(root, aChange!)
  assert.equal(result.tip, commitOf(root, `change_id(${aChange})`))
  // Refused b stays on its own base: a's applied head.
  assert.deepEqual(parentsOf(root, `change_id(${changeOf(root, b.head)})`), [result.tip])
  // The next run reads the tip without a divergent change in the way.
  const next = await host.runPromise(
    AppendOutsideStack.execute({
      target: "vibe",
      expected: result.tip,
      stacks: [{ ...a, id: "again" }],
      checks: [fast]
    }, {
      executionId: "dependent-next"
    })
  )
  assert.deepEqual(next.outcomes.map((outcome) => outcome.refusal?.reason), ["already_applied"])
})

test("a stack whose base was amended in place is restored onto the amended base, not the hidden one", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "red.txt": "fails the build\n" }])
  jj(root, "new", tip)
  const tipChange = changeOf(root, tip)
  // The stack's tip is amended in place below the queued stack; jj carries the stack along.
  jj(root, "describe", "-r", "vibe", "-m", "tip, amended")
  const amended = commitOf(root, "vibe")
  const moved = moveTip(root, amended, "outside landing")
  const calls: Array<string> = []
  const host = hostOf(t, root, scriptedChecks(root, calls))
  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: moved, stacks: [a], checks: [fast] }, {
      executionId: "amended-base"
    })
  )
  assert.deepEqual(result.outcomes.map((outcome) => outcome.refusal?.reason), ["fast_gate"])
  assert.deepEqual(calls, ["build:a"], "an amended base keeps the stack admissible")
  single(root, tipChange)
  assert.deepEqual(
    parentsOf(root, `change_id(${rootChanges(root, amended, `change_id(${changeOf(root, a.head)})`)[0]})`),
    [
      amended
    ]
  )
})

test("a check delegate that fails returns every stack the run moved to its base before the run fails", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  jj(root, "new", tip)
  const [aFirst] = rootChanges(root, tip, a.head)
  const [dFirst] = rootChanges(root, tip, d.head)
  const moved = moveTip(root, tip, "outside landing")
  const calls: Array<string> = []
  // d's check host is down; a's check passes.
  const host = hostOf(
    t,
    root,
    RunCheck.toLayer(({ implementation, check }) =>
      implementation.change === "d"
        ? Effect.fail(new CodingError({ code: "check_infra", message: "the check host is down" }))
        : Effect.sync(() => {
          calls.push(`${check.id}:${implementation.change}`)
          return {
            checkId: check.id,
            target: check.target,
            tier: check.tier,
            change: implementation.change,
            commitId: implementation.head.commitId,
            treeId: implementation.head.treeId,
            inputDigest: checkInputDigest(implementation, check),
            status: "passed" as const,
            evidence: "fixture",
            findings: []
          }
        })
    )
  )
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: moved, stacks: [a, d], checks: [fast] }, {
      executionId: "check-down"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "check_infra")
  assert.deepEqual(calls, ["build:a"])
  assert.deepEqual(parentsOf(root, `change_id(${aFirst})`), [tip], "admitted a is not left on the tip")
  assert.deepEqual(parentsOf(root, `change_id(${dFirst})`), [tip])
  assert.equal(commitOf(root, "vibe"), moved)
})

test("an admitted stack rewritten before the next one applies evicts the run, and nothing hidden comes back", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  jj(root, "new", tip)
  const [aFirst] = rootChanges(root, tip, a.head)
  const [dFirst] = rootChanges(root, tip, d.head)
  const calls: Array<string> = []
  const host = hostOf(
    t,
    root,
    scriptedChecks(root, calls, () => {
      // While a is checked, its author rewords it: the head a is admitted at is hidden before d applies.
      if (calls.length === 0) jj(root, "describe", "-r", `change_id(${aFirst})`, "-m", "a, reworded")
    })
  )
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a, d], checks: [fast] }, {
      executionId: "rewritten-parent"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "evicted")
  assert.equal(commitOf(root, "vibe"), tip)
  single(root, aFirst!)
  single(root, dFirst!)
  assert.deepEqual(parentsOf(root, `change_id(${dFirst})`), [tip])
})

test("a finding naming another stack or commit makes the receipt invalid", () => {
  const stackA: OutsideStack = { id: "a", title: "stack a", base: "1".repeat(40), head: "2".repeat(40) }
  const head = {
    changeId: "k".repeat(32),
    commitId: "3".repeat(40),
    treeId: "4".repeat(40),
    operationId: "o",
    parentCommitIds: ["1".repeat(40)]
  }
  const implementation = {
    change: "a",
    parent: { ...head, commitId: "1".repeat(40), parentCommitIds: [] },
    atoms: [head],
    head,
    reads: [],
    writes: []
  }
  const receipt = {
    checkId: fast.id,
    target: fast.target,
    tier: fast.tier,
    change: "a",
    commitId: head.commitId,
    treeId: head.treeId,
    inputDigest: checkInputDigest(implementation, fast),
    status: "failed" as const,
    evidence: "fixture",
    findings: [{ owner: "b", sourceCommitId: head.commitId, message: "blames another stack" }]
  }
  const verdict = gate(stackA, [], [fast], implementation, { [fast.id]: receipt })
  assert.ok(verdict instanceof CodingError)
  assert.equal(verdict.code, "invalid_receipt")
  const own = gate(stackA, [], [fast], implementation, {
    [fast.id]: { ...receipt, findings: [{ ...receipt.findings[0]!, owner: "a" }] }
  })
  assert.ok(own instanceof StackRefused)
  // As FastGate allows an earlier Change, a finding may blame a stack earlier in the queue.
  const earlier = gate(stackA, ["b"], [fast], implementation, { [fast.id]: receipt })
  assert.ok(earlier instanceof StackRefused)
  assert.deepEqual(earlier.findings.map((finding) => finding.owner), ["b"])
})

test("a failed run never moves a stack a bookmark now sits on", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  jj(root, "new", tip)
  const [aFirst] = rootChanges(root, tip, a.head)
  const moved = moveTip(root, tip, "outside landing")
  const calls: Array<string> = []
  const host = hostOf(
    t,
    root,
    scriptedChecks(root, calls, () => {
      // While d is checked, another lander sets the tip onto a, whose check was green.
      if (calls.length === 1) jj(root, "bookmark", "set", "vibe", "-r", `change_id(${aFirst})`)
    })
  )
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: moved, stacks: [a, d], checks: [fast] }, {
      executionId: "landed-under"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "evicted")
  // The tip still carries the landing it started from, and a stays under it.
  assert.equal(commitOf(root, "vibe"), commitOf(root, `change_id(${aFirst})`))
  assert.notEqual(field(root, `${moved} & ::vibe`, "commit_id"), "")
})

test("a starting tip amended in place during the run still has its moved stacks swept back", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  jj(root, "new", tip)
  const [dFirst] = rootChanges(root, tip, d.head)
  const tipChange = changeOf(root, tip)
  const calls: Array<string> = []
  const host = hostOf(
    t,
    root,
    scriptedChecks(root, calls, () => {
      // While d is checked, the tip is amended in place; jj carries a and d along.
      if (calls.length === 1) jj(root, "describe", "-r", "vibe", "-m", "tip, amended")
    })
  )
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a, d], checks: [fast] }, {
      executionId: "amended-during"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "evicted")
  const amended = commitOf(root, `change_id(${tipChange})`)
  assert.deepEqual(parentsOf(root, `change_id(${dFirst})`), [amended], "d leaves a's head for its own base")
  single(root, tipChange)
})

test("two stacks with one id are refused before any stack moves", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  jj(root, "new", tip)
  const host = hostOf(t, root, noChecks("nothing runs on an invalid queue"))
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a, { ...d, id: "a" }], checks: [fast] }, {
      executionId: "duplicate-stacks"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "invalid_request")
  assert.deepEqual(parentsOf(root, d.head), [tip])
})

test("a head rewritten after its checks is not moved onto; the run is evicted and nothing diverges", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const d = await stack("d", [{ "d.txt": "d\n" }])
  jj(root, "new", tip)
  const [aFirst] = rootChanges(root, tip, a.head)
  const [dFirst] = rootChanges(root, tip, d.head)
  const moved = moveTip(root, tip, "outside landing")
  const calls: Array<string> = []
  const host = hostOf(
    t,
    root,
    scriptedChecks(root, calls, () => {
      // While d is checked, a's author rewords a; jj carries d along.
      if (calls.length === 1) jj(root, "describe", "-r", `change_id(${aFirst})`, "-m", "a, reworded")
    })
  )
  const error = await host.runPromise(Effect.flip(
    AppendOutsideStack.execute({ target: "vibe", expected: moved, stacks: [a, d], checks: [fast] }, {
      executionId: "rewritten-head"
    })
  ))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "evicted")
  assert.equal(commitOf(root, "vibe"), moved)
  single(root, aFirst!)
  single(root, dFirst!)
})

test("a red stack carrying its author's own bookmark is refused and restored with it; the queue moves on", async (t) => {
  const { root, tip, stack } = await repository(t)
  const a = await stack("a", [{ "a2.txt": "a2\n" }])
  const b = await stack("b", [{ "red.txt": "fails the build\n" }])
  const c = await stack("c", [{ "c.txt": "c\n" }])
  jj(root, "bookmark", "create", "lane-b", "-r", b.head)
  jj(root, "new", tip)
  const calls: Array<string> = []
  const host = hostOf(t, root, scriptedChecks(root, calls))
  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [a, b, c], checks: [fast] }, {
      executionId: "author-bookmark"
    })
  )
  assert.deepEqual(result.outcomes.map((outcome) => [outcome.stack, outcome.refusal?.reason ?? null]), [
    ["a", null],
    ["b", "fast_gate"],
    ["c", null]
  ])
  assert.deepEqual(parentsOf(root, "lane-b"), [tip], "b and its bookmark are back on b's base")
  assert.equal(result.tip, commitOf(root, "vibe"))
})

test("a stack that must move but is immutable is refused alone; the rest of the batch is admitted", async (t) => {
  const { root, tip, stack } = await repository(t)
  const first = await stack("first", [{ "first.txt": "first\n" }])
  const frozen = await stack("frozen", [{ "frozen.txt": "frozen\n" }])
  const last = await stack("last", [{ "last.txt": "last\n" }])
  jj(root, "new", tip)
  // Any immutable head does this: an untracked remote bookmark, a tag, or trunk.
  jj(root, "config", "set", "--repo", "revset-aliases.\"immutable_heads()\"", frozen.head)
  const calls: Array<string> = []
  const host = hostOf(t, root, scriptedChecks(root, calls))

  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [first, frozen, last], checks: [fast] }, {
      executionId: "immutable-stack"
    })
  )

  assert.deepEqual(result.outcomes.map(({ stack, status, refusal }) => [stack, status, refusal?.reason ?? null]), [
    ["first", "admitted", null],
    ["frozen", "refused", "immutable"],
    ["last", "admitted", null]
  ])
  assert.deepEqual(calls, ["build:first", "build:last"])
  // The frozen stack did not move, and the tip carries the other two in order.
  assert.deepEqual(parentsOf(root, frozen.head), [tip])
  assert.equal(commitOf(root, "vibe"), result.tip)
  assert.equal(
    field(root, `${tip}..vibe`, "change_id ++ \"\\n\"").split("\n").filter((id) => id !== "").length,
    2
  )
})

test("an immutable stack already on the tip needs no rewrite and is admitted", async (t) => {
  const { root, tip, stack } = await repository(t)
  const frozen = await stack("frozen", [{ "frozen.txt": "frozen\n" }])
  jj(root, "new", tip)
  jj(root, "config", "set", "--repo", "revset-aliases.\"immutable_heads()\"", frozen.head)
  const calls: Array<string> = []
  const host = hostOf(t, root, scriptedChecks(root, calls))

  const result = await host.runPromise(
    AppendOutsideStack.execute({ target: "vibe", expected: tip, stacks: [frozen], checks: [fast] }, {
      executionId: "immutable-on-tip"
    })
  )

  assert.deepEqual(result.outcomes.map(({ status }) => status), ["admitted"])
  assert.equal(commitOf(root, "vibe"), frozen.head)
})
