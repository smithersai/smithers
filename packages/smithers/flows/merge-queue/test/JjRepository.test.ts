import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawnerModule from "effect/process/ChildProcessSpawner"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Config, Tree } from "../src/index.ts"
import type { Unavailable } from "../src/index.ts"
import { Driver, empty, JjRepository, Target } from "../src/index.ts"
import { makeWorld } from "./support/World.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const root = mkdtempSync(join(tmpdir(), "merge-queue-jj-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const host = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, NodePath.layer))

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(host)) as Effect.Effect<A, E>)

const runExit = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(host)) as Effect.Effect<A, E>)

let repositories = 0

/** A real jj repository with a `main` bookmark on one commit. */
const repository = () => {
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
  /** Commits a change to one file on top of the base, off the bookmark, and returns its commit id. */
  const change = (file: string, text: string): string => {
    jj("new", "main", "-m", `change ${file}`)
    writeFileSync(join(path, file), text)
    jj("new")
    return jj("log", "--no-graph", "-r", "@-", "-T", "commit_id").trim()
  }
  const head = (): string => jj("log", "--no-graph", "-r", "main", "-T", "commit_id").trim()
  const files = (): ReadonlyArray<string> => jj("file", "list", "-r", "main").trim().split("\n").sort()
  const options = { path, bookmark: "main", ledger: join(path, ".jj", "queue-ledger.json"), poll: "5 millis" } as const
  return { path, jj, change, head, files, options }
}

const tree = (...parts: ReadonlyArray<readonly [number, number]>): Tree => parts.map(([id, rev]) => ({ id, rev }))

