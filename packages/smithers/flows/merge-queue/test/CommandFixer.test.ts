import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Config, FixBrief } from "../src/index.ts"
import { CommandCi, CommandFixer, Driver, empty, FileEndings, FileInbox, Fixer, JjRepository } from "../src/index.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const root = mkdtempSync(join(tmpdir(), "merge-queue-fixer-"))
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, any>> = []
afterAll(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  rmSync(root, { recursive: true, force: true })
})

const host = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, NodePath.layer))

let repositories = 0

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A real repository, and fix agents that run `script` as `sh -c script sh <brief> <answer>`. */
const setup = async (script: string, directory?: string) => {
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
  const briefs = directory ?? join(path, ".jj", "fixes")
  if (directory === undefined) mkdirSync(briefs)
  const base = ManagedRuntime.make(host)
  runtimes.push(base)
  const repository = await base.runPromise(
    JjRepository.make({ path, bookmark: "main", ledger: join(path, ".jj", "queue-ledger.json"), poll: "5 millis" })
  )
  const layer = Layer.provideMerge(
    CommandFixer.layer({
      repository,
      directory: briefs,
      command: (brief, answer) => ({ command: "sh", args: ["-c", script, "sh", brief, answer], cwd: path }),
      poll: "5 millis"
    }),
    host
  )
  const runtime = ManagedRuntime.make(layer)
  runtimes.push(runtime)
  const fixer = <A>(use: (fixer: Fixer["Service"]) => Effect.Effect<A, any>): Promise<A> =>
    runtime.runPromise(Effect.flatMap(Fixer, use))
  const fixerExit = <A>(use: (fixer: Fixer["Service"]) => Effect.Effect<A, any>) =>
    runtime.runPromiseExit(Effect.flatMap(Fixer, use))
  return { path, jj, change, briefs, repository, base, fixer, fixerExit }
}

const brief = (id: number, failures: ReadonlyArray<number> = [1]): FixBrief => ({
  id,
  rev: 0,
  attempt: 1,
  failures,
  ahead: []
})

const answerWith = (json: string): string => `printf '%s' '${json}' > "$2"`

