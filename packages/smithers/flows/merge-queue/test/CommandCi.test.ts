import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Config, Job, Progress, Tree } from "../src/index.ts"
import { Ci, CommandCi, Driver, empty, JjRepository } from "../src/index.ts"
import { makeWorld } from "./support/World.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const root = mkdtempSync(join(tmpdir(), "merge-queue-ci-"))
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, any>> = []
afterAll(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  rmSync(root, { recursive: true, force: true })
})

const host = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, NodePath.layer))

let repositories = 0

/**
 * A real jj repository, the queue's view of it, and a CI whose check `n`
 * fails on a commit that contains the file `fail-n.txt` and sleeps first when
 * the commit contains `slow-n.txt`.
 */
const setup = async (
  command?: (check: number, commit: string) => CommandCi.Command,
  stream?: (checks: ReadonlyArray<number>, commit: string) => CommandCi.Command
) => {
  const path = join(root, `repo-${repositories++}`)
  const jj = (...args: ReadonlyArray<string>): string =>
    execFileSync(
      "jj",
      [
        "--config",
        "user.name=queue",
        "--config",
        "user.email=queue@example.com",
        "--no-pager",
        "--color=never",
        ...args
      ],
      { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
  execFileSync("jj", ["git", "init", path], { stdio: "ignore" })
  writeFileSync(join(path, "base.txt"), "base\n")
  jj("commit", "-m", "base")
  jj("bookmark", "create", "main", "-r", "@-")
  const change = (files: Readonly<Record<string, string>>): string => {
    jj("new", "main", "-m", "change")
    for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text)
    jj("new")
    return jj("log", "--no-graph", "-r", "@-", "-T", "commit_id").trim()
  }
  const has = (commit: string, file: string) =>
    `(cd '${path}' && jj --ignore-working-copy file list -r ${commit} 2>/dev/null | grep -qx ${file})`
  const script = (check: number, commit: string): CommandCi.Command => ({
    command: "sh",
    args: ["-c", `if ${has(commit, `slow-${check}.txt`)}; then sleep 3; fi; ! ${has(commit, `fail-${check}.txt`)}`]
  })
  const base = ManagedRuntime.make(host)
  runtimes.push(base)
  const repository = await base.runPromise(
    JjRepository.make({ path, bookmark: "main", ledger: join(path, ".jj", "queue-ledger.json"), poll: "5 millis" })
  )
  const layer = Layer.provideMerge(
    Layer.merge(
      stream === undefined
        ? CommandCi.layer({ repository, command: command ?? script, poll: "5 millis" })
        : CommandCi.streamed({ repository, command: stream, poll: "5 millis" }),
      JjRepository.target(repository, "5 millis")
    ),
    host
  )
  const runtime = ManagedRuntime.make(layer)
  runtimes.push(runtime)
  const ci = <A>(use: (ci: Ci["Service"]) => Effect.Effect<A, any>): Promise<A> =>
    runtime.runPromise(Effect.flatMap(Ci, use))
  const register = (id: number, rev: number, commit: string) =>
    base.runPromise(repository.register({ id, rev }, commit))
  /** Waits until the run has `count` results or is lost, and returns its progress. */
  const settled = async (run: number, count: number): Promise<Progress> => {
    await ci((service) => service.wait([{ run, finished: count - 1 }]))
    return ci((service) => service.progress(run))
  }
  return { path, jj, change, repository, runtime, ci, register, settled }
}

const tree = (...parts: ReadonlyArray<readonly [number, number]>): Tree => parts.map(([id, rev]) => ({ id, rev }))

const job = (run: number, parts: Tree, checks: ReadonlyArray<number> = [1, 2]): Job => ({
  run,
  tree: parts,
  checks,
  eta: 0
})

// Real jj and real processes: a budget for a loaded host, still finite so a hang fails.
describe.skipIf(!jjInstalled)("CI as commands on candidate commits", { timeout: 120_000 }, () => {
  it("a check passes when its command exits 0 and fails otherwise, for the candidate commit", async () => {
    const world = await setup()
    await world.register(1, 0, world.change({ "one.txt": "one\n" }))
    await world.register(2, 0, world.change({ "fail-2.txt": "broken\n" }))
    await world.ci((ci) => ci.reconcile([job(0, tree([1, 0])), job(1, tree([1, 0], [2, 0]))]))
    const good = await world.settled(0, 2)
    const bad = await world.settled(1, 2)
    const verdicts = (progress: Progress) =>
      progress._tag === "running"
        ? Object.fromEntries(progress.finished.map((entry) => [entry.check, entry.verdict]))
        : {}
    expect(verdicts(good)).toEqual({ 1: "pass", 2: "pass" })
    expect(verdicts(bad)).toEqual({ 1: "pass", 2: "fail" })
  })

  it("streams: a fast check's result is there while a slow check still runs", async () => {
    const world = await setup()
    await world.register(1, 0, world.change({ "slow-1.txt": "x\n", "fail-2.txt": "x\n" }))
    await world.ci((ci) => ci.reconcile([job(0, tree([1, 0]))]))
    const early = await world.settled(0, 1)
    expect(early).toMatchObject({ _tag: "running", finished: [{ check: 2, verdict: "fail" }] })
    const late = await world.settled(0, 2)
    expect(late._tag === "running" && late.finished.map((entry) => entry.check)).toEqual([2, 1])
    expect(late._tag === "running" && late.finished.every((entry) => entry.duration >= 0)).toBe(true)
  })

  it("a change that does not apply on the changes before it fails every check at once", async () => {
    const world = await setup()
    await world.register(1, 0, world.change({ "same.txt": "mine\n" }))
    await world.register(2, 0, world.change({ "same.txt": "yours\n" }))
    await world.ci((ci) => ci.reconcile([job(0, tree([1, 0], [2, 0]))]))
    expect(await world.settled(0, 2)).toEqual({
      _tag: "running",
      finished: [{ check: 1, verdict: "fail", duration: 0 }, { check: 2, verdict: "fail", duration: 0 }]
    })
  })

  it("loses the run, blaming nobody, when the tree is stale, unknown, or a check cannot start", async () => {
    const world = await setup()
    await world.register(1, 0, world.change({ "one.txt": "one\n" }))
    await world.ci((ci) => ci.reconcile([job(0, tree([9, 0], [1, 0])), job(1, tree([5, 0]))]))
    expect(await world.settled(0, 1)).toEqual({ _tag: "lost" })
    expect(await world.settled(1, 1)).toEqual({ _tag: "lost" })
    world.jj("bookmark", "set", "main", "-r", world.change({ "other.txt": "theirs\n" }))
    await world.ci((ci) => ci.reconcile([job(2, tree([1, 0]))]))
    expect(await world.settled(2, 1)).toEqual({ _tag: "lost" })
    const broken = await setup(() => ({ command: join(root, "no-such-program"), args: [], cwd: root }))
    await broken.register(1, 0, broken.change({ "one.txt": "one\n" }))
    await broken.ci((ci) => ci.reconcile([job(0, tree([1, 0]), [1])]))
    expect(await broken.settled(0, 1)).toEqual({ _tag: "lost" })
  })

  it("builds the candidates of many runs at once without losing one", async () => {
    const world = await setup()
    for (const id of [1, 2, 3, 4, 5, 6]) await world.register(id, 0, world.change({ [`f${id}.txt`]: "x\n" }))
    const prefix = (count: number) => tree(...[1, 2, 3, 4, 5, 6].slice(0, count).map((id) => [id, 0] as const))
    await world.ci((ci) => ci.reconcile([1, 2, 3, 4, 5, 6].map((count) => job(count, prefix(count), [1]))))
    for (const count of [1, 2, 3, 4, 5, 6]) {
      expect(await world.settled(count, 1)).toMatchObject({ _tag: "running", finished: [{ verdict: "pass" }] })
    }
    await world.runtime.runPromise(world.repository.advance([], prefix(6)))
    expect(await world.runtime.runPromise(world.repository.tip)).toEqual(prefix(6))
  })

  it("runs exactly the jobs it is given: a run that is no longer wanted is stopped and forgotten", async () => {
    const world = await setup()
    await world.register(1, 0, world.change({ "slow-1.txt": "x\n" }))
    await world.ci((ci) => ci.reconcile([job(0, tree([1, 0]), [1])]))
    await world.ci((ci) => ci.reconcile([job(0, tree([1, 0]), [1])]))
    await world.ci((ci) => ci.reconcile([]))
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(await world.ci((ci) => ci.progress(0))).toEqual({ _tag: "running", finished: [] })
  })

  it("one process per run: each check's verdict is read as its line prints, the rest is ignored", async () => {
    const lines = [
      "starting",
      "2 fail 7",
      "2 pass",
      "9 pass",
      "sleep",
      "1 pass",
      "done"
    ]
    const world = await setup(undefined, (checks, commit) => ({
      command: "sh",
      args: [
        "-c",
        lines.map((line) => line === "sleep" ? "sleep 3" : `echo '${line}'`).join("; ") + `; : ${checks} ${commit}`
      ]
    }))
    await world.register(1, 0, world.change({ "one.txt": "one\n" }))
    await world.ci((ci) => ci.reconcile([job(0, tree([1, 0]))]))
    expect(await world.settled(0, 1)).toEqual({
      _tag: "running",
      finished: [{ check: 2, verdict: "fail", duration: 7 }]
    })
    const late = await world.settled(0, 2)
    expect(late).toMatchObject({ _tag: "running", finished: [{ check: 2 }, { check: 1, verdict: "pass" }] })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await world.ci((ci) => ci.progress(0))).toEqual(late)
  })

  it("one process per run: ending with a check unreported, or not starting, loses the run", async () => {
    const quiet = await setup(undefined, () => ({ command: "sh", args: ["-c", "echo '1 pass'"] }))
    await quiet.register(1, 0, quiet.change({ "one.txt": "one\n" }))
    await quiet.ci((ci) => ci.reconcile([job(0, tree([1, 0]))]))
    expect(await quiet.settled(0, 2)).toEqual({ _tag: "lost" })
    const broken = await setup(undefined, () => ({ command: join(root, "no-such-program"), args: [], cwd: root }))
    await broken.register(1, 0, broken.change({ "one.txt": "one\n" }))
    await broken.ci((ci) => ci.reconcile([job(0, tree([1, 0]))]))
    expect(await broken.settled(0, 1)).toEqual({ _tag: "lost" })
  })

  it("end to end on a real repository: a failing change is fixed and everything lands on tested commits", async () => {
    const config: Config = { required: [1, 2], maxAttempts: 2, maxBatch: 4, maxRuns: 4, window: 3, defaultDuration: 1 }
    const world = await setup()
    await world.register(1, 0, world.change({ "one.txt": "one\n" }))
    await world.register(2, 0, world.change({ "two.txt": "two\n", "fail-1.txt": "broken\n" }))
    await world.register(3, 0, world.change({ "three.txt": "three\n" }))
    const fake = makeWorld(config, { fix: () => undefined })
    for (const id of [1, 2, 3]) fake.enqueue(id)
    fake.close()
    let position: Driver.Position = { state: empty, cursor: 0, closed: false, ended: [] }
    let fixedIt = false
    for (let rounds = 0; rounds < 200; rounds++) {
      if (!fixedIt && fake.briefs.some((brief) => brief.id === 2)) {
        fixedIt = true
        expect(fake.briefs.at(-1)).toMatchObject({ id: 2, rev: 0, attempt: 1, failures: [1] })
        await world.register(2, 1, world.change({ "two.txt": "two\n" }))
        fake.answer(2, 1, { _tag: "fixed" })
      }
      const outcome = await world.runtime.runPromise(
        Driver.round(config, position).pipe(Effect.provide(fake.people)) as Effect.Effect<
          Driver.Outcome
        >
      )
      position = outcome
      if (outcome.done) break
    }
    expect(Object.fromEntries(position.state.changes.map((change) => [change.id, change.status._tag])))
      .toEqual({ 1: "merged", 2: "merged", 3: "merged" })
    expect(world.jj("file", "list", "-r", "main").trim().split("\n").sort())
      .toEqual(["base.txt", "one.txt", "three.txt", "two.txt"])
    expect(position.state.changes[1]).toMatchObject({ rev: 1, attempts: 1 })
  }, 120_000)
})
