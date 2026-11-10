/**
 * The land queue against real jj and git: validation and publication share
 * one FIFO lease, a change tested on an older `main`
 * is retested only when the new `main` touched its packages, and a baseline
 * (main commit, label) is measured once.
 */
import { Effect } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { type Checked, type Checks, LandFailed, makeBaselines, makeLander } from "../land.vibe"

import { type RetryServices, withRetryRuntime } from "./retry-runtime.ts"

const run = <A, E>(effect: Effect.Effect<A, E, RetryServices>) => Effect.runPromise(effect.pipe(withRetryRuntime))

const fixture = (t: { after: (fn: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-queue-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const previousLock = process.env.SMITHERS_LAND_LOCK
  process.env.SMITHERS_LAND_LOCK = join(root, "main-push.lock")
  t.after(() => {
    if (previousLock === undefined) delete process.env.SMITHERS_LAND_LOCK
    else process.env.SMITHERS_LAND_LOCK = previousLock
  })
  const config = join(root, "jj.toml")
  writeFileSync(config, "[user]\nname = \"t\"\nemail = \"t@t\"\n")
  Object.assign(process.env, {
    JJ_CONFIG: config,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t"
  })
  const cmd = (cwd: string, command: string, ...args: Array<string>) =>
    execFileSync(command, args, { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] })
  const origin = join(root, "origin")
  mkdirSync(origin)
  cmd(origin, "jj", "git", "init", ".")
  for (const file of ["a/x.txt", "b/y.txt"]) {
    mkdirSync(join(origin, file, ".."), { recursive: true })
    writeFileSync(join(origin, file), "one\n")
  }
  cmd(origin, "jj", "commit", "-m", "first")
  cmd(origin, "jj", "bookmark", "set", "main", "-r", "@-")
  const other = join(root, "other")
  cmd(root, "jj", "git", "clone", origin, other)

  const pushElsewhere = (file: string) => {
    cmd(other, "jj", "git", "fetch")
    cmd(other, "jj", "new", "main@origin")
    mkdirSync(join(other, file, ".."), { recursive: true })
    writeFileSync(join(other, file), `${file}\n`)
    cmd(other, "jj", "commit", "-m", `elsewhere ${file}`)
    cmd(other, "jj", "bookmark", "set", "main", "-r", "@-")
    cmd(other, "jj", "git", "push", "-b", "main")
    return cmd(other, "jj", "log", "--no-graph", "-r", "@-", "-T", "commit_id").trim()
  }
  // Independent fixture repositories; never add Mac workspaces.
  const change = (name: string, file: string) => {
    const workspace = join(root, name)
    cmd(root, "jj", "git", "clone", origin, workspace)
    mkdirSync(join(workspace, file, ".."), { recursive: true })
    writeFileSync(join(workspace, file), `${name}\n`)
    cmd(workspace, "jj", "commit", "-m", name)
    return { workspace, id: cmd(workspace, "jj", "log", "--no-graph", "-r", "@-", "-T", "change_id").trim() }
  }
  const revision = (rev: string) => {
    cmd(origin, "jj", "git", "import", "--ignore-working-copy")
    return cmd(origin, "jj", "log", "--no-graph", "-r", rev, "-T", "commit_id").trim()
  }
  const originMain = () => revision("main")
  const subjects = () => {
    cmd(origin, "jj", "git", "import", "--ignore-working-copy")
    return cmd(origin, "jj", "log", "--no-graph", "-r", "::main ~ root()", "-T", "description.first_line() ++ \"\\n\"")
      .trim().split("\n")
  }
  return { pushElsewhere, change, originMain, subjects, revision }
}

const index = [{ label: "//a:test", kinds: ["test"] }, { label: "//b:test", kinds: ["test"] }]

/** Checks that only record: every test run is green unless `onTest` says otherwise. */
const fakeChecks = (onTest: (workspace: string, labels: ReadonlyArray<string>) => Effect.Effect<Checked>) => {
  const tested: Array<string> = []
  const checks: Checks = {
    prepare: () => Effect.void,
    index: () => Effect.succeed(index),
    test: (workspace, labels) => {
      tested.push(labels.join(" "))
      return onTest(workspace, labels)
    },
    redOnMain: () => Effect.succeed([])
  }
  return { checks, tested }
}

const green: Checked = { _tag: "Green" }

test("two changes validate and publish serially under the shared FIFO lease", { timeout: 60_000 }, async (t) => {
  const { change, subjects } = fixture(t)
  const one = change("one", "a/one.txt"), two = change("two", "b/two.txt")
  const stages: Array<string> = []
  const { checks, tested } = fakeChecks((workspace) =>
    Effect.sync(() => {
      assert.equal(existsSync(process.env.SMITHERS_LAND_LOCK!), true)
      stages.push(`check ${workspace}`)
      return green
    })
  )
  const land = makeLander({
    checks,
    beforePush: () =>
      Effect.sync(() => {
        assert.equal(existsSync(process.env.SMITHERS_LAND_LOCK!), true)
        stages.push("push")
      })
  })
  const landed = await run(
    Effect.all([land(one.workspace, one.id), land(two.workspace, two.id)], { concurrency: "unbounded" })
  )
  assert.equal(landed.length, 2)
  assert.match(stages[0]!, /^check /)
  assert.equal(stages[1], "push")
  assert.match(stages[2]!, /^check /)
  assert.equal(stages[3], "push")
  assert.deepEqual(tested.sort(), ["//a:test", "//b:test"])
  assert.deepEqual(subjects().slice(0, 2).sort(), ["one", "two"])
})

test("a change tested on an older main lands without retesting when main moved elsewhere", {
  timeout: 60_000
}, async (t) => {
  const { change, pushElsewhere, revision } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  let moved = ""
  const { checks, tested } = fakeChecks(() =>
    Effect.sync(() => {
      if (moved === "") moved = pushElsewhere("b/elsewhere.txt")
      return green
    })
  )

  const landed = await run(makeLander({ checks })(mine.workspace, mine.id))

  assert.deepEqual(tested, ["//a:test"])
  assert.equal(revision("main"), landed)
  assert.equal(revision(`${landed}-`), moved)
})

test(
  "an outside push after the final fetch retries on a fresh ticket with fresh validation",
  { timeout: 60_000 },
  async (t) => {
    const { change, pushElsewhere, revision } = fixture(t)
    const mine = change("retry", "a/retry.txt")
    let moved = ""
    const { checks, tested } = fakeChecks(() => Effect.succeed(green))
    const land = makeLander({
      checks,
      beforePush: () =>
        Effect.sync(() => {
          if (moved === "") moved = pushElsewhere("b/race.txt")
        })
    })
    const landed = await run(land(mine.workspace, mine.id))
    assert.deepEqual(tested, ["//a:test", "//a:test"])
    assert.equal(revision("main"), landed)
    assert.equal(revision(`${landed}-`), moved)
  }
)

test("a change tested on an older main is retested when main touched its packages", {
  timeout: 60_000
}, async (t) => {
  const { change, pushElsewhere, revision } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  let moved = ""
  const { checks, tested } = fakeChecks(() =>
    Effect.sync(() => {
      if (moved === "") moved = pushElsewhere("a/elsewhere.txt")
      return green
    })
  )

  const landed = await run(makeLander({ checks })(mine.workspace, mine.id))

  assert.deepEqual(tested, ["//a:test", "//a:test"])
  assert.equal(revision(`${landed}-`), moved)
})

test("re-landing a change main already contains answers its commit without checks", {
  timeout: 60_000
}, async (t) => {
  const { change, originMain } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  const { checks, tested } = fakeChecks(() => Effect.succeed(green))
  const land = makeLander({ checks })
  const first = await run(land(mine.workspace, mine.id))

  const again = await run(land(mine.workspace, mine.id))

  assert.equal(again, first)
  assert.equal(originMain(), first)
  assert.deepEqual(tested, ["//a:test"])
})

test("a red label main also fails does not block; a new red does", { timeout: 60_000 }, async (t) => {
  const { change } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  const { checks } = fakeChecks(() => Effect.succeed({ _tag: "Red", labels: ["//a:test"] } as Checked))
  const excused = makeLander({ checks: { ...checks, redOnMain: (labels) => Effect.succeed(labels) } })
  const blocked = makeLander({ checks })

  const failure = await run(Effect.flip(blocked(mine.workspace, mine.id)))
  assert.match(failure.message, /checks red for .*: \/\/a:test/)
  assert.match(await run(excused(mine.workspace, mine.id)), /^[0-9a-f]{40}$/)
})

test("the baseline cache measures a (commit, label) once, across concurrent asks and restarts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-baseline-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "baseline.json")
  const measured: Array<string> = []
  const measure = (commit: string, labels: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      measured.push(...labels.map((label) => `${commit} ${label}`))
      yield* Effect.sleep("50 millis")
      const red = labels.filter((label) => label === "//l2:test")
      return red.length === 0 ? green : { _tag: "Red", labels: red } as Checked
    })
  const redOn = makeBaselines({ file, measure })

  const [first, second] = await run(Effect.all([
    redOn("c1", ["//l1:test", "//l2:test"]),
    redOn("c1", ["//l2:test", "//l3:test"])
  ], { concurrency: "unbounded" }))

  assert.deepEqual(first, ["//l2:test"])
  assert.deepEqual(second, ["//l2:test"])
  assert.deepEqual(measured.sort(), ["c1 //l1:test", "c1 //l2:test", "c1 //l3:test"])

  // A restarted host reads the file; another commit is measured afresh.
  const restarted = makeBaselines({ file, measure })
  assert.deepEqual(await run(restarted("c1", ["//l3:test", "//l2:test"])), ["//l2:test"])
  assert.equal(measured.length, 3)
  assert.deepEqual(await run(restarted("c2", ["//l2:test"])), ["//l2:test"])
  assert.equal(measured.length, 4)
})

test("a baseline that could not run blocks its askers and is not remembered", async () => {
  let runs = 0
  const redOn = makeBaselines({
    measure: () => Effect.sync(() => (runs += 1, { _tag: "Broken", message: "no install" } as Checked))
  })
  assert.match((await run(Effect.flip(redOn("c1", ["//a:test"])))).message, /no install/)
  assert.match((await run(Effect.flip(redOn("c1", ["//a:test"])))).message, /no install/)
  assert.equal(runs, 2)
})

test("a baseline that failed fails its askers and runs again on the next ask", async () => {
  let runs = 0
  const redOn = makeBaselines({
    measure: () =>
      Effect.suspend(() =>
        (runs += 1) === 1 ? Effect.fail(new LandFailed({ message: "jj workspace add" })) : Effect.succeed(green)
      )
  })
  const failure = await run(Effect.flip(redOn("c1", ["//a:test"])))
  assert.equal(failure.message, "jj workspace add")
  assert.deepEqual(await run(redOn("c1", ["//a:test"])), [])
  assert.equal(runs, 2)
})
