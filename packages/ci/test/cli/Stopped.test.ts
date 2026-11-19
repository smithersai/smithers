/**
 * The program always ends with one of its own exit codes and a line.
 *
 * Work that stops before `main` has an answer ends with `failed`, one line
 * on standard error that says where it was, and its directory removed: a
 * service that never answers, an error no part answers for, an error thrown
 * where nothing catches it. Each is shown inside this process, over a real
 * emitter in the place of `process`, and as a real child process, where Node
 * itself says that nothing is left to wait for.
 */
import { EventEmitter } from "node:events"
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { main, run } from "../../src/cli/main.vibe"
import { exitCodes as signalExitCodes, idle, listenTo, uncaught } from "../../src/cli/Signals.ts"
import { stageOf } from "../../src/cli/Stage.ts"
import { exitCodes } from "../../src/contract/Command.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import {
  awaited,
  bin,
  changed,
  commit,
  git,
  remove,
  repository,
  snapshot,
  spawn,
  spawnWith,
  temporary,
  until
} from "./repo.ts"
import { type How, stoppedAt, stoppingParts } from "./stopped.vibe"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const environment = { HOME: keep(temporary("stopped-home")), PATH: process.env["PATH"] }
const repo = (): string => keep(repository())
const replay = ["replay", "--commits", "1", "--no-apply-check"]

/** The program in this process, with a replay that stops as `how` says, heard through a real emitter. */
const started = (how: How) => {
  const source = new EventEmitter()
  const marker = join(keep(temporary("stopped")), "marker.json")
  const running = run(replay, repo(), environment, stoppingParts(marker, how), listenTo(source))
  const directory = async (): Promise<string> => (JSON.parse(await awaited(marker)) as { directory: string }).directory
  const listeners = (): number =>
    [idle, ...uncaught, "SIGINT", "SIGTERM"].reduce((sum, event) => sum + source.listenerCount(event), 0)
  return { source, running, directory, listeners }
}

describe("a program whose work stops before it has an answer, in this process", () => {
  it("ends with `failed` and its directory removed when nothing is left that could answer", async () => {
    const { source, running, directory, listeners } = started("waits")
    const kept = await directory()
    expect(existsSync(kept)).toBe(true)
    source.emit(idle)
    expect(await running).toBe(exitCodes.failed)
    expect(existsSync(kept)).toBe(false)
    expect(listeners()).toBe(0)
  })

  it("ends the same way when the work cannot be interrupted, and removes the directory itself", async () => {
    const { source, running, directory, listeners } = started("waits uninterruptibly")
    const kept = await directory()
    // What a replay's directory holds at its worst: a directory a step left that nothing can be removed from, and
    // the clone of the repository, whose files are links to the repository's own.
    mkdirSync(join(kept, "home", "go", "pkg", "mod"), { recursive: true })
    chmodSync(join(kept, "home", "go"), 0o555)
    const owned = join(keep(temporary("stopped-repository")), "object")
    writeFileSync(owned, "the repository's own\n", { mode: 0o444 })
    mkdirSync(join(kept, "source"))
    linkSync(owned, join(kept, "source", "object"))
    source.emit(idle)
    // The work is asked to end and does not; the program hears again that nothing is left to wait for.
    await until(() => source.listenerCount(idle) === 1, "the program to wait for its work to end")
    expect(existsSync(kept)).toBe(true)
    source.emit(idle)
    expect(await running).toBe(exitCodes.failed)
    expect(existsSync(kept)).toBe(false)
    // The file the clone shared with the repository is as it was: not one bit of its mode changed.
    expect(statSync(owned).mode & 0o777).toBe(0o444)
    expect(listeners()).toBe(0)
  })

  it("ends with `failed` when a part dies of an error it does not answer for", async () => {
    const { running, directory, listeners } = started("dies")
    const kept = await directory()
    expect(await running).toBe(exitCodes.failed)
    expect(existsSync(kept)).toBe(false)
    expect(listeners()).toBe(0)
  })

  for (const event of uncaught) {
    it(`ends with \`failed\` and its directory removed on an ${event}`, async () => {
      const { source, running, directory, listeners } = started("waits")
      const kept = await directory()
      source.emit(event, new Error("thrown where nothing catches it"))
      expect(await running).toBe(exitCodes.failed)
      expect(existsSync(kept)).toBe(false)
      expect(listeners()).toBe(0)
    })
  }

  it("ends with the signal's exit code when a signal's work cannot be interrupted either", async () => {
    const { source, running, directory, listeners } = started("waits uninterruptibly")
    const kept = await directory()
    source.emit("SIGTERM")
    await until(() => source.listenerCount(idle) === 1, "the program to wait for its work to end")
    source.emit(idle)
    expect(await running).toBe(signalExitCodes.SIGTERM)
    expect(existsSync(kept)).toBe(false)
    expect(listeners()).toBe(0)
  })

  it("leaves a program that ends by itself with its own exit code, over the parts on main", async () => {
    const source = new EventEmitter()
    expect(await main(["inventory"], repo(), environment, listenTo(source))).toBe(exitCodes.ok)
    expect(source.eventNames()).toEqual([])
  })
})