// Real jj and real processes: a budget for a loaded host, still finite so a hang fails.
describe.skipIf(!jjInstalled)("fix agents as commands", { timeout: 120_000 }, () => {
  it("a fixed answer registers the new revision's commit before the queue hears of it", async () => {
    const world = await setup("cat \"$1.commit\" > \"$2\"")
    await world.base.runPromise(world.repository.register({ id: 1, rev: 0 }, world.change({ "one.txt": "broken\n" })))
    const fix = world.change({ "one.txt": "fixed\n" })
    writeFileSync(join(world.briefs, "1-1.brief.json.commit"), JSON.stringify({ _tag: "fixed", commit: fix }))
    await world.fixer((fixer) => fixer.reconcile([brief(1)]))
    await world.fixer((fixer) => fixer.wait([{ id: 1, attempt: 1 }]))
    expect(await world.fixer((fixer) => fixer.answer(1, 1))).toEqual({ _tag: "fixed" })
    expect(await world.fixer((fixer) => fixer.answer(1, 1))).toEqual({ _tag: "fixed" })
    expect(JSON.parse(readFileSync(join(world.briefs, "1-1.brief.json"), "utf8"))).toEqual(brief(1))
    const built = await world.base.runPromise(world.repository.candidate([{ id: 1, rev: 1 }]))
    expect(built._tag).toBe("built")
    await world.base.runPromise(world.repository.advance([], [{ id: 1, rev: 1 }]))
    expect(world.jj("file", "show", "-r", "main", "one.txt")).toBe("fixed\n")
  })

  it("passes on the agent's written verdict", async () => {
    const world = await setup(answerWith("{\"_tag\":\"gaveUp\",\"detail\":\"redo it on the new parser\"}"))
    await world.fixer((fixer) => fixer.reconcile([brief(2)]))
    await world.fixer((fixer) => fixer.wait([{ id: 2, attempt: 1 }]))
    expect(await world.fixer((fixer) => fixer.answer(2, 1))).toEqual({
      _tag: "gaveUp",
      detail: "redo it on the new parser"
    })
    expect(await world.fixer((fixer) => fixer.answer(9, 1))).toBeUndefined()
  })

  it("never invents an answer: an agent that exits without one, or writes something else, is started again", async () => {
    const world = await setup(
      "n=$(cat \"$1.runs\" 2>/dev/null || echo 0); n=$((n+1)); echo $n > \"$1.runs\"; "
        + "if [ $n -eq 1 ]; then exit 1; fi; if [ $n -eq 2 ]; then echo nonsense > \"$2\"; exit 0; fi; "
        + answerWith("{\"_tag\":\"gaveUp\",\"detail\":\"third time\"}")
    )
    const runs = () => Number(readFileSync(join(world.briefs, "3-1.brief.json.runs"), "utf8"))
    for (
      let round = 0;
      round < 200 && !(existsSync(join(world.briefs, "3-1.brief.json.runs")) && runs() >= 3);
      round++
    ) {
      await world.fixer((fixer) => fixer.reconcile([brief(3)]))
      expect((await world.fixer((fixer) => fixer.answer(3, 1)))?._tag).not.toBe("fixed")
      await tick(10)
    }
    await world.fixer((fixer) => fixer.wait([{ id: 3, attempt: 1 }]))
    expect(await world.fixer((fixer) => fixer.answer(3, 1))).toEqual({ _tag: "gaveUp", detail: "third time" })
    expect(runs()).toBe(3)
    await world.fixer((fixer) => fixer.reconcile([brief(3)]))
    await tick()
    expect(runs()).toBe(3)
  })

  it("rewrites the brief when more failures stream in, without restarting the agent", async () => {
    const world = await setup("echo started >> \"$1.runs\"; sleep 5")
    await world.fixer((fixer) => fixer.reconcile([brief(4, [1])]))
    await world.fixer((fixer) => fixer.reconcile([brief(4, [1])]))
    await world.fixer((fixer) => fixer.reconcile([brief(4, [1, 2])]))
    await tick(200)
    expect(JSON.parse(readFileSync(join(world.briefs, "4-1.brief.json"), "utf8")).failures).toEqual([1, 2])
    expect(readFileSync(join(world.briefs, "4-1.brief.json.runs"), "utf8")).toBe("started\n")
  })

  it("stops an agent whose change no longer needs fixing", async () => {
    const world = await setup("sleep 0.3; " + answerWith("{\"_tag\":\"gaveUp\",\"detail\":\"late\"}"))
    await world.fixer((fixer) => fixer.reconcile([brief(5)]))
    await tick(50)
    await world.fixer((fixer) => fixer.reconcile([]))
    await tick(500)
    expect(existsSync(join(world.briefs, "5-1.answer.json"))).toBe(false)
  })

  it("is unavailable when its files cannot be written or read, and forgets an agent that cannot start", async () => {
    const missing = await setup("true", join(root, "no-such-directory"))
    expect(Exit.isFailure(await missing.fixerExit((fixer) => fixer.reconcile([brief(6)])))).toBe(true)
    const world = await setup("true")
    mkdirSync(join(world.briefs, "7-1.answer.json"))
    expect(Exit.isFailure(await world.fixerExit((fixer) => fixer.answer(7, 1)))).toBe(true)
    const stuck = await world.fixerExit((fixer) =>
      fixer.wait([{ id: 7, attempt: 1 }]).pipe(Effect.timeout("60 millis"))
    )
    expect(Exit.isFailure(stuck)).toBe(true)
  })

  it("end to end with nothing fake: file inbox, jj target, command CI, command fix agent", async () => {
    const config: Config = { required: [1, 2], maxAttempts: 2, maxBatch: 4, maxRuns: 4, window: 3, defaultDuration: 1 }
    const world = await setup("cat \"$1.commit\" > \"$2\"")
    const has = (commit: string, file: string) =>
      `(cd '${world.path}' && jj --ignore-working-copy file list -r ${commit} 2>/dev/null | grep -qx ${file})`
    const register = (id: number, rev: number, commit: string) =>
      world.base.runPromise(world.repository.register({ id, rev }, commit))
    await register(1, 0, world.change({ "one.txt": "one\n" }))
    await register(2, 0, world.change({ "two.txt": "two\n", "fail-2.txt": "broken\n" }))
    await register(3, 0, world.change({ "three.txt": "three\n" }))
    writeFileSync(
      join(world.briefs, "2-1.brief.json.commit"),
      JSON.stringify({ _tag: "fixed", commit: world.change({ "two.txt": "two\n" }) })
    )
    const inbox = join(world.path, ".jj", "inbox.jsonl")
    const endings = join(world.path, ".jj", "endings.jsonl")
    writeFileSync(
      inbox,
      [1, 2, 3].map((id) => JSON.stringify({ _tag: "enqueue", id, priority: 0 })).join("\n") +
        "\n{\"_tag\":\"close\"}\n"
    )
    const layer = Layer.provideMerge(
      Layer.mergeAll(
        FileInbox.layer({ path: inbox, poll: "5 millis" }),
        FileEndings.layer({ path: endings }),
        JjRepository.target(world.repository, "5 millis"),
        CommandCi.layer({
          repository: world.repository,
          command: (check, commit) => ({ command: "sh", args: ["-c", `! ${has(commit, `fail-${check}.txt`)}`] }),
          poll: "5 millis"
        }),
        CommandFixer.layer({
          repository: world.repository,
          directory: world.briefs,
          command: (briefFile, answer) => ({
            command: "sh",
            args: ["-c", "cat \"$1.commit\" > \"$2\"", "sh", briefFile, answer]
          }),
          poll: "5 millis"
        })
      ),
      host
    )
    const runtime = ManagedRuntime.make(layer)
    runtimes.push(runtime)
    let position: Driver.Position = { state: empty, cursor: 0, closed: false, ended: [] }
    for (let rounds = 0; rounds < 300; rounds++) {
      const outcome = await runtime.runPromise(Driver.round(config, position))
      position = outcome
      if (outcome.done) break
    }
    expect(Object.fromEntries(position.state.changes.map((change) => [change.id, change.status._tag])))
      .toEqual({ 1: "merged", 2: "merged", 3: "merged" })
    expect(position.state.changes[1]).toMatchObject({ rev: 1, attempts: 1 })
    expect(world.jj("file", "list", "-r", "main").trim().split("\n").sort())
      .toEqual(["base.txt", "one.txt", "three.txt", "two.txt"])
    expect(JSON.parse(readFileSync(join(world.briefs, "2-1.brief.json"), "utf8"))).toMatchObject({
      id: 2,
      failures: [2]
    })
    const recorded = readFileSync(endings, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(recorded.map((line) => [line.id, line.rev, line.attempts, line.status._tag, line.landing.foreign]).sort())
      .toEqual([[1, 0, 0, "merged", false], [2, 1, 1, "merged", false], [3, 0, 0, "merged", false]])
    expect(recorded.every((line) => Number.isInteger(line.at) && line.at > 1_700_000_000_000)).toBe(true)
  }, 120_000)
})