describe.skipIf(!jjInstalled)("the target as a jj bookmark", () => {
  it("starts with an empty tree: the queue's tree is what follows the bookmark it found", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    expect(await run(queue.tip)).toEqual([])
    expect(await run(queue.candidate([]))).toEqual({ _tag: "built", commit: repo.head() })
  })

  it("builds a candidate by replaying each change on the tip, and lands exactly that commit", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "one\n")))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("two.txt", "two\n")))
    const base = repo.head()
    const built = await run(queue.candidate(tree([1, 0], [2, 0])))
    expect(built._tag).toBe("built")
    const commit = built._tag === "built" ? built.commit : ""
    expect(repo.jj("log", "--no-graph", "-r", `${base}..${commit}`, "-T", "commit_id ++ \"\\n\"").trim().split("\n"))
      .toHaveLength(2)
    expect(repo.head()).toBe(base)
    expect(await run(queue.candidate(tree([1, 0], [2, 0])))).toEqual(built)
    await run(queue.advance([], tree([1, 0], [2, 0])))
    expect(repo.head()).toBe(commit)
    expect(repo.files()).toEqual(["base.txt", "one.txt", "two.txt"])
    expect(await run(queue.tip)).toEqual(tree([1, 0], [2, 0]))
  })

  it("two candidates that start with the same parts share those commits, so landing one never strands the other", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "one\n")))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("two.txt", "two\n")))
    const long = await run(queue.candidate(tree([1, 0], [2, 0])))
    const short = await run(queue.candidate(tree([1, 0])))
    const commit = (candidate: JjRepository.Candidate): string => candidate._tag === "built" ? candidate.commit : ""
    expect(repo.jj("log", "--no-graph", "-r", `${commit(short)} & ::${commit(long)}`, "-T", "commit_id").trim())
      .toBe(commit(short))
    await run(queue.advance([], tree([1, 0])))
    await run(queue.advance(tree([1, 0]), tree([1, 0], [2, 0])))
    expect(repo.head()).toBe(commit(long))
  })

  it("remembers where it started: a commit that lands before anything else is still seen", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    expect(await run(queue.tip)).toEqual([])
    repo.jj("bookmark", "set", "main", "-r", repo.change("other.txt", "theirs\n"))
    expect(await run(queue.tip)).toEqual(tree([JjRepository.firstForeign, 0]))
    const reopened = await run(JjRepository.make(repo.options))
    expect(await run(reopened.tip)).toEqual(tree([JjRepository.firstForeign, 0]))
  })

  it("advance is a compare-and-swap: it does nothing when the bookmark is not on `from`", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "one\n")))
    await run(queue.candidate(tree([1, 0])))
    const before = repo.head()
    await run(queue.advance(tree([9, 0]), tree([1, 0])))
    expect(repo.head()).toBe(before)
    await run(queue.advance([], tree([1, 0])))
    await run(queue.advance([], tree([1, 0])))
    expect(await run(queue.tip)).toEqual(tree([1, 0]))
  })

  it("reports a commit someone else put on the bookmark as a part of its own, and a stale candidate as stale", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "one\n")))
    await run(queue.candidate(tree([1, 0])))
    repo.jj("bookmark", "set", "main", "-r", repo.change("other.txt", "theirs\n"))
    const foreign = JjRepository.firstForeign
    expect(await run(queue.tip)).toEqual(tree([foreign, 0]))
    expect(await run(queue.tip)).toEqual(tree([foreign, 0]))
    expect(await run(queue.candidate(tree([1, 0])))).toEqual({ _tag: "stale" })
    const rebuilt = await run(queue.candidate(tree([foreign, 0], [1, 0])))
    expect(rebuilt._tag).toBe("built")
    await run(queue.advance(tree([foreign, 0]), tree([foreign, 0], [1, 0])))
    expect(repo.files()).toEqual(["base.txt", "one.txt", "other.txt"])
  })

  it("names the part that does not apply on the parts before it", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("same.txt", "mine\n")))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("same.txt", "yours\n")))
    expect(await run(queue.candidate(tree([1, 0], [2, 0])))).toEqual({ _tag: "conflict", part: { id: 2, rev: 0 } })
    const exit = await runExit(queue.advance([], tree([1, 0], [2, 0])))
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Unavailable")
  })

  it("a fixed revision replaces the commit registered for the change", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "broken\n")))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "replaced\n")))
    await run(queue.register({ id: 1, rev: 1 }, repo.change("one.txt", "fixed\n")))
    await run(queue.advance([], tree([1, 1])))
    expect(repo.jj("file", "show", "-r", "main", "one.txt")).toBe("fixed\n")
  })

  it("is unavailable for a revision nobody registered, a missing bookmark, a bad ledger and a missing repository", async () => {
    const detail = (effect: Effect.Effect<unknown, Unavailable, any>): Promise<string> =>
      run(Effect.map(Effect.flip(effect), (error) => error.detail))
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    expect(await detail(queue.candidate(tree([5, 0])))).toContain("no commit registered for 5.0")
    const none = await run(
      JjRepository.make({ ...repo.options, bookmark: "absent", ledger: join(repo.path, "none.json") })
    )
    expect(await detail(none.tip)).toContain("no bookmark absent")
    writeFileSync(join(repo.path, "bad.json"), "{}")
    const bad = await run(JjRepository.make({ ...repo.options, ledger: join(repo.path, "bad.json") }))
    expect(await detail(bad.tip)).toContain("ledger is not readable")
    const unwritable = await run(
      JjRepository.make({ ...repo.options, ledger: join(repo.path, "no", "dir", "l.json") })
    )
    expect(await detail(unwritable.register({ id: 1, rev: 0 }, "x"))).not.toBe("")
    // A host that cannot start a process: the faulty spawner is injected, nothing is mocked.
    const broken = Layer.provideMerge(
      Layer.succeed(
        ChildProcessSpawner,
        ChildProcessSpawnerModule.make(() =>
          Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }))
        )
      ),
      NodeFileSystem.layer
    )
    const cannotSpawn = await Effect.runPromise(
      Effect.gen(function*() {
        const elsewhere = yield* JjRepository.make({ ...repo.options, ledger: join(root, "l.json") })
        return yield* Effect.map(Effect.flip(elsewhere.tip), (error) => error.detail)
      }).pipe(Effect.provide(broken))
    )
    expect(cannotSpawn).toContain("jj could not run")
    const readOnly = join(repo.path, "read-only.json")
    const frozen = await run(JjRepository.make({ ...repo.options, ledger: readOnly }))
    await run(frozen.tip)
    chmodSync(readOnly, 0o444)
    expect(await detail(frozen.register({ id: 1, rev: 0 }, "x"))).not.toBe("")
    const ledgerIsDirectory = await run(JjRepository.make({ ...repo.options, ledger: repo.path }))
    expect(await detail(ledgerIsDirectory.tip)).not.toBe("")
    // A jj whose `duplicate` prints nothing the queue can read: the real spawner, with that one command replaced.
    const mute = Layer.provideMerge(
      Layer.effect(
        ChildProcessSpawner,
        Effect.map(ChildProcessSpawner, (real) =>
          ChildProcessSpawnerModule.make((command) =>
            real.spawn(
              "args" in command && command.args.includes("duplicate") ? ChildProcess.make("echo", ["nothing"]) : command
            )
          ))
      ),
      host
    )
    const unreadable = await Effect.runPromise(
      Effect.gen(function*() {
        const muted = yield* JjRepository.make({ ...repo.options, ledger: join(root, "mute.json") })
        yield* muted.register({ id: 1, rev: 0 }, repo.head())
        return yield* Effect.map(Effect.flip(muted.candidate(tree([1, 0]))), (error) => error.detail)
      }).pipe(Effect.provide(mute)) as Effect.Effect<string>
    )
    expect(unreadable).toContain("printed no new commit")
    const stuck = await runExit(
      Effect.flatMap(Target, (target) => target.wait([])).pipe(
        Effect.timeout("600 millis"),
        Effect.provide(JjRepository.target(none, "5 millis"))
      )
    )
    expect(Exit.isFailure(stuck)).toBe(true)
    const notRepository = await run(JjRepository.make({ ...repo.options, path: root, ledger: join(root, "m.json") }))
    expect(await detail(notRepository.tip)).toContain("exited")
  })

  it("the Target service waits until the bookmark moves", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    const layer = JjRepository.target(queue, "5 millis")
    let woke = false
    const waiting = run(Effect.flatMap(Target, (target) => target.wait([])).pipe(Effect.provide(layer))).then(
      () => (woke = true)
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(woke).toBe(false)
    repo.jj("bookmark", "set", "main", "-r", repo.change("other.txt", "theirs\n"))
    await waiting
    expect(woke).toBe(true)
  })

  it("drives the queue on a real repository: changes land as fast-forwards, around someone else's commit", async () => {
    const config: Config = { required: [1], maxAttempts: 1, maxBatch: 4, maxRuns: 4, window: 3, defaultDuration: 1 }
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "one\n")))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("two.txt", "two\n")))
    const world = makeWorld(config)
    world.enqueue(1)
    world.enqueue(2)
    world.close()
    const layer = Layer.merge(world.layer, JjRepository.target(queue, "5 millis"))
    let position: Driver.Position = { state: empty, cursor: 0, closed: false }
    const heads = [repo.head()]
    for (let rounds = 0; rounds < 60; rounds++) {
      if (rounds === 1) repo.jj("bookmark", "set", "main", "-r", repo.change("other.txt", "theirs\n"))
      const outcome = await run(Driver.round(config, position).pipe(Effect.provide(layer)))
      position = outcome
      if (repo.head() !== heads.at(-1)) heads.push(repo.head())
      if (outcome.done) break
    }
    expect(position.state.changes.filter((change) => change.status._tag === "merged")).toHaveLength(3)
    expect(repo.files()).toEqual(["base.txt", "one.txt", "other.txt", "two.txt"])
    // Every position the bookmark held descends from the one before it: fast-forwards only.
    for (let index = 1; index < heads.length; index++) {
      expect(repo.jj("log", "--no-graph", "-r", `${heads[index - 1]} & ::${heads[index]}`, "-T", "commit_id").trim())
        .toBe(heads[index - 1])
    }
  })
})