const entry = new URL("./stopped.mjs", import.meta.url).pathname

/** The program as a child process, with a replay that stops as `how` says. */
const child = async (how: How) => {
  const marker = join(keep(temporary("stopped")), "marker.json")
  const outcome = await spawn(entry, [how, marker, ...replay], repo())
  const { directory } = JSON.parse(await awaited(marker)) as { directory: string }
  return { outcome, directory, last: outcome.stderr.trim().split("\n").at(-1) }
}

describe("a program whose work stops before it has an answer, as a process", () => {
  it("says so and exits `failed` when a service never answers before any replay", async () => {
    const outcome = await spawn(entry, ["reads", "justfile", "inventory"], repo())
    expect(outcome).toEqual({
      code: exitCodes.failed,
      stdout: "",
      stderr: "smithers-ci: stopped without an answer\n"
    })
  })

  it("names the stage and the commit, exits `failed` and removes the replay's directory", async () => {
    const { outcome, directory, last } = await child("waits")
    expect(outcome.code, outcome.stderr).toBe(exitCodes.failed)
    expect(outcome.stdout).toBe("")
    expect(last).toBe(`smithers-ci: replay: stopped without an answer while running the baseline at ${stoppedAt}`)
    expect(existsSync(directory)).toBe(false)
  })

  it("does the same when the work that waits cannot be interrupted", async () => {
    const { outcome, directory, last } = await child("waits uninterruptibly")
    expect(outcome.code, outcome.stderr).toBe(exitCodes.failed)
    expect(outcome.stdout).toBe("")
    expect(last).toBe(`smithers-ci: replay: stopped without an answer while running the baseline at ${stoppedAt}`)
    expect(existsSync(directory)).toBe(false)
  })

  it("gives an error no part answers for in one line, with no password, and exits `failed`", async () => {
    const { outcome, directory, last } = await child("dies")
    expect(outcome.code, outcome.stderr).toBe(exitCodes.failed)
    expect(outcome.stdout).toBe("")
    expect(last).toBe(
      `smithers-ci: replay: stopped on an error of its own while running the baseline at ${stoppedAt}: `
        + "the store at https://cache.example.invalid/ac refused"
    )
    expect(outcome.stderr).not.toContain("hunter2")
    expect(existsSync(directory)).toBe(false)
  })

  it("gives an error thrown where nothing catches it the same way", async () => {
    const { outcome, directory, last } = await child("throws elsewhere")
    expect(outcome.code, outcome.stderr).toBe(exitCodes.failed)
    expect(outcome.stdout).toBe("")
    expect(last).toBe(
      `smithers-ci: replay: stopped on an error of its own while running the baseline at ${stoppedAt}: a listener threw`
    )
    expect(existsSync(directory)).toBe(false)
  })

  it("says why and exits `failed` when an install lacks the files the program runs", async () => {
    const install = keep(temporary("stopped-install"))
    mkdirSync(join(install, "bin"))
    copyFileSync(bin, join(install, "bin", "smithers-ci.mjs"))
    const outcome = await spawn(join(install, "bin", "smithers-ci.mjs"), ["inventory"], repo())
    expect(outcome.code, outcome.stderr).toBe(exitCodes.failed)
    expect(outcome.stdout).toBe("")
    expect(outcome.stderr).toMatch(/^smithers-ci: could not run: Cannot find module .*Restart\.js.*\n$/)
  })
})

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: test -f docs/readme.md",
  ""
].join("\n")

describe("a build that leaves a directory nothing can be removed from where it keeps its machines", () => {
  it("is replayed to a report, and the replay's own directory is removed", async () => {
    const root = keep(temporary("left-behind"))
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, "docs/readme.md": "# Fixture\n" })
    commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
    // The replay's directory is made in the temporary directory the program is given: this one holds no other.
    const temp = keep(temporary("left-behind-tmp"))
    const before = snapshot(root)
    const outcome = await spawnWith(entry, ["leaves", "", "--commits", "1", "--json"], root, { TMPDIR: temp })
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    // Making the replay's directory removable changed nothing of the repository, whose objects its clone links to.
    expect(changed(before, snapshot(root))).toEqual([])
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits).toHaveLength(1)
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    const normal = report.commits[0]?.normal.counts
    expect([(normal?.hit ?? 0) + (normal?.ran ?? 0), normal?.failed, normal?.skipped]).toEqual([1, 0, 0])
    expect(report.mismatches).toBe(0)
    expect(readdirSync(temp).filter((name) => name.startsWith("smithers-ci-"))).toEqual([])
    // Each run the replay announced is a stage the program can name when its work stops.
    const announced = outcome.stderr.split("\n").flatMap((line) =>
      /^smithers-ci: ((?:first run|1\/1) .*)$/.exec(line)?.[1] ?? []
    )
    expect(announced.map((line) => line.replace(/ [0-9a-f]{7} /, " ")).sort()).toEqual([
      "1/1 baseline",
      "1/1 normal",
      "1/1 with the files apply writes",
      "first run baseline",
      "first run normal"
    ])
    expect(announced.map(stageOf).filter((stage) => stage === undefined)).toEqual([])
  }, 540_000)
})
