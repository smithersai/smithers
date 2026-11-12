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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  /** Commits a change to one file on top of `parent`, and returns its commit id. */
  const on = (parent: string, file: string, text: string): string => {
    jj("new", parent, "-m", `change ${file}`)
    writeFileSync(join(path, file), text)
    jj("new")
    return jj("log", "--no-graph", "-r", "@-", "-T", "commit_id").trim()
  }
  const head = (): string => jj("log", "--no-graph", "-r", "main", "-T", "commit_id").trim()
  const files = (): ReadonlyArray<string> => jj("file", "list", "-r", "main").trim().split("\n").sort()
  const options = { path, bookmark: "main", ledger: join(path, ".jj", "queue-ledger.json"), poll: "5 millis" } as const
  return { path, jj, change, on, head, files, options }
}

const tree = (...parts: ReadonlyArray<readonly [number, number]>): Tree => parts.map(([id, rev]) => ({ id, rev }))

// Real jj and real processes: a budget for a loaded host, still finite so a hang fails.
describe.skipIf(!jjInstalled)("the target as a jj bookmark", { timeout: 120_000 }, () => {
  it("starts with an empty tree: the queue's tree is what follows the bookmark it found", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    expect(await run(queue.tip)).toEqual([])
    expect(await run(queue.candidate([], 0))).toEqual({ _tag: "built", commit: repo.head() })
  })

  it("builds a candidate by replaying each change on the tip, and lands exactly that commit", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "one\n")))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("two.txt", "two\n")))
    const base = repo.head()
    const built = await run(queue.candidate(tree([1, 0], [2, 0]), 0))
    expect(built._tag).toBe("built")
    const commit = built._tag === "built" ? built.commit : ""
    expect(repo.jj("log", "--no-graph", "-r", `${base}..${commit}`, "-T", "commit_id ++ \"\\n\"").trim().split("\n"))
      .toHaveLength(2)
    expect(repo.head()).toBe(base)
    expect(await run(queue.candidate(tree([1, 0], [2, 0]), 0))).toEqual(built)
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
    const long = await run(queue.candidate(tree([1, 0], [2, 0]), 0))
    const short = await run(queue.candidate(tree([1, 0]), 0))
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
    await run(queue.candidate(tree([1, 0]), 0))
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
    await run(queue.candidate(tree([1, 0]), 0))
    repo.jj("bookmark", "set", "main", "-r", repo.change("other.txt", "theirs\n"))
    const foreign = JjRepository.firstForeign
    expect(await run(queue.tip)).toEqual(tree([foreign, 0]))
    expect(await run(queue.tip)).toEqual(tree([foreign, 0]))
    expect(await run(queue.candidate(tree([1, 0]), 0))).toEqual({ _tag: "stale" })
    const rebuilt = await run(queue.candidate(tree([foreign, 0], [1, 0]), 0))
    expect(rebuilt._tag).toBe("built")
    await run(queue.advance(tree([foreign, 0]), tree([foreign, 0], [1, 0])))
    expect(repo.files()).toEqual(["base.txt", "one.txt", "other.txt"])
  })

  it("names the part that does not apply on the parts before it", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("same.txt", "mine\n")))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("same.txt", "yours\n")))
    expect(await run(queue.candidate(tree([1, 0], [2, 0]), 0))).toEqual({ _tag: "conflict", part: { id: 2, rev: 0 } })
    const exit = await runExit(queue.advance([], tree([1, 0], [2, 0])))
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Unavailable")
  })

  it("a change may be a stack of commits: it is replayed whole, lands whole and reads back as one part", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    const base = repo.head()
    const first = repo.change("one.txt", "one\n")
    const second = repo.on(first, "two.txt", "two\n")
    await run(queue.register({ id: 1, rev: 0 }, `${first} | ${second}`))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("three.txt", "three\n")))
    const built = await run(queue.candidate(tree([1, 0]), 0))
    const commit = built._tag === "built" ? built.commit : ""
    expect(repo.jj("log", "--no-graph", "-r", `${base}..${commit}`, "-T", "description").trim().split("\n"))
      .toEqual(["change two.txt", "change one.txt"])
    await run(queue.advance([], tree([1, 0], [2, 0])))
    expect(await run(queue.tip)).toEqual(tree([1, 0], [2, 0]))
    expect(repo.files()).toEqual(["base.txt", "one.txt", "three.txt", "two.txt"])
    // A second opening of the same ledger reads the same tree: the stack's lower commit is not a stranger.
    expect(await run(Effect.flatMap(JjRepository.make(repo.options), (again) => again.tip)))
      .toEqual(tree([1, 0], [2, 0]))
  })

  it("a stack that forks has no last commit and cannot be applied", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    const left = repo.change("left.txt", "left\n")
    const right = repo.change("right.txt", "right\n")
    await run(queue.register({ id: 1, rev: 0 }, `${left} | ${right}`))
    expect(await run(queue.candidate(tree([1, 0]), 0))).toEqual({ _tag: "conflict", part: { id: 1, rev: 0 } })
    expect(
      repo.jj(
        "log",
        "--no-graph",
        "-r",
        "description(substring:'change') ~ ::main ~ (" + left + "|" + right + ")",
        "-T",
        "commit_id"
      )
    ).toBe("")
  })

  it("a finish command stands a commit of its own for the change, and that commit is what lands", async () => {
    const repo = repository()
    const jjArgs = "jj --ignore-working-copy --config user.name=queue --config user.email=queue@example.com"
    // Adds a "regenerated" commit on a clean change, and refuses a conflicted one.
    const script =
      `echo "$3" >> finish-calls.txt; [ "$3" = false ] || exit 1; ${jjArgs} new --no-edit "$1" -m regenerated >/dev/null 2>&1; `
      + `${jjArgs} log --no-graph -r 'heads('"$1"'::) & description(substring:"regenerated")' -T commit_id`
    const finish = (head: string, onto: string, conflicted: boolean) => ({
      command: "sh",
      args: ["-c", script, "sh", head, onto, String(conflicted)],
      cwd: repo.path
    })
    const queue = await run(JjRepository.make({ ...repo.options, finish }))
    const base = repo.head()
    await run(queue.register({ id: 1, rev: 0 }, repo.change("same.txt", "mine\n")))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("same.txt", "yours\n")))
    await run(queue.register({ id: 3, rev: 0 }, repo.change("three.txt", "three\n")))
    expect(await run(queue.candidate(tree([1, 0], [2, 0]), 0))).toEqual({ _tag: "conflict", part: { id: 2, rev: 0 } })
    // The refusal is remembered: the other runs that contain the change are answered without replaying it.
    expect(await run(queue.candidate(tree([1, 0], [2, 0]), 0))).toEqual({ _tag: "conflict", part: { id: 2, rev: 0 } })
    expect(await run(queue.candidate(tree([1, 0], [2, 0], [3, 0]), 0)))
      .toEqual({ _tag: "conflict", part: { id: 2, rev: 0 } })
    expect(readFileSync(join(repo.path, "finish-calls.txt"), "utf8").trim().split("\n")).toEqual(["false", "true"])
    await run(queue.advance([], tree([1, 0], [3, 0])))
    expect(repo.jj("log", "--no-graph", "-r", `${base}..main`, "-T", "description").trim().split("\n"))
      .toEqual(["regenerated", "change three.txt", "regenerated", "change same.txt"])
    expect(await run(queue.tip)).toEqual(tree([1, 0], [3, 0]))
  })

  it("is unavailable, blaming nobody, when the finish command gives no clean line on the tip or cannot run", async () => {
    const detail = (effect: Effect.Effect<unknown, Unavailable, any>): Promise<string> =>
      run(Effect.map(Effect.flip(effect), (error) => error.detail))
    const repo = repository()
    const base = repo.head()
    const one = repo.change("same.txt", "mine\n")
    const two = repo.change("same.txt", "yours\n")
    const answering = (script: string) => async (trees: Tree) => {
      const queue = await run(JjRepository.make({
        ...repo.options,
        ledger: join(repo.path, `ledger-${repositories++}.json`),
        finish: (head) => ({ command: "sh", args: ["-c", script, "sh", head, base] })
      }))
      await run(queue.register({ id: 1, rev: 0 }, one))
      await run(queue.register({ id: 2, rev: 0 }, two))
      return detail(queue.candidate(trees, 0))
    }
    expect(await answering("echo nonsense")(tree([1, 0]))).toContain("not a clean line")
    expect(await answering("true")(tree([1, 0]))).toContain("gave no commit")
    expect(await answering("echo $2")(tree([1, 0]))).toContain("not a clean line")
    // It says the conflicted change is fine as it is: the queue does not take its word.
    expect(await answering("echo $1")(tree([1, 0], [2, 0]))).toContain("not a clean line")
    const missing = await run(JjRepository.make({
      ...repo.options,
      ledger: join(repo.path, "ledger-missing.json"),
      finish: () => ({ command: join(repo.path, "no-such-program"), args: [] })
    }))
    await run(missing.register({ id: 1, rev: 0 }, one))
    expect(await detail(missing.candidate(tree([1, 0]), 0))).toContain("could not run")
    const elsewhere = await run(JjRepository.make({ ...repo.options, binary: join(repo.path, "no-such-jj") }))
    expect(await detail(elsewhere.tip)).toContain("could not run")
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
    expect(await detail(queue.candidate(tree([5, 0]), 0))).toContain("no commit registered for 5.0")
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
        return yield* Effect.map(Effect.flip(muted.candidate(tree([1, 0]), 0)), (error) => error.detail)
      }).pipe(Effect.provide(mute)) as Effect.Effect<string>
    )
    expect(unreadable).toContain("printed no new commit")
    // The wait goes on while the tip cannot be read, and ends once it can be and differs. The host fails its first
    // two spawns and then works, so nothing here depends on how long anything takes.
    let spawns = 0
    const recovering = Layer.provideMerge(
      Layer.effect(
        ChildProcessSpawner,
        Effect.map(ChildProcessSpawner, (real) =>
          ChildProcessSpawnerModule.make((command) =>
            spawns++ < 2
              ? Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }))
              : real.spawn(command)
          ))
      ),
      host
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const flaky = yield* JjRepository.make({ ...repo.options, ledger: join(root, "recovering.json") })
        yield* Effect.flatMap(Target, (target) => target.wait(tree([1, 0]))).pipe(
          Effect.provide(JjRepository.target(flaky, "5 millis"))
        )
      }).pipe(Effect.provide(recovering)) as Effect.Effect<void>
    )
    expect(spawns).toBeGreaterThan(2)
    const notRepository = await run(JjRepository.make({ ...repo.options, path: root, ledger: join(root, "m.json") }))
    expect(await detail(notRepository.tip)).toContain("exited")
  })

  it("the Target service waits until the bookmark moves", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    // Polled at a pace near real use: a jj process every 5 ms beside the test's own jj commands starved them on a
    // loaded host.
    const layer = JjRepository.target(queue, "200 millis")
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

  it("settles parts: the starting commit moves forward, trees are spoken of from there, and the ledger forgets", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    const ledger = (): typeof JjRepository.Ledger.Type => JSON.parse(readFileSync(repo.options.ledger, "utf8"))
    for (const id of [1, 2, 3, 4]) {
      await run(queue.register({ id, rev: 0 }, repo.change(`${id}.txt`, `${id}\n`)))
    }
    // A candidate the bookmark will pass by, and one that conflicts where it stands.
    await run(queue.register({ id: 9, rev: 0 }, repo.change("1.txt", "nine\n")))
    await run(queue.candidate(tree([4, 0]), 0))
    expect(await run(queue.candidate(tree([1, 0], [9, 0]), 0))).toEqual({ _tag: "conflict", part: { id: 9, rev: 0 } })
    await run(queue.advance([], tree([1, 0])))
    await run(queue.advance(tree([1, 0]), tree([1, 0], [2, 0])))
    const two = repo.head()
    // A run in flight on the whole tree, named before anything was settled.
    const inFlight = await run(queue.candidate(tree([1, 0], [2, 0], [3, 0]), 0))
    expect(inFlight._tag).toBe("built")
    // And a longer one, whose last change is applied on a commit that is not on the bookmark yet.
    const longer = await run(queue.candidate(tree([1, 0], [2, 0], [3, 0], [4, 0]), 0))
    const commitOf = (candidate: JjRepository.Candidate): string => candidate._tag === "built" ? candidate.commit : ""
    const before = ledger()
    expect(before).toMatchObject({ settled: 0 })
    expect(before.candidates).toHaveLength(5)
    expect(before.refused).toHaveLength(1)

    // Nothing to do, and too much to do.
    await run(queue.settle(0))
    expect(ledger()).toEqual(before)
    const past = await runExit(queue.settle(3))
    expect(Exit.isFailure(past) && String(past.cause)).toContain("Unavailable")
    expect(ledger()).toEqual(before)

    await run(queue.settle(2))
    const after = ledger()
    expect(after).toMatchObject({ genesis: two, settled: 2 })
    // What only the settled parts needed is gone: their sources and commits, the candidate on the
    // old start and the refusal on a commit now behind the start. The candidate in flight stays.
    expect(after.sources.map((entry) => entry.id).sort()).toEqual([3, 4, 9])
    expect(after.candidates).toEqual([
      { onto: two, id: 3, rev: 0, commit: commitOf(inFlight) },
      { onto: commitOf(inFlight), id: 4, rev: 0, commit: commitOf(longer) }
    ])
    expect(after.refused).toEqual([])
    expect(after.pinned.map((entry) => entry.id)).toEqual([3, 4])
    // Settling again, as a round that runs twice does, changes nothing.
    await run(queue.settle(2))
    await run(queue.settle(1))
    expect(ledger()).toEqual(after)
    // So does a host that starts over the same ledger and is told the count it already holds.
    const restarted = await run(JjRepository.make(repo.options))
    await run(restarted.settle(2))
    await run(restarted.settle(2))
    expect(ledger()).toEqual(after)

    // Trees are spoken of from the new start.
    expect(await run(queue.tip)).toEqual([])
    // The run in flight was named with nothing settled: its first two parts are dropped, and it is the same commit.
    expect(await run(queue.candidate(tree([1, 0], [2, 0], [3, 0]), 0))).toEqual(inFlight)
    expect(await run(queue.candidate(tree([3, 0]), 2))).toEqual(inFlight)
    expect(await run(queue.candidate(tree([1, 0], [2, 0], [3, 0], [4, 0]), 0))).toEqual(longer)
    // A tree named for a later start than the ledger's cannot be read.
    expect(await run(queue.candidate(tree([3, 0]), 3))).toEqual({ _tag: "stale" })
    // It lands as the commit that was tested, and a foreign commit after it is numbered on from the counter.
    await run(queue.advance([], tree([3, 0])))
    expect(repo.head()).toBe(commitOf(inFlight))
    repo.jj("bookmark", "set", "main", "-r", repo.on("main", "theirs.txt", "theirs\n"))
    expect(await run(queue.tip)).toEqual(tree([3, 0], [JjRepository.firstForeign, 0]))
    await run(queue.settle(4))
    expect(await run(queue.tip)).toEqual([])
    expect(ledger()).toMatchObject({ genesis: repo.head(), settled: 4, candidates: [], pinned: [], interior: [] })
    expect(await run(queue.candidate(tree([4, 0]), 4))).toMatchObject({ _tag: "built" })
    await run(queue.advance([], tree([4, 0])))
    expect(repo.files()).toEqual(["1.txt", "2.txt", "3.txt", "4.txt", "base.txt", "theirs.txt"])
  })

  it("is unavailable, and says why, when the bookmark no longer descends from the starting commit", async () => {
    const detail = (effect: Effect.Effect<unknown, Unavailable, any>): Promise<string> =>
      run(Effect.map(Effect.flip(effect), (error) => error.detail))
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    await run(queue.register({ id: 1, rev: 0 }, repo.change("one.txt", "one\n")))
    await run(queue.advance([], tree([1, 0])))
    await run(queue.settle(1))
    expect(await run(queue.tip)).toEqual([])
    // History is rewritten: the bookmark goes back to the base, behind the commit the queue settled.
    repo.jj("bookmark", "set", "main", "-r", "root()+", "--allow-backwards")
    for (const effect of [queue.tip, queue.settle(2), queue.candidate([], 1), queue.advance([], tree([1, 0]))]) {
      expect(await detail(effect)).toContain("no longer descends from the queue's starting commit")
    }
    // A commit on a line that never held the starting commit is no better.
    repo.jj("bookmark", "set", "main", "-r", repo.on("root()+", "elsewhere.txt", "elsewhere\n"), "--allow-backwards")
    expect(await detail(queue.tip)).toContain("its history was rewritten")
  })

  it("settles a stack with the commits below its last one", async () => {
    const repo = repository()
    const queue = await run(JjRepository.make(repo.options))
    const first = repo.change("a.txt", "a\n")
    const second = repo.on(first, "b.txt", "b\n")
    await run(queue.register({ id: 1, rev: 0 }, `${first} | ${second}`))
    await run(queue.register({ id: 2, rev: 0 }, repo.change("c.txt", "c\n")))
    await run(queue.advance([], tree([1, 0])))
    const ledger = (): typeof JjRepository.Ledger.Type => JSON.parse(readFileSync(repo.options.ledger, "utf8"))
    expect(ledger().interior).toHaveLength(1)
    expect(await run(queue.tip)).toEqual(tree([1, 0]))
    await run(queue.settle(1))
    expect(ledger()).toMatchObject({ genesis: repo.head(), settled: 1, interior: [] })
    expect(await run(queue.tip)).toEqual([])
    await run(queue.advance([], tree([2, 0])))
    expect(repo.files()).toEqual(["a.txt", "b.txt", "base.txt", "c.txt"])
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
    let position: Driver.Position = { state: empty, cursor: 0, closed: false, ended: [], settled: 0 }
    const heads = [repo.head()]
    for (let rounds = 0; rounds < 60; rounds++) {
      if (rounds === 1) repo.jj("bookmark", "set", "main", "-r", repo.change("other.txt", "theirs\n"))
      const outcome = await run(Driver.round(config, position).pipe(Effect.provide(layer)))
      position = outcome
      if (repo.head() !== heads.at(-1)) heads.push(repo.head())
      if (outcome.done) break
    }
    expect(world.endings.filter((ending) => ending.status._tag === "merged")).toHaveLength(3)
    expect(world.endings.filter((ending) => ending.landing?.foreign)).toHaveLength(1)
    expect(repo.files()).toEqual(["base.txt", "one.txt", "other.txt", "two.txt"])
    // Every position the bookmark held descends from the one before it: fast-forwards only.
    for (let index = 1; index < heads.length; index++) {
      expect(repo.jj("log", "--no-graph", "-r", `${heads[index - 1]} & ::${heads[index]}`, "-T", "commit_id").trim())
        .toBe(heads[index - 1])
    }
  })
})
